// LLM の AI 投資家を、毎日の実行の段に入れる（#179）。
// 依頼（llmSubmit）：前の営業日の引けのあと（16:35 の実行）に、3体の入力を作って各社のバッチに依頼する。
// 受け取りと判断（llmCollect、llm-collect.ts）：翌朝（06:50・07:20 の実行）に答えを受け取り、投稿と注文票を書く。
// 流れは契約（src/contracts/llm.ts の LlmBatchPort）のとおり：本文を作る → 上限を確かめる → ①予約を記録 → 送る → ③バッチのIDを記録。
// 書くのは保管だけ。API キーはここに来ない（各社の口が環境変数から読む）。
import type { Clock, LlmBatchPort, LlmPolicy, LlmPreparedBatch, SheetInput } from "../contracts";
import { jstDayOf, LLM_DAILY_COST_LIMIT, llmCostUsed } from "../events/llm-cost";
import type { LogEvent } from "../events/types";
import { cutoffOf, nextBusinessDay, tradingDateFor } from "../ledger/ledger";
import type { Account } from "../ledger/types";
import { checkDailyBatchReservations } from "../llm/batch-plan";
import { investorPrompt, investorUserText } from "../llm/investor-prompt";
import type { ValuesPort } from "../store/pg-values";
import { type LlmInvestor, investorRequest } from "./llm-agents";
import { investorInputOf } from "./llm-input";

/** 毎日の実行に渡す、LLM の AI 投資家の設定 */
export interface LlmDeps {
  investors: readonly LlmInvestor[];
  /** 1日の上限（記録の上限 LLM_DAILY_COST_LIMIT との小さいほうを使う）と、試運転（投稿だけで注文を出さない） */
  policy: LlmPolicy;
  /** 1ドルあたりの円（owner の決定で160。2026-11-07） */
  yenPerUsd: number;
  /**
   * 提供元の口。clock を渡したら、その時計で動く口（翌朝、依頼の時刻の時計で本文を作り直すとき）。
   * 口は同じ policy と yenPerUsd で作る
   */
  portOf(provider: string, clock?: Clock): LlmBatchPort;
}

type Payload = Record<string, unknown>;
export type Appended = { ok: true; event: LogEvent } | { ok: false; reason: string };

/** 段から保管と写しに触る口（day.ts の Day が渡す）。append は、断られても例外にせず、書けたら写しにも当てる */
export interface DayAccess {
  events(): readonly LogEvent[];
  holidays(): ReadonlySet<string>;
  account(agentId: string): Account;
  clock: Clock;
  values: ValuesPort;
  append(type: "agent.run" | "llm.batch.submitted" | "llm.batch.sent" | "llm.batch.closed", payload: Payload, refs: number[]): Promise<Appended>;
  /** 投稿（post.published）を書く。書き手は payload.agentId のAI */
  post(payload: Payload, refs: number[]): Promise<Appended>;
  /** 注文票の確定。試運転（policy.dryRun）の間は、この口を持たない（注文を出せない。契約の OrderlessEventStore と同じ考え方） */
  commitSheet?: (agentId: string, sheet: SheetInput) => Promise<Appended>;
}

/** 依頼してよい時刻：引けの取り込み（16:30。day.ts の scheduleOf の closeAt）のあと。その日の大引けのあとの決算の発表を入力に入れるため */
export const llmSubmitAt = (date: string) => cutoffOf(date) + 8 * 3_600_000;

export type LlmStageResult = { stage: string; status: "written" | "done" | "waiting" | "skipped"; detail?: string };

const pl = (e: LogEvent) => e.payload as Payload;
const find = (events: readonly LogEvent[], type: LogEvent["type"], match: (p: Payload) => boolean) => events.find((e) => e.type === type && match(pl(e)));

/** その取引日の依頼（①）。なければ undefined */
export const submissionOf = (events: readonly LogEvent[], agentId: string, tradingDate: string) => find(events, "llm.batch.submitted", (p) => p.agentId === agentId && p.tradingDate === tradingDate);

/** 停止の状態（day.ts の suspended と同じ決め方。"*" は全体） */
export function isSuspended(events: readonly LogEvent[], agentId: string, scope: "posts" | "orders"): boolean {
  const on = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type !== "agent.suspended" && e.type !== "agent.resumed") continue;
    const p = pl(e);
    const set = on.get(p.agentId as string) ?? new Set<string>();
    for (const x of p.scope === "both" ? ["posts", "orders"] : [p.scope as string]) (e.type === "agent.suspended" ? set.add(x) : set.delete(x));
    on.set(p.agentId as string, set);
  }
  return [agentId, "*"].some((id) => on.get(id)?.has(scope) ?? false);
}

/** LLM の agent.run の中身。費用とトークン数の欄は、分かるものだけ */
export function llmRunPayload(
  a: LlmInvestor,
  x: { prompt: { id: string; version: string; hash: string }; inputSeqs: number[]; requestHash: string; startedAt: number; finishedAt: number; purpose?: "post" | "order" } & ({ ok: true; outputHash: string } | { ok: false; errorCode: string }) & { cost?: Payload },
): Payload {
  const { prompt, inputSeqs, requestHash, startedAt, finishedAt, cost } = x;
  const base = { agentId: a.id, purpose: x.purpose ?? "order", model: a.model, prompt, inputSeqs, requestHash, startedAt, finishedAt, ...(cost ?? {}) };
  return x.ok ? { ...base, outputHash: x.outputHash, ok: true } : { ...base, ok: false, errorCode: x.errorCode };
}

/**
 * 依頼の段。date は引けを迎えた営業日で、依頼は次の営業日（取引日）の分。今が、date の引けの取り込み（16:30）のあとで、
 * その取引日の締めの前（取引日が今の時点の次の取引日と同じ）でなければ飛ばす（板寄せの価格だけで動く日は、引け後の処理が
 * 9:35 の実行で済むが、依頼は 16:35 の実行まで待つ）。AIごとに、前の日の引け後の処理が済むまで待つ。①があれば（送ったかどうかによらず）何もしない
 * （②と③のあいだで止まった依頼は、受け取りの段が探す）
 */
export async function llmSubmit(day: DayAccess, llm: LlmDeps, date: string): Promise<LlmStageResult> {
  const stage = "llm.submit";
  const H = day.holidays();
  const T = nextBusinessDay(date, H);
  const now = day.clock.now();
  if (now < llmSubmitAt(date)) return { stage, status: "skipped", detail: `before the close of ${date}` };
  if (tradingDateFor(now, H) !== T) return { stage, status: "skipped", detail: `not the evening before ${T}` };
  const events = day.events();
  const active = llm.investors.filter((a) => {
    const r = find(events, "agent.registered", (p) => p.agentId === a.id);
    return r !== undefined && (pl(r).startDate as string) <= T;
  });
  const todo = active.filter((a) => !submissionOf(events, a.id, T) && !(isSuspended(events, a.id, "posts") && isSuspended(events, a.id, "orders")));
  if (todo.length === 0) return { stage, status: "done" };
  // 3体の予約の合計が目標（80円）を超える設定なら、どのAIも依頼せず、段を失敗にする（設定の誤りなので、毎日の実行の終了コードで知らせる）
  try {
    checkDailyBatchReservations(active.map((a) => a.model), now, { yenPerUsd: llm.yenPerUsd });
  } catch (e) {
    return { stage, status: "skipped", detail: `error: ${errorText(e)}` };
  }
  const prompt = await investorPrompt();
  // 入力に使う記録は、この段の始めの記録で3体とも同じにする（あとで書く①・③は入力に入らない）。3体の市場の文が同じことも確かめる
  const base = events;
  let market: string | undefined;
  const notes: string[] = [];
  const errors: string[] = [];
  const waiting: string[] = [];
  let wrote = false;
  for (const a of todo) {
    try {
      const registered = find(base, "agent.registered", (p) => p.agentId === a.id)!;
      // 口座は前の日の引け後の処理のあとのもの（開始日が取引日なら、登録の口座）
      if ((pl(registered).startDate as string) < T && !find(base, "corporate_actions.applied", (p) => p.agentId === a.id && p.asOf === date && p.closedSeq === undefined)) {
        waiting.push(a.id);
        continue;
      }
      const evs = day.events();
      // 上限を超えて送らなかった日は、同じ失敗を何度も書かない（その日の依頼の時刻よりあとに書いた budget_exceeded があれば飛ばす）
      if (evs.some((e) => e.type === "agent.run" && pl(e).agentId === a.id && pl(e).errorCode === "budget_exceeded" && (pl(e).startedAt as number) >= llmSubmitAt(date))) {
        notes.push(`${a.id}:budget_exceeded`);
        continue;
      }
      const at = day.clock.now();
      const input = investorInputOf(base, { agentId: a.id, tradingDate: T, prev: date, submittedAt: at, account: day.account(a.id), body: (h) => bodyText(day.values, h) });
      const { text, marketText, inputSeqs, omitted } = investorUserText(input);
      if (market !== undefined && marketText !== market) throw new Error("the market text differs between investors");
      market = marketText;
      const request = investorRequest(a, { prompt, tradingDate: T, submittedAt: at, inputSeqs, userText: text, yenPerUsd: llm.yenPerUsd });
      const port = llm.portOf(a.model.provider);
      const prepared = await port.prepare(request);
      const run = (errorCode: string, cost: Payload) => day.append("agent.run", llmRunPayload(a, { prompt, inputSeqs, requestHash: prepared.sentBodyHash, startedAt: at, finishedAt: day.clock.now(), ok: false, errorCode, cost }), inputSeqs);
      // 上限：記録から数えたその日の使用済み＋この予約が、記録の上限と policy の上限の小さいほうを超えるなら、送らずに失敗を残す
      const limit = Math.min(LLM_DAILY_COST_LIMIT, llm.policy.dailyCostLimit);
      if (llmCostUsed(evs, jstDayOf(at)) + request.maxCost > limit) {
        await must(run("budget_exceeded", { maxCost: request.maxCost, cost: 0 }), "agent.run");
        notes.push(`${a.id}:budget_exceeded`);
        wrote = true;
        continue;
      }
      const sub = await day.append("llm.batch.submitted", submittedPayload(prepared, llm.yenPerUsd), []);
      if (!sub.ok) {
        notes.push(`${a.id}:not reserved (${sub.reason})`);
        continue;
      }
      wrote = true;
      if (omitted.posts > 0 || omitted.auctionDays > 0) notes.push(`${a.id}:omitted ${omitted.posts} posts, ${omitted.auctionDays} days`);
      const sent = await port.send(prepared, sub.event.seq);
      const batchSeq = sub.event.seq;
      if (sent.ok) {
        await must(day.append("llm.batch.sent", { batchSeq, agentId: a.id, provider: a.model.provider, batchId: sent.batchId }, [batchSeq]), "llm.batch.sent");
      } else if ("notCreated" in sent) {
        // 作られていないと確か：費用0で閉じ、その日の判断がないことを失敗の run で見えるようにする
        const price = { inputCentsPer10MTok: request.reservePrice.inputCentsPer10MTok, outputCentsPer10MTok: request.reservePrice.outputCentsPer10MTok };
        await must(day.append("llm.batch.closed", { batchSeq, agentId: a.id, result: "failed", cost: 0, inputTokens: 0, outputTokens: 0, notCreatedError: sent.errorCode, ...price }, [batchSeq]), "llm.batch.closed");
        await must(run(sent.errorCode, { maxCost: request.maxCost, cost: 0 }), "agent.run");
        notes.push(`${a.id}:not sent (${sent.errorCode})`);
      } else {
        notes.push(`${a.id}:send unknown (${sent.errorCode}); the next run looks for it`);
      }
    } catch (e) {
      // 1体の例外で、ほかのAIを止めない。段の結果は失敗（detail が "error: " で始まる）にする
      errors.push(`${a.id}: ${errorText(e)}`);
    }
  }
  const rest = [...notes, ...(waiting.length > 0 ? [`post-close of ${date} not done: ${waiting.join(",")}`] : [])].join("; ");
  const detail = errors.length > 0 ? `error: ${errors.join("; ")}${rest ? `; ${rest}` : ""}` : rest || undefined;
  const status = wrote ? "written" : errors.length > 0 ? "skipped" : waiting.length > 0 ? "waiting" : "done";
  return { stage, status, ...(detail ? { detail } : {}) };
}

/** ①の中身（契約の流れの2。料金とトークン数の上限は依頼から、ハッシュ・customId・本文の出力の上限は本文を作った結果から） */
export function submittedPayload(p: LlmPreparedBatch, yenPerUsd: number): Payload {
  const r = p.request;
  return {
    agentId: r.agentId,
    provider: r.model.provider,
    modelId: r.model.modelId,
    promptVersion: r.prompt.version,
    sentBodyHash: p.sentBodyHash,
    customId: p.customId,
    maxCost: r.maxCost,
    tradingDate: r.tradingDate,
    submittedAt: r.submittedAt,
    yenPerUsd,
    inputCentsPer10MTok: r.reservePrice.inputCentsPer10MTok,
    outputCentsPer10MTok: r.reservePrice.outputCentsPer10MTok,
    maxInputTokens: r.maxInputTokens,
    maxOutputTokens: r.maxOutputTokens,
    bodyMaxOutputTokens: p.bodyMaxOutputTokens,
  };
}

/** 本文の保管から文字列の本文を引く（消した本文・文字列でないものは null） */
export function bodyText(values: ValuesPort, hash: string): string | null {
  const b = values.body(hash);
  return b && typeof b.value === "string" ? b.value : null;
}

/** 例外の文を、結果と標準出力に書ける形にする（改行・制御文字を空白に、200文字まで） */
export function errorText(e: unknown): string {
  const t = (e instanceof Error ? e.message : String(e)).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return [...t].length > 200 ? `${[...t].slice(0, 200).join("")}…` : t;
}

export async function must(r: Promise<Appended>, what: string): Promise<LogEvent> {
  const x = await r;
  if (!x.ok) throw new Error(`${what}: ${x.reason}`);
  return x.event;
}
