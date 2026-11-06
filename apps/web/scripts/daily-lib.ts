// 毎日の実行の本体（#30）。DB の保管（PgEventStore・PgValueStore）に対して、runner の runDay を1日分進める。
// 手順そのもの（判断 → 締め切り → 板寄せ → 約定 → 評価）は src/runner/ の runDay が持つ。ここは、保管を開き、
// 準備（市場・参加者の登録）を済ませ、runDay を呼ぶだけ。同じ日を何度回しても、runDay が済んだ段を飛ばすので二重に書かない。
// 実行のたびに DB から作り直すので、プロセスが落ちたあとの回し直しも同じ形になる。
import type { Clock, MarketDataPort } from "../src/contracts";
import { verifyChain } from "../src/events/chain";
import { replay } from "../src/events/replay";
import type { LogEvent } from "../src/events/types";
import { holidayTable as bundledHolidays, holidaysFor, type HolidayTable } from "../src/holidays";
import { IngestedMarketData } from "../src/ingest/market-data";
import { cutoffOf, isBusinessDay, isValidDate, nextBusinessDay } from "../src/ledger/ledger";
import { INITIAL_CASH } from "../src/ledger/types";
import { type RunnerAgent, type RunnerDeps, type StageResult, runDay } from "../src/runner/day";
import { ruleAgents } from "../src/runner/rule-agents";
import { discloseDue } from "../src/runner/world/disclosure";
import type { RunnerValues } from "../src/runner/values";
import { listCompanies } from "../src/runner/world/listing";
import { liquidityAgents, setUpParticipants } from "../src/runner/world/participants";
import { PgEventStore, readAllEvents } from "../src/store/pg-store";
import { PgValueStore, type ValuesPort } from "../src/store/pg-values";
import type { SqlDb } from "../src/store/sql";
import type { EventStore } from "../src/contracts";

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
export async function productionSetup({ store, clock, seed, holidayTable }: PrepareContext): Promise<RunnerAgent[]> {
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
  for (const a of investors) {
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
  const agents = await (o.prepare ?? productionSetup)({ store, clock: o.clock, seed: o.seed ?? WORLD_SEED, holidayTable });
  const deps: RunnerDeps = {
    store,
    market: o.market ?? new IngestedMarketData(o.clock),
    // 仮：runner が ValuesPort を受け取るようになるまで（#113 のセッションが直す。lead の指示）、型を合わせる
    values: values as ValuesPort as unknown as RunnerValues,
    holidayTables,
    agents,
    clock: o.clock,
    waitUntil: o.waitUntil ?? (async () => {}),
    // 決算の発表は runDay が、判断の前と1日の最後に書く
    seed: o.seed ?? WORLD_SEED,
  };
  const results = await runDay(date, deps);
  // 休日の実行（runDay が何もしない）でも、時期が来た決算を書く（前の営業日の引けのあとの実行がなかったとき）。
  // 営業日なら runDay が書き終えているので、何も書かない
  const disclosed = await discloseDue(store, o.seed ?? WORLD_SEED, o.clock);
  return disclosed.length > 0 ? [...results, { stage: "disclose", status: "written", detail: disclosed.join(",") }] : results;
}

/** 判断の段が締めに間に合わなかった（全員の判断がその日はなくなる）。実行を失敗として終わらせる印 */
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
