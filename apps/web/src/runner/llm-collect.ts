// LLM の AI 投資家の受け取りと判断の段（翌朝 06:50・07:20 の実行。#179）。
// 取引日 date の依頼（①）ごとに：③がなければ提供元で探す → 受け取る（締めを過ぎていれば打ち切る）→ 閉じた記録を書く →
// 出力を読み、投稿と注文票を書く。出力が形に合わない・上限で切れたら agent.run の失敗（invalid_output）を残し、その日は注文しない。
// 試運転（policy.dryRun）の間は、投稿だけを書き、注文票は書かない（commitSheet を持たない口しか受け取らない）。
// 入力は、①より前の記録から作り直し、送った本文のハッシュと同じであることを確かめてから使う（入力の seq を記録に残すため）。
import type { LlmBatchClosed, LlmPrompt } from "../contracts";
import { canonicalize } from "../events/canonical";
import { llmReservationOf, llmSentOf, llmTicketOf } from "../events/llm-cost";
import type { LogEvent } from "../events/types";
import { cutoffOf } from "../ledger/ledger";
import type { BatchClosed } from "../llm/batch-port";
import { investorPrompt, investorUserText } from "../llm/investor-prompt";
import { type InvestorDecision, parseInvestorOutput } from "../llm/investor-output";
import { type LlmInvestor, investorRequest } from "./llm-agents";
import { investorInputOf } from "./llm-input";
import { type DayAccess, type LlmDeps, type LlmStageResult, bodyText, isSuspended, llmRunPayload, must, submissionOf } from "./llm-stage";

/** ③のない①を、閉じずに探し続ける時間（送る時間の上限10分＋一覧への反映の余裕30分。契約の LlmFindResult） */
export const FIND_GRACE_MS = 40 * 60_000;

type Payload = Record<string, unknown>;
const pl = (e: LogEvent) => e.payload as Payload;

/** 閉じた結果から、llm.batch.closed の中身を作る（truncated は記録の欄にないので外す） */
function closedPayload(sub: LogEvent, c: LlmBatchClosed): Payload {
  const u = c.usage;
  return {
    batchSeq: sub.seq,
    agentId: pl(sub).agentId,
    result: c.result,
    cost: u.cost,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    ...(u.cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens: u.cacheCreationInputTokens }),
    ...(u.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: u.cacheReadInputTokens }),
    ...(c.costUnknown ? { costUnknown: true } : { inputCentsPer10MTok: c.price.inputCentsPer10MTok, outputCentsPer10MTok: c.price.outputCentsPer10MTok }),
  };
}

/** 閉じた記録から、agent.run に写す費用とトークン数 */
const costOf = (sub: LogEvent, closed: LogEvent): Payload => ({ maxCost: pl(sub).maxCost, cost: pl(closed).cost, inputTokens: pl(closed).inputTokens, outputTokens: pl(closed).outputTokens });

/**
 * 受け取りと判断の段。date は取引日。締め（8:30）を過ぎて答えがなければ打ち切り、その日は注文なし（記録に残す）。
 * 試運転かどうかは llm.policy.dryRun で決める
 */
export async function llmCollect(day: DayAccess, llm: LlmDeps, date: string): Promise<LlmStageResult> {
  const stage = "llm.collect";
  const notes: string[] = [];
  const waiting: string[] = [];
  let wrote = false;
  const prompt = await investorPrompt();
  for (const a of llm.investors) {
    const sub = submissionOf(day.events(), a.id, date);
    if (!sub) continue;
    const r = await settle(day, llm, a, sub, prompt);
    if (r.wrote) wrote = true;
    if (r.waiting) waiting.push(a.id);
    if (r.note) notes.push(`${a.id}:${r.note}`);
  }
  const detail = [...notes, ...(waiting.length > 0 ? [`waiting: ${waiting.join(",")}`] : [])].join("; ") || undefined;
  return { stage, status: waiting.length > 0 && !wrote ? "waiting" : wrote ? "written" : "done", ...(detail ? { detail } : {}) };
}

type Settled = { wrote?: boolean; waiting?: boolean; note?: string };

async function settle(day: DayAccess, llm: LlmDeps, a: LlmInvestor, sub: LogEvent, prompt: LlmPrompt): Promise<Settled> {
  const date = pl(sub).tradingDate as string;
  const now = day.clock.now();
  const late = now >= cutoffOf(date);
  const port = llm.portOf(a.model.provider);
  const closedOf = () => day.events().find((e) => e.type === "llm.batch.closed" && pl(e).batchSeq === sub.seq);
  const fail = (errorCode: string, cost: Payload, batchSeq?: number) =>
    must(day.append("agent.run", { ...llmRunPayload(a, { prompt, inputSeqs: [], requestHash: pl(sub).sentBodyHash as string, startedAt: now, finishedAt: day.clock.now(), ok: false, errorCode, cost }), ...(batchSeq ? { batchSeq, sentBodyHash: pl(sub).sentBodyHash } : {}) }, batchSeq ? [batchSeq] : []), "agent.run");
  let closed = closedOf();
  // 見つからないまま予約した費用で閉じた依頼も、締めまでは探し続け、見つけたら取り消しを頼む（返った結果は記録しない。契約の LlmFindResult）
  if (closed && pl(closed).costUnknown === true && !llmSentOf(day.events(), sub.seq) && !late) {
    const f = await port.find(llmReservationOf(sub));
    if (f.status === "found") await port.abandon({ ...llmReservationOf(sub), batchId: f.batchId });
    return {};
  }
  let fresh: { output: string; truncated: boolean } | null = null;
  if (!closed) {
    let sent = llmSentOf(day.events(), sub.seq);
    if (!sent) {
      // ②と③のあいだで止まった依頼：提供元で探す。見つからないまま40分たつか、締めを過ぎたら、予約した費用で閉じる
      const f = await port.find(llmReservationOf(sub));
      if (f.status === "found") sent = await must(day.append("llm.batch.sent", { batchSeq: sub.seq, agentId: a.id, provider: a.model.provider, batchId: f.batchId }, [sub.seq]), "llm.batch.sent");
      else if (late || (f.status === "not_found" && now - sub.recordedAt >= FIND_GRACE_MS)) {
        await must(day.append("llm.batch.closed", { batchSeq: sub.seq, agentId: a.id, result: "failed", cost: pl(sub).maxCost, costUnknown: true, inputTokens: 0, outputTokens: 0 }, [sub.seq]), "llm.batch.closed");
        await fail("provider_error", { maxCost: pl(sub).maxCost, cost: pl(sub).maxCost });
        return { wrote: true, note: "not found after sending" };
      } else return { waiting: true };
    }
    const ticket = llmTicketOf(sub, sent)!;
    const c = late ? await port.abandon(ticket) : await port.collect(ticket);
    if (c.status === "pending") return { waiting: true };
    const { truncated, ...rest } = c as BatchClosed;
    closed = await must(day.append("llm.batch.closed", closedPayload(sub, rest), [sub.seq]), "llm.batch.closed");
    if (rest.result !== "collected") {
      await fail(rest.errorCode, costOf(sub, closed));
      return { wrote: true, note: late ? "abandoned at the cutoff" : `closed as ${rest.result}` };
    }
    fresh = { output: rest.output, truncated: truncated === true };
  }
  if (pl(closed).result !== "collected") return {};
  const runs = day.events().filter((e) => e.type === "agent.run" && pl(e).batchSeq === closed.seq);
  if (runs.some((r) => pl(r).ok !== true)) return {};
  return decide(day, llm, a, sub, closed, runs, fresh, prompt);
}

async function decide(day: DayAccess, llm: LlmDeps, a: LlmInvestor, sub: LogEvent, closed: LogEvent, runs: LogEvent[], fresh: { output: string; truncated: boolean } | null, prompt: LlmPrompt): Promise<Settled> {
  const date = pl(sub).tradingDate as string;
  const startedAt = day.clock.now();
  const cost = costOf(sub, closed);
  const linked = { batchSeq: closed.seq, sentBodyHash: pl(sub).sentBodyHash };
  const run = (x: { purpose: "post" | "order"; inputSeqs: number[] } & ({ ok: true; outputHash: string } | { ok: false; errorCode: string })) =>
    must(day.append("agent.run", { ...llmRunPayload(a, { ...x, prompt, requestHash: pl(sub).sentBodyHash as string, startedAt, finishedAt: day.clock.now(), cost }), ...linked }, [...x.inputSeqs, closed.seq]), "agent.run");
  // 判断の記録は締めより前だけ（記録の検査）。締めを過ぎたら、その日は判断なし
  if (startedAt >= cutoffOf(date)) {
    if (runs.length > 0) return {};
    await must(day.append("agent.run", llmRunPayload(a, { prompt, inputSeqs: [], requestHash: pl(sub).sentBodyHash as string, startedAt, finishedAt: startedAt, ok: false, errorCode: "timeout", cost }), []), "agent.run");
    return { wrote: true, note: "the answer was not used before the cutoff" };
  }
  // 入力を①より前の記録から作り直し、送った本文と同じであることを確かめる
  const before = day.events().filter((e) => e.seq < sub.seq);
  const input = investorInputOf(before, { agentId: a.id, tradingDate: date, account: day.account(a.id), body: (h) => bodyText(day.values, h) });
  const { text, inputSeqs } = investorUserText(input);
  const at = pl(sub).submittedAt as number;
  const again = await llm.portOf(a.model.provider, { now: () => at }).prepare(investorRequest(a, { prompt, tradingDate: date, submittedAt: at, inputSeqs, userText: text, yenPerUsd: pl(sub).yenPerUsd as number }));
  if (again.sentBodyHash !== pl(sub).sentBodyHash || pl(sub).promptVersion !== prompt.version) {
    await run({ purpose: "order", inputSeqs: [], ok: false, errorCode: "provider_error" });
    return { wrote: true, note: "the input could not be rebuilt" };
  }
  // 出力：記録した run があればその出力（記録の形の判断）、なければ受け取った答え（なければ受け取り直す）
  let decision: InvestorDecision;
  const recorded = runs[0] ? bodyText(day.values, pl(runs[0]).outputHash as string) : null;
  if (recorded !== null) decision = JSON.parse(recorded) as InvestorDecision;
  else {
    if (!fresh) {
      const c = await llm.portOf(a.model.provider).collect(llmTicketOf(sub, llmSentOf(day.events(), sub.seq))!);
      if (c.status === "pending" || c.result !== "collected") return { waiting: true };
      fresh = { output: c.output, truncated: (c as BatchClosed).truncated === true };
    }
    const boards = input.symbols.map((s) => s.symbol);
    const parsed = parseInvestorOutput(fresh.output, { boards, truncated: fresh.truncated });
    let output: string | null = null;
    if (parsed.ok) {
      try {
        output = canonicalize(parsed.decision);
      } catch {
        output = null; // NFC でない文字・U+0000 など（D-045）
      }
    }
    if (!parsed.ok || output === null) {
      await run({ purpose: "order", inputSeqs, ok: false, errorCode: "invalid_output" });
      return { wrote: true, note: `invalid_output (${parsed.ok ? "text" : parsed.problem})` };
    }
    decision = JSON.parse(output) as InvestorDecision;
  }
  const output = canonicalize(decision);
  let wrote = false;
  const runSeq = async (purpose: "post" | "order") => {
    const r = runs.find((x) => pl(x).purpose === purpose);
    if (r) return r.seq;
    wrote = true;
    const outputHash = await day.values.putBody(output);
    return (await run({ purpose, inputSeqs, ok: true, outputHash })).seq;
  };
  if (decision.post && !isSuspended(day.events(), a.id, "posts")) {
    const postRun = await runSeq("post");
    if (!day.events().some((e) => e.type === "post.published" && pl(e).runSeq === postRun)) {
      const bodyHash = await day.values.putBody(decision.post.text);
      await must(day.post({ agentId: a.id, board: decision.post.board, bodyHash, citeSeqs: [], runSeq: postRun }, [postRun]), "post.published");
      wrote = true;
    }
  }
  // 試運転：注文票は書かない（commitSheet を持たない口）
  if (!day.commitSheet) return { wrote, note: "dry run (no order sheet)" };
  const orderRun = await runSeq("order");
  if (!day.events().some((e) => (e.type === "order_sheet.committed" || e.type === "order_sheet.rejected") && pl(e).runSeq === orderRun)) {
    await must(day.commitSheet(a.id, { tradingDate: date, orders: decision.orders, runSeq: orderRun, inputSeqs }), `commitSheet ${a.id}`);
    wrote = true;
  }
  return { wrote };
}
