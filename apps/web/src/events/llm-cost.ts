// LLM の費用の上限を、記録だけから確かめる（#179）。
// その日の使用済み ＝ 閉じたバッチ（llm.batch.closed）の実際の費用 ＋ 閉じていないバッチ（llm.batch.submitted だけ）の予約。
// 全提供元の合計。暦日は、依頼の記録（llm.batch.submitted）の recordedAt の日本時間の日付（閉じた日ではない）。
// 照合（replay）を通ったログに使う。中身の形は追記の処理（append.ts）が確かめている。
import type { Deciyen } from "../ledger/types";
import type { LogEvent } from "./types";

/** 1日の上限（全提供元の合計で100円。D-041 の 2026-11-07 の追記） */
export const LLM_DAILY_COST_LIMIT: Deciyen = 1000;

type Rec = Pick<LogEvent, "seq" | "type" | "recordedAt" | "payload">;
type Payload = Record<string, unknown>;

const JST_MS = 9 * 3_600_000;

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
    if (e.type === "llm.batch.submitted") bySeq.set(e.seq, { seq: e.seq, day: jstDayOf(e.recordedAt), maxCost: p.maxCost as number, closed: null });
    if (e.type === "llm.batch.closed") {
      const b = bySeq.get(p.batchSeq as number);
      if (b && !b.closed) b.closed = { seq: e.seq, cost: p.cost as number };
    }
  }
  return [...bySeq.values()];
}

const usedBy = (batches: readonly Batch[], day: string, before: number): Deciyen =>
  batches.filter((b) => b.day === day && b.seq < before).reduce((sum, b) => sum + (b.closed && b.closed.seq < before ? b.closed.cost : b.maxCost), 0);

/** day（日本時間）の使用済み。LlmBatchPort.spent のうち、記録にある分 */
export function llmCostUsed(events: readonly Rec[], day: string): Deciyen {
  return usedBy(batchesOf(events), day, Number.POSITIVE_INFINITY);
}

export interface LlmCostProblem {
  day: string;
  /**
   * reservation：依頼の記録の時点で、それまでの使用済み＋その予約が上限を超えていた（seq はその依頼）。
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

/** 受け取りの控え。契約の LlmBatchTicket（src/contracts/llm.ts）と同じ形（src/events は契約を import できないので、ここにも書く） */
export interface LlmTicketFields {
  agentId: string;
  provider: string;
  modelId: string;
  batchId: string;
  customId: string;
  maxCost: Deciyen;
  tradingDate: string;
  submittedAt: number;
}

/** llm.batch.submitted の記録から、受け取りに使う控えを作り直す。batchId が null（作られたか分からない）なら null */
export function llmTicketOf(e: Rec): LlmTicketFields | null {
  if (e.type !== "llm.batch.submitted") throw new RangeError("not an llm.batch.submitted event");
  const p = e.payload as Payload;
  if (p.batchId === null) return null;
  return {
    agentId: p.agentId as string,
    provider: p.provider as string,
    modelId: p.modelId as string,
    batchId: p.batchId as string,
    customId: p.customId as string,
    maxCost: p.maxCost as number,
    tradingDate: p.tradingDate as string,
    submittedAt: e.recordedAt,
  };
}
