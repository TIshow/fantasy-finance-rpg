// 毎日の実行の本体（#30）。DB の保管（PgEventStore・PgValueStore）に対して、runner の runDay を1日分進める。
// 手順そのもの（判断 → 締め切り → 板寄せ → 約定 → 評価）は src/runner/ の runDay が持つ。ここは、保管を開き、
// 準備（市場・参加者の登録）を済ませ、runDay を呼ぶだけ。同じ日を何度回しても、runDay が済んだ段を飛ばすので二重に書かない。
// 実行のたびに DB から作り直すので、プロセスが落ちたあとの回し直しも同じ形になる。
import type { Clock, MarketDataPort } from "../src/contracts";
import { verifyChain } from "../src/events/chain";
import { LLM_DAILY_COST_LIMIT } from "../src/events/llm-cost";
import { replay } from "../src/events/replay";
import type { LogEvent } from "../src/events/types";
import { holidayTable as bundledHolidays, holidaysFor, type HolidayTable } from "../src/holidays";
import { IngestedMarketData } from "../src/ingest/market-data";
import { cutoffOf, isBusinessDay, isValidDate, nextBusinessDay } from "../src/ledger/ledger";
import { INITIAL_CASH } from "../src/ledger/types";
import { anthropicBatchPort } from "../src/llm/anthropic-port";
import { type BatchPortOptions, YEN_PER_USD } from "../src/llm/batch-port";
import { GEMINI_PROVIDER } from "../src/llm/gemini-batch";
import { geminiBatchPort } from "../src/llm/gemini-port";
import { openaiBatchPort } from "../src/llm/openai-port";
import { type RunnerAgent, type RunnerDeps, type StageResult, runDay } from "../src/runner/day";
import { LLM_INVESTORS, type LlmInvestor } from "../src/runner/llm-agents";
import type { LlmDeps } from "../src/runner/llm-stage";
import { ruleAgents } from "../src/runner/rule-agents";
import { discloseDue } from "../src/runner/world/disclosure";
import { listCompanies } from "../src/runner/world/listing";
import { liquidityAgents, setUpParticipants } from "../src/runner/world/participants";
import { PgEventStore, readAllEvents } from "../src/store/pg-store";
import { PgValueStore } from "../src/store/pg-values";
import type { SqlDb, SqlRunner } from "../src/store/sql";
import type { EventStore, LlmBatchPort } from "../src/contracts";

/** 架空の世界の乱数の種。変えると、上場の価格とばらばらの参加者の注文が変わるので、動かし始めたら変えない */
export const WORLD_SEED = 20261106;
/** 毎日の実行を1つだけ動かす鍵の番号（ほかの鍵は pg-store.ts の 25_000_001） */
export const RUN_LOCK_KEY = 25_000_002;

const JST = 9 * 3_600_000;
export const jstDate = (ms: number) => new Date(ms + JST).toISOString().slice(0, 10);

/** 準備に渡すもの */
export interface PrepareContext {
  store: EventStore;
  clock: Clock;
  seed: number;
  holidayTable: HolidayTable;
  /** 登録する LLM の AI 投資家（LLM を使う設定のときだけ。#179） */
  llmInvestors?: readonly LlmInvestor[];
}

export interface DailyOptions {
  db: SqlDb;
  /** 時計の権威（本番は実時刻） */
  clock: Clock;
  seed?: number;
  holidayTable?: HolidayTable;
  /** 外部の市場データ。架空の市場だけなら空のままでよい */
  market?: MarketDataPort;
  /** at まで待つ。既定は待たない（段が時刻前なら「待ち」を返し、あとの実行が進める。GitHub Actions はこの形） */
  waitUntil?: (at: number) => Promise<void>;
  /** true なら、アプリの接続が追記だけの権限であることを確かめて、違えば止める。本番は true */
  requireAppendOnlyRole?: boolean;
  /** 準備：運営者の記録（祝日・上場・参加者の登録）を、済んでいなければ書き、runner に渡す参加者を返す */
  prepare?: (ctx: PrepareContext) => Promise<RunnerAgent[]>;
  /** LLM の AI 投資家の設定（llmDepsFromEnv）。なければ LLM を呼ばず、LLM の AI も登録しない */
  llm?: LlmDeps;
}

/**
 * LLM の AI 投資家の設定を、環境変数から読む（#179。GitHub Actions では、リポジトリの変数とシークレットから渡す）。
 * - LLM_ENABLED：「true」のときだけ使う。ほかは undefined（LLM を呼ばない）
 * - LLM_DRY_RUN：「false」のときだけ注文を出す。書き忘れたら試運転（投稿だけ）
 * - API キー（ANTHROPIC_API_KEY・OPENAI_API_KEY・GEMINI_API_KEY）は、各社の口が最初に使うときに読む。ここでは読まない
 * 1日の上限は記録の上限（LLM_DAILY_COST_LIMIT、100円）、1ドルあたりの円は160（owner の決定。2026-11-07）
 */
export function llmDepsFromEnv(env: Readonly<Record<string, string | undefined>>, clock: Clock): LlmDeps | undefined {
  if (env.LLM_ENABLED !== "true") return undefined;
  const policy = { dailyCostLimit: LLM_DAILY_COST_LIMIT, dryRun: env.LLM_DRY_RUN !== "false" };
  const factories: Record<string, (o: BatchPortOptions) => LlmBatchPort> = {
    anthropic: (o) => anthropicBatchPort(o),
    openai: (o) => openaiBatchPort(o),
    [GEMINI_PROVIDER]: (o) => geminiBatchPort(o),
  };
  const ports = new Map<string, LlmBatchPort>();
  return {
    investors: LLM_INVESTORS,
    policy,
    yenPerUsd: YEN_PER_USD,
    portOf(provider, c) {
      const make = Object.hasOwn(factories, provider) ? factories[provider]! : undefined;
      if (!make) throw new RangeError(`unknown provider ${provider}`);
      if (c) return make({ policy, clock: c, yenPerUsd: YEN_PER_USD });
      if (!ports.has(provider)) ports.set(provider, make({ policy, clock, yenPerUsd: YEN_PER_USD }));
      return ports.get(provider)!;
    },
  };
}

const read = async (store: EventStore) => {
  const out: LogEvent[] = [];
  for (let page = await store.read(); page.length > 0; page = await store.read(out.at(-1)!.seq)) out.push(...page);
  return out;
};

const must = async (what: string, r: Promise<{ ok: boolean; reason?: string }>) => {
  const x = await r;
  if (!x.ok) throw new Error(`${what}: ${x.reason}`);
};

/** いまから締めがまだ来ていない最初の営業日（新しい参加者の開始日） */
export function firstOpenDay(now: number, table: HolidayTable): string {
  const today = jstDate(now);
  const days = holidaysFor(today, jstDate(now + 30 * 86_400_000), table);
  for (let d = today; ; d = nextBusinessDay(d, days)) if (isBusinessDay(d, days) && now < cutoffOf(d)) return d;
}

/**
 * 本番の準備（何度呼んでも二重に書かない）：祝日の一覧の採用 → 架空の企業の上場と取引対象 → AI投資家と売買役の登録と最初の配分。
 * 返す参加者は、runner に渡すAI投資家（規則）と売買役
 */
export async function productionSetup({ store, clock, seed, holidayTable, llmInvestors = [] }: PrepareContext): Promise<RunnerAgent[]> {
  const events = await read(store);
  if (!events.some((e) => e.type === "holidays.adopted")) {
    await must("holidays.adopted", store.append({ type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: holidayTable.contentSha256 } }));
  }
  await listCompanies(store, seed);
  // 決算の発表：上場の直後の四半期と、前の実行が引けのあとに書けなかった分（時期が来ていて、まだ書いていないもの）
  await discloseDue(store, seed, clock);
  const startDate = firstOpenDay(clock.now(), holidayTable);
  await setUpParticipants(store, startDate);
  const investors = await ruleAgents();
  const registered = new Set((await read(store)).filter((e) => e.type === "agent.registered").map((e) => (e.payload as { agentId: string }).agentId));
  // LLM の AI 投資家も、規則の AI と同じ形で登録する（判断は runner の LLM の段が行うので、返す参加者には入れない）
  for (const a of [...investors, ...llmInvestors]) {
    if (registered.has(a.id)) continue;
    await must(`agent.registered ${a.id}`, store.append({ type: "agent.registered", actor: "operator:owner", refs: [], payload: { agentId: a.id, displayName: a.id, startDate, initialCash: INITIAL_CASH } }));
  }
  return [...investors, ...(await liquidityAgents(seed))];
}

/**
 * date（取引日）の分を、済んでいない段から進める。段ごとの結果を返す。DB・保管の異常は例外。
 * 処理の全体を通して DB の鍵を持ち、同時に2つ動かない（動いていれば例外）。準備や判断は、読んでから書く形なので、
 * 2つ同時に動くと同じ記録が二重に書かれうる。
 * 前提：市場は架空の市場だけ（外部の市場データの口は空）。取引対象に外部の銘柄が残ると、その銘柄の取り込みで止まる
 */
export async function runDaily(date: string, o: DailyOptions): Promise<StageResult[]> {
  if (!isValidDate(date)) throw new RangeError("date must be a valid YYYY-MM-DD");
  const unlock = await o.db.lock(RUN_LOCK_KEY);
  if (!unlock) throw new Error("another daily run is in progress");
  try {
    return await runLocked(date, o);
  } finally {
    await unlock();
  }
}

async function runLocked(date: string, o: DailyOptions): Promise<StageResult[]> {
  const holidayTable = o.holidayTable ?? bundledHolidays;
  const holidayTables = new Map([[holidayTable.contentSha256, holidayTable]]);
  const values = await PgValueStore.open(o.db);
  const store = await PgEventStore.open(o.db, { values, holidayTables, clock: o.clock, requireAppendOnlyRole: o.requireAppendOnlyRole });
  const agents = await (o.prepare ?? productionSetup)({ store, clock: o.clock, seed: o.seed ?? WORLD_SEED, holidayTable, llmInvestors: o.llm?.investors });
  const deps: RunnerDeps = {
    store,
    market: o.market ?? new IngestedMarketData(o.clock),
    values,
    holidayTables,
    agents,
    clock: o.clock,
    waitUntil: o.waitUntil ?? (async () => {}),
    // 決算の発表は runDay が、判断の前と1日の最後に書く
    seed: o.seed ?? WORLD_SEED,
    ...(o.llm ? { llm: o.llm } : {}),
  };
  const results = await runDay(date, deps);
  // 休日の実行（runDay が何もしない）でも、時期が来た決算を書く（前の営業日の引けのあとの実行がなかったとき）。
  // 営業日なら runDay が書き終えているので、何も書かない
  const disclosed = await discloseDue(store, o.seed ?? WORLD_SEED, o.clock);
  return disclosed.length > 0 ? [...results, { stage: "disclose", status: "written", detail: disclosed.join(",") }] : results;
}

/** 判断の段が締めに間に合わなかった（全員の判断がその日はなくなる）。実行を失敗として終わらせる印 */
/** LLM の段が例外で止まった（その段の detail が "error: " で始まる）。実行を失敗として終わらせる印 */
export const llmFailed = (results: readonly StageResult[]) => results.some((r) => r.stage.startsWith("llm.") && (r.detail ?? "").startsWith("error: "));

export const missedCutoff = (results: readonly StageResult[]) => results.some((r) => r.stage === "decide" && r.status === "skipped" && (r.detail ?? "").startsWith("after the cutoff"));

export interface VerifyReport {
  events: number;
  lastHash: string | null;
  agents: string[];
}

/** 記録だけから台帳を作り直して照合する（連鎖・各イベントの検査・口座などの記録との一致）。食い違えば例外 */
export async function verifyDatabase(db: SqlDb, holidayTable: HolidayTable = bundledHolidays): Promise<VerifyReport> {
  const events = await readAllEvents(db);
  const chain = await verifyChain(events);
  if (chain.length > 0) throw new Error(`chain: ${chain.join("; ")}`);
  const values = await PgValueStore.open(db);
  await replay(events, values, { holidayTables: new Map([[holidayTable.contentSha256, holidayTable]]) });
  const agents = [...new Set(events.filter((e) => e.type === "agent.registered").map((e) => (e.payload as { agentId: string }).agentId))];
  return { events: events.length, lastHash: events.at(-1)?.hash ?? null, agents };
}

/** 取り下げ（content.withdrawn）の頼み。運営者が daily withdraw で書く（EVENT_LOG §3.4・§6.1） */
export interface WithdrawRequest {
  /** 取り下げる投稿の seq（post.published の通し番号） */
  targetSeq: number;
  /** 理由（画面に「非表示（理由）」として出る）。空・空白だけは断る */
  reason: string;
  /** 本文も消すか。真なら bodyErased = true で記録する（本文そのものは、このあと運営者が erase_withdrawn_body で消す） */
  eraseBody: boolean;
  /** 書き手の名前（actor は operator:<名前>）。既定は owner */
  operator?: string;
}

export interface WithdrawResult {
  seq: number;
  hash: string;
  targetSeq: number;
  bodyErased: boolean;
  /**
   * 本文を消す印つきで書いたとき、同じ本文のハッシュを指すほかの投稿のうち、まだ本文を消す印つきで取り下げていないものの seq。
   * 空でなければ、それらも --erase-body で取り下げるまで、本文は消せない（erase_body.sql の手順1）
   */
  pendingSeqs: number[];
}

/** 理由の長さの上限（画面の1行に収まる程度） */
export const WITHDRAW_REASON_MAX = 200;
const OPERATOR_NAME = /^[a-z0-9_-]{1,32}$/;
/** ハッシュに見える文字列（16進で32文字以上）。erase_body.sql のとおり、理由にハッシュがあると、その本文を消せなくなる */
const HASH_LIKE = /[0-9a-f]{32,}/i;

/** 改行などの制御文字（Cc）と、見えない書式の文字（Cf。文字の向きを変える U+202A〜202E・U+2066〜2069、幅のない U+200B〜200F、U+061C、U+FEFF など）。画面で理由の見え方をすり替えられる */
/** 行・段落の区切り（U+2028・U+2029）も、改行として表示されるので断る */
const BAD_CHARS = /[\p{Cc}\p{Cf}\u202A-\u202E\u2066-\u2069\u2028\u2029]/u;
/** 見えない文字（空白・書式の文字・ハングルの埋め字）。これらを除いて1文字も残らない理由は、空と見なす */
const INVISIBLE = /[\s\p{Cf}\u115F\u1160\u3164\uFFA0]/gu;
const BODY_HASH = /^[0-9a-f]{64}$/;

/** 理由の誤りを返す（なければ null）。誤りは使い方の誤りとして扱う */
export function withdrawReasonProblem(reason: string | undefined): string | null {
  const r = (reason ?? "").trim();
  if (r.replace(INVISIBLE, "").length === 0) return "--reason is required (it must have a visible character)";
  if ([...r].length > WITHDRAW_REASON_MAX) return `--reason must be at most ${WITHDRAW_REASON_MAX} characters`;
  if (BAD_CHARS.test(r)) return "--reason must not contain line breaks, control characters or invisible formatting characters (such as bidirectional controls)";
  if (HASH_LIKE.test(r)) return "--reason must not contain a hash-like string (32 or more hex digits); it would block erasing a body";
  return null;
}

/** いまの接続が、events の表の持ち主（またはスーパーユーザー）か。アプリの接続（ffr_app）なら false */
export async function isTableOwner(db: SqlRunner): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean | null }>(
    `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
            OR pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE tablename = 'events' AND schemaname = current_schema()), 'USAGE') AS ok`,
  );
  return rows[0]?.ok === true;
}

/**
 * 投稿の取り下げ（content.withdrawn）を書く。表の持ち主の接続だけで動く（アプリの接続なら例外）。
 * 対象が投稿でない・存在しない、理由が空・長すぎる・制御文字やハッシュを含む、本文の行がないのに本文を残す記録にしようとした、
 * 本文を消す印つきなのに、その本文が消せない（ほかの記録が同じハッシュを指す）、ときは例外で何も書かない。
 * 本文は消さない（消すのは db/ops/erase_body.sql の erase_withdrawn_body）
 */
export async function withdrawPost(db: SqlDb, req: WithdrawRequest, o: { clock: Clock; holidayTable?: HolidayTable }): Promise<WithdrawResult> {
  const reasonProblem = withdrawReasonProblem(req.reason);
  if (reasonProblem) throw new RangeError(reasonProblem);
  if (!Number.isSafeInteger(req.targetSeq) || req.targetSeq < 1) throw new RangeError("targetSeq must be a positive integer");
  const operator = req.operator ?? "owner";
  if (!OPERATOR_NAME.test(operator)) throw new RangeError("operator must match [a-z0-9_-]{1,32}");
  if (!(await isTableOwner(db))) throw new Error("withdraw needs the table owner's connection (DATABASE_ADMIN_URL), not the app's connection");

  // 本文の行の確かめは、追記と同じトランザクションの中で、確定する直前に行い、合わなければ取り消す（確かめてから書くまでの間に
  // 本文が消されても食い違わない。行は FOR SHARE で押さえ、確定まで消させない）。書いたかは、トランザクションの返す追記の結果
  // （ok で content.withdrawn）で見分ける（SQL の文字列には頼らない）
  let bodyHash: string | null = null;
  let checked = false;
  let pendingSeqs: number[] = [];
  const guarded: SqlDb = {
    ...db,
    transaction: (fn) =>
      db.transaction(async (tx) => {
        const r = await fn(tx);
        const written = r as { ok?: unknown; event?: { type?: unknown } } | null;
        if (bodyHash !== null && written?.ok === true && written.event?.type === "content.withdrawn") {
          pendingSeqs = await checkBodyInTx(tx, req, bodyHash);
          checked = true;
        }
        return r;
      }),
  };
  const holidayTable = o.holidayTable ?? bundledHolidays;
  const values = await PgValueStore.open(db);
  const store = await PgEventStore.open(guarded, { values, holidayTables: new Map([[holidayTable.contentSha256, holidayTable]]), clock: o.clock });
  const target = (await store.read(req.targetSeq - 1, 1))[0];
  if (target?.seq !== req.targetSeq) throw new Error(`event ${req.targetSeq} does not exist`);
  if (target.type !== "post.published") throw new Error(`event ${req.targetSeq} is ${target.type}, not post.published`);
  const h = (target.payload as { bodyHash?: unknown }).bodyHash;
  if (typeof h !== "string" || !BODY_HASH.test(h)) throw new Error(`the bodyHash of ${req.targetSeq} is not a 64-digit hex string`);
  bodyHash = h;

  const r = await store.append({
    type: "content.withdrawn",
    actor: `operator:${operator}`,
    refs: [req.targetSeq],
    payload: { targetSeq: req.targetSeq, reason: req.reason.trim(), bodyErased: req.eraseBody },
  });
  if (!r.ok) throw new Error(`content.withdrawn: ${r.reason}`);
  // 守りが働かなかった（保管の作りが変わった）。書けてしまっているので、運営者に知らせて止める
  if (!checked) throw new Error(`content.withdrawn seq=${r.event.seq} was written, but the body check did not run; check db/ops/erase_body.sql (the second statement) before going on`);
  return { seq: r.event.seq, hash: r.event.hash, targetSeq: req.targetSeq, bodyErased: req.eraseBody, pendingSeqs };
}

/**
 * 追記したトランザクションの中で、本文の行と記録が食い違わないかを確かめる。合わなければ例外（追記は取り消される）。
 * - 本文を残す記録なのに、本文の行がない → 断る
 * - 本文を消す印つきで、投稿以外の記録（判断の出力・訂正・理由など）が同じハッシュを指す → 本文は消せないので断る
 * - 本文を消す印つきで、ほかの投稿だけが同じハッシュを指す → 書いてよい。まだ印つきで取り下げていない投稿の seq を返す
 * - それもなければ、DB の判定（stored_values_erasable）で消せることを確かめる
 */
async function checkBodyInTx(tx: SqlRunner, req: WithdrawRequest, bodyHash: string): Promise<number[]> {
  const row = await tx.query("SELECT 1 FROM stored_values WHERE hash = $1 AND kind = 'body' FOR SHARE", [bodyHash]);
  if (row.rows.length === 0) {
    if (!req.eraseBody) throw new Error(`the body of ${req.targetSeq} has no stored row (already erased, or never stored); use --erase-body so that the record matches`);
    return []; // 消す本文がもうない。印つきの記録は、保管の状態と合う
  }
  if (!req.eraseBody) return [];
  // db/003_erase_body.sql の stored_values_erasable と同じ見つけ方（投稿の bodyHash の項目を除き、記録の中身・keys・refs の文字列に含まれるか）。
  // bodyHash は64文字の16進であることを確かめてあるので、LIKE の特別な文字は入らない
  const elsewhere = await tx.query<{ seq: string | number }>(
    `SELECT e.seq FROM events e
     WHERE ((CASE WHEN e.type = 'post.published' AND jsonb_typeof(e.payload) = 'object' THEN e.payload - 'bodyHash' ELSE e.payload END)::text
            || e.keys::text || e.refs::text) LIKE '%' || $1 || '%'
     ORDER BY e.seq LIMIT 5`,
    [bodyHash],
  );
  if (elsewhere.rows.length > 0) {
    throw new Error(`the body of ${req.targetSeq} cannot be erased: other records refer to the same hash (seq ${elsewhere.rows.map((x) => Number(x.seq)).join(", ")}); nothing was written`);
  }
  const pending = await tx.query<{ seq: string | number }>(
    `SELECT p.seq FROM events p
     WHERE p.type = 'post.published' AND p.payload->>'bodyHash' = $1
       AND (SELECT w.payload->'bodyErased' FROM events w
            WHERE w.type = 'content.withdrawn' AND w.actor LIKE 'operator:%' AND w.payload->'targetSeq' = to_jsonb(p.seq)
            ORDER BY w.seq DESC LIMIT 1) IS DISTINCT FROM 'true'::jsonb
     ORDER BY p.seq`,
    [bodyHash],
  );
  const pendingSeqs = pending.rows.map((x) => Number(x.seq));
  if (pendingSeqs.length > 0) return pendingSeqs;
  const ok = (await tx.query<{ ok: boolean }>("SELECT stored_values_erasable(current_schema(), $1) AS ok", [bodyHash])).rows[0]?.ok;
  if (ok !== true) throw new Error(`the body of ${req.targetSeq} cannot be erased (the database check stored_values_erasable says no); nothing was written`);
  return [];
}
