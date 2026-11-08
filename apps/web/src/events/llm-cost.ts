// LLM の費用の上限を、記録だけから確かめる（#179）。
// その日の使用済み ＝ 閉じたバッチ（llm.batch.closed）の実際の費用 ＋ 閉じていないバッチ（llm.batch.submitted だけ）の予約。
// llm.batch.submitted は提供元に送る前に書く予約なので、送ったか（llm.batch.sent があるか）は数え方に関わらない。
// 全提供元の合計。暦日は、依頼の記録（llm.batch.submitted）の submittedAt（依頼を決めた時刻）の日本時間の日付（記録した日・閉じた日ではない）。
// 追記の処理（append.ts）は、llm.batch.submitted を書くときに llmCostUsed で上限を確かめる。
// 照合（replay）を通ったログに使う。中身の形は追記の処理が確かめている。
import type { Deciyen } from "../ledger/types";
import type { LogEvent } from "./types";

/** 1日の上限（全提供元の合計で100円。D-041 の 2026-11-07 の追記） */
export const LLM_DAILY_COST_LIMIT: Deciyen = 1000;

type Rec = Pick<LogEvent, "seq" | "type" | "recordedAt" | "payload">;
type Payload = Record<string, unknown>;

const JST_MS = 9 * 3_600_000;

/**
 * 換算に使う料金。単価は1,000万トークンあたりのセント（1ドル＝100セント）。Gemini の半セント（37.5セント／100万トークン）も整数で表せる。
 * yenPerUsd は1ドルあたりの円（1以上の整数。既定は160。#179 の lead の決定）
 */
export interface LlmPrice {
  yenPerUsd: number;
  inputCentsPer10MTok: number;
  outputCentsPer10MTok: number;
}

/** 費用に数えるトークン数。キャッシュの欄はなければ 0 */
export interface LlmTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * トークン数から費用（0.1円単位。端数は切り上げ）を出す。安全な整数に収まらなければ null。
 * 式は src/llm/cost.ts の batchCostDeciyen と同じ（キャッシュへの書き込みは入力の2倍、読み出しは入力と同じ単価）。
 * src/events は src/llm を import できない（純関数の決まりと担当のパス）ので、ここに同じ式をもう一度書く。
 * 単価を100万トークンあたりから1,000万トークンあたりにした分、分母を10倍にしている。
 * 費用（0.1円）＝ 切り上げ(Σ(トークン数 × セント/1,000万トークン) × 円/ドル × 10 ÷ (100 × 1,000万))
 * 引数は 0 以上の安全な整数であること（呼び出し側が確かめる）
 */
export function llmTokenCost(t: LlmTokens, price: LlmPrice): Deciyen | null {
  const B = BigInt;
  const input = B(price.inputCentsPer10MTok);
  const centTokens =
    B(t.inputTokens) * input +
    B(t.cacheCreationInputTokens ?? 0) * input * 2n +
    B(t.cacheReadInputTokens ?? 0) * input +
    B(t.outputTokens) * B(price.outputCentsPer10MTok);
  const numerator = centTokens * B(price.yenPerUsd) * 10n;
  const denominator = 100n * 10_000_000n;
  const cost = (numerator + denominator - 1n) / denominator;
  return cost > B(Number.MAX_SAFE_INTEGER) ? null : Number(cost);
}

/** UNIXミリ秒の日本時間の日付（YYYY-MM-DD） */
export function jstDayOf(ms: number): string {
  return new Date(ms + JST_MS).toISOString().slice(0, 10);
}

/** 1件の依頼の費用。upTo（seq）より前に閉じていれば実際の費用、そうでなければ予約 */
interface Batch {
  seq: number;
  day: string;
  maxCost: Deciyen;
  closed: { seq: number; cost: Deciyen } | null;
}

function batchesOf(events: readonly Rec[]): Batch[] {
  const bySeq = new Map<number, Batch>();
  for (const e of events) {
    const p = e.payload as Payload;
    if (e.type === "llm.batch.submitted") bySeq.set(e.seq, { seq: e.seq, day: jstDayOf(p.submittedAt as number), maxCost: p.maxCost as number, closed: null });
    if (e.type === "llm.batch.closed") {
      const b = bySeq.get(p.batchSeq as number);
      if (b && !b.closed) b.closed = { seq: e.seq, cost: p.cost as number };
    }
  }
  return [...bySeq.values()];
}

const usedBy = (batches: readonly Batch[], day: string, before: number): Deciyen =>
  batches.filter((b) => b.day === day && b.seq < before).reduce((sum, b) => sum + (b.closed && b.closed.seq < before ? b.closed.cost : b.maxCost), 0);

/** day（日本時間）の使用済み */
export function llmCostUsed(events: readonly Rec[], day: string): Deciyen {
  return usedBy(batchesOf(events), day, Number.POSITIVE_INFINITY);
}

export interface LlmCostProblem {
  day: string;
  /**
   * reservation：依頼の記録の時点で、それまでの使用済み＋その予約が上限を超えていた（seq はその依頼）。
   * 追記の処理が同じ判定で断るので、追記を通ったログには出ない（記録を別の方法で確かめるために残す）。
   * total：その日の使用済みが、いまの記録で上限を超えている（実費が予約を超えたときなど。seq はその日の最後の依頼）
   */
  kind: "reservation" | "total";
  seq: number;
  used: Deciyen;
  limit: Deciyen;
}

/** 上限が守られたか。守られていれば空。依頼の時点の判定と、その日の合計の両方を見る */
export function llmCostProblems(events: readonly Rec[], limit: Deciyen = LLM_DAILY_COST_LIMIT): LlmCostProblem[] {
  const batches = batchesOf(events);
  const out: LlmCostProblem[] = [];
  const last = new Map<string, number>();
  for (const b of batches) {
    const used = usedBy(batches, b.day, b.seq) + b.maxCost;
    if (used > limit) out.push({ day: b.day, kind: "reservation", seq: b.seq, used, limit });
    last.set(b.day, b.seq);
  }
  for (const [day, seq] of last) {
    const used = usedBy(batches, day, Number.POSITIVE_INFINITY);
    if (used > limit) out.push({ day, kind: "total", seq, used, limit });
  }
  return out;
}

/** 閉じていない依頼（受け取りか打ち切りがまだのもの）を、記録の順で */
export function openLlmBatches(events: readonly Rec[]): Rec[] {
  const open = batchesOf(events).filter((b) => !b.closed).map((b) => b.seq);
  return events.filter((e) => e.type === "llm.batch.submitted" && open.includes(e.seq));
}

/** 依頼（llm.batch.submitted の seq）を指す送った記録（llm.batch.sent）。まだなければ null（②と③のあいだで止まった、または送れなかった） */
export function llmSentOf(events: readonly Rec[], batchSeq: number): Rec | null {
  return events.find((e) => e.type === "llm.batch.sent" && (e.payload as Payload).batchSeq === batchSeq) ?? null;
}

/** 予約の控え。契約の LlmBatchReservation（src/contracts/llm.ts）と同じ形（src/events は契約を import できないので、ここにも書く） */
export interface LlmReservationFields {
  /** 依頼の記録（llm.batch.submitted）の seq。送った記録と閉じる記録の batchSeq に入れる */
  batchSeq: number;
  agentId: string;
  provider: string;
  modelId: string;
  customId: string;
  maxCost: Deciyen;
  tradingDate: string;
  submittedAt: number;
}

/** 受け取りの控え。契約の LlmBatchTicket と同じ形 */
export interface LlmTicketFields extends LlmReservationFields {
  batchId: string;
}

/** 依頼の記録（llm.batch.submitted）から、予約の控えを作り直す（②と③のあいだで止まったあとに、提供元で探すのに使う） */
export function llmReservationOf(submitted: Rec): LlmReservationFields {
  if (submitted.type !== "llm.batch.submitted") throw new RangeError("not an llm.batch.submitted event");
  const p = submitted.payload as Payload;
  return {
    batchSeq: submitted.seq,
    agentId: p.agentId as string,
    provider: p.provider as string,
    modelId: p.modelId as string,
    customId: p.customId as string,
    maxCost: p.maxCost as number,
    tradingDate: p.tradingDate as string,
    submittedAt: p.submittedAt as number,
  };
}

/**
 * 依頼の記録（llm.batch.submitted）と、それを指す送った記録（llm.batch.sent）から、受け取りに使う控えを作り直す。
 * sent が null（まだ送った記録がない）なら null。種類が違う、または sent が submitted を指していなければ RangeError
 */
export function llmTicketOf(submitted: Rec, sent: Rec | null): LlmTicketFields | null {
  const reservation = llmReservationOf(submitted);
  if (sent === null) return null;
  const q = sent.payload as Payload;
  if (sent.type !== "llm.batch.sent" || q.batchSeq !== submitted.seq) throw new RangeError("not an llm.batch.sent event of the submission");
  return { ...reservation, batchId: q.batchId as string };
}
