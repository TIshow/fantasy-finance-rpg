// LLM の AI 投資家の受け取りと判断の段（翌朝 06:50・07:20 の実行。#179）。
// 取引日が date 以前で、まだ片づいていない依頼（①）ごとに：③がなければ提供元で探す → 受け取る（締めを過ぎていれば打ち切る）→
// 閉じた記録を書く → 出力を読み、判断の記録・投稿・注文票を書く。出力が形に合わない・上限で切れたら agent.run の失敗（invalid_output）を残し、
// その日は注文しない。回し直しても同じ記録を二重に書かない（失敗の記録は、参照に①か閉じた記録の seq を持たせ、それで見つける）。
// 試運転（policy.dryRun）の間も、注文の判断の記録（agent.run）は書く。注文票だけを書かない（commitSheet を持たない口しか受け取らない）。
// 入力は、①より前の記録から作り直し、送った本文のハッシュと同じであることを確かめてから使う（入力の seq を記録に残すため）。
import type { LlmBatchClosed, LlmPrompt } from "../contracts";
import { canonicalize } from "../events/canonical";
import { llmReservationOf, llmSentOf, llmTicketOf } from "../events/llm-cost";
import type { LogEvent } from "../events/types";
import { cutoffOf, previousBusinessDay } from "../ledger/ledger";
import type { BatchClosed } from "../llm/batch-port";
import { investorPrompt, investorUserText } from "../llm/investor-prompt";
import { type InvestorDecision, parseInvestorOutput } from "../llm/investor-output";
import { type LlmInvestor, investorRequest } from "./llm-agents";
import { investorInputOf } from "./llm-input";
import { type DayAccess, type LlmDeps, type LlmStageResult, bodyText, errorText, isSuspended, LocalCopyError, llmRunPayload, must } from "./llm-stage";

/** ③のない①を、閉じずに探し続ける時間（送る時間の上限10分＋一覧への反映の余裕30分。契約の LlmFindResult） */
export const FIND_GRACE_MS = 40 * 60_000;

type Payload = Record<string, unknown>;
const pl = (e: LogEvent) => e.payload as Payload;

/** 判断の途中で締めを過ぎ、記録が断られた */
class CutoffPassed extends Error {}

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

const closedOf = (events: readonly LogEvent[], sub: LogEvent) => events.find((e) => e.type === "llm.batch.closed" && pl(e).batchSeq === sub.seq);

/** その依頼の注文の判断の記録：閉じた記録に結びついた run（batchSeq）か、失敗の run（参照に①か閉じた記録の seq） */
function orderRunOf(events: readonly LogEvent[], sub: LogEvent, closed: LogEvent): LogEvent | undefined {
  return events.find(
    (e) => e.type === "agent.run" && pl(e).agentId === pl(sub).agentId && pl(e).purpose === "order" && (pl(e).batchSeq === closed.seq || (pl(e).ok === false && (e.refs.includes(sub.seq) || e.refs.includes(closed.seq)))),
  );
}

/**
 * 片づいた依頼か：閉じていて、注文の判断の記録がある（成功なら、注文票まで書いた。試運転か締めのあとなら記録だけでよい）。
 * 見つからないまま予約した費用で閉じた依頼は、締めまでは片づいていない（見つけたら取り消しを頼む）
 */
function settled(events: readonly LogEvent[], sub: LogEvent, now: number, dryRun: boolean): boolean {
  const closed = closedOf(events, sub);
  if (!closed) return false;
  if (pl(closed).costUnknown === true && !llmSentOf(events, sub.seq) && now < cutoffOf(pl(sub).tradingDate as string)) return false;
  const run = orderRunOf(events, sub, closed);
  if (!run) return false;
  // 締めを過ぎたら、注文票はもう書けない
  if (pl(run).ok !== true || dryRun || now >= cutoffOf(pl(sub).tradingDate as string)) return true;
  return events.some((e) => (e.type === "order_sheet.committed" || e.type === "order_sheet.rejected") && pl(e).runSeq === run.seq);
}

/**
 * 受け取りと判断の段。date は取引日。取引日が date 以前の、片づいていない依頼を扱う（前の取引日に回し忘れた依頼も、ここで閉じる）。
 * 締め（8:30）を過ぎて答えがなければ打ち切り、その日は注文なし（記録に残す）。試運転かどうかは llm.policy.dryRun で決める。
 * 依頼（①）ごとに例外を受け、ほかの依頼・ほかのAIは続ける（段の結果は "error: " で始める）
 */
export async function llmCollect(day: DayAccess, llm: LlmDeps, date: string): Promise<LlmStageResult> {
  const stage = "llm.collect";
  const notes: string[] = [];
  const errors: string[] = [];
  const waiting: string[] = [];
  let wrote = false;
  const prompt = await investorPrompt();
  for (const a of llm.investors) {
    const subs = day.events().filter((e) => e.type === "llm.batch.submitted" && pl(e).agentId === a.id && (pl(e).tradingDate as string) <= date);
    // 例外は①ごとに受ける（古い①で例外が続いても、今日の①は進める）。保管に書けたのに写しに当てられなかったときは、段ごと止める
    for (const sub of subs) {
      try {
        if (settled(day.events(), sub, day.clock.now(), llm.policy.dryRun)) continue;
        const r = await settle(day, llm, a, sub, prompt);
        if (r.wrote) wrote = true;
        if (r.waiting) waiting.push(a.id);
        if (r.note) notes.push(`${a.id}:${r.note}`);
      } catch (e) {
        if (e instanceof LocalCopyError) throw e;
        errors.push(`${a.id}#${sub.seq}: ${errorText(e)}`);
      }
    }
  }
  const rest = [...notes, ...(waiting.length > 0 ? [`waiting: ${waiting.join(",")}`] : [])].join("; ");
  const detail = errors.length > 0 ? `error: ${errors.join("; ")}${rest ? `; ${rest}` : ""}` : rest || undefined;
  const status = wrote ? "written" : errors.length > 0 ? "skipped" : waiting.length > 0 ? "waiting" : "done";
  return { stage, status, ...(detail ? { detail } : {}) };
}

type Settled = { wrote?: boolean; waiting?: boolean; note?: string };

async function settle(day: DayAccess, llm: LlmDeps, a: LlmInvestor, sub: LogEvent, prompt: LlmPrompt): Promise<Settled> {
  const date = pl(sub).tradingDate as string;
  const now = day.clock.now();
  const late = now >= cutoffOf(date);
  const port = llm.portOf(a.model.provider);
  // 閉じたのに判断を使えない依頼の失敗の run。参照に①と閉じた記録の seq を持たせ、回し直しではそれで見つける（二重に書かない）
  const fail = async (closed: LogEvent, errorCode: string) => {
    if (orderRunOf(day.events(), sub, closed)) return;
    const payload = llmRunPayload(a, { prompt, inputSeqs: [], requestHash: pl(sub).sentBodyHash as string, startedAt: now, finishedAt: day.clock.now(), ok: false, errorCode, cost: costOf(sub, closed) });
    await must(day.append("agent.run", payload, [sub.seq, closed.seq]), "agent.run");
  };
  let closed = closedOf(day.events(), sub);
  // 見つからないまま予約した費用で閉じた依頼も、締めまでは探し続け、見つけたら取り消しを頼む（返った結果は記録しない。契約の LlmFindResult）
  if (closed && pl(closed).costUnknown === true && !llmSentOf(day.events(), sub.seq) && !late) {
    const f = await port.find(llmReservationOf(sub));
    if (f.status === "found") await port.abandon({ ...llmReservationOf(sub), batchId: f.batchId });
    await fail(closed, "provider_error");
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
        closed = await must(day.append("llm.batch.closed", { batchSeq: sub.seq, agentId: a.id, result: "failed", cost: pl(sub).maxCost, costUnknown: true, inputTokens: 0, outputTokens: 0 }, [sub.seq]), "llm.batch.closed");
        await fail(closed, "provider_error");
        return { wrote: true, note: "not found after sending" };
      } else return { waiting: true };
    }
    const ticket = llmTicketOf(sub, sent)!;
    const c = late ? await port.abandon(ticket) : await port.collect(ticket);
    if (c.status === "pending") return { waiting: true };
    const { truncated, ...rest } = c as BatchClosed;
    closed = await must(day.append("llm.batch.closed", closedPayload(sub, rest), [sub.seq]), "llm.batch.closed");
    if (rest.result !== "collected") {
      await fail(closed, rest.errorCode);
      return { wrote: true, note: late ? "abandoned at the cutoff" : `closed as ${rest.result}` };
    }
    fresh = { output: rest.output, truncated: truncated === true };
  }
  if (pl(closed).result !== "collected") {
    // 閉じたあと、失敗の run を書く前に止まった依頼
    await fail(closed, pl(closed).costUnknown === true ? "provider_error" : "timeout");
    return { wrote: true };
  }
  const runs = day.events().filter((e) => e.type === "agent.run" && pl(e).batchSeq === closed.seq);
  if (runs.some((r) => pl(r).ok !== true)) return {};
  try {
    return await decide(day, llm, a, sub, closed, runs, fresh, prompt);
  } catch (e) {
    if (!(e instanceof CutoffPassed)) throw e;
    // 判断の途中で締めを過ぎた：注文の判断の記録がまだなければ、その日は判断なしとして残す
    return (await timeout(day, a, sub, closed, prompt)) ? { wrote: true, note: "the cutoff passed while deciding" } : { note: "the cutoff passed before the order sheet" };
  }
}

/** 締めまでに判断を使えなかった失敗の run（締めのあとなので batchSeq は持てない。参照に①と閉じた記録の seq） */
async function timeout(day: DayAccess, a: LlmInvestor, sub: LogEvent, closed: LogEvent, prompt: LlmPrompt): Promise<boolean> {
  if (orderRunOf(day.events(), sub, closed)) return false;
  const at = day.clock.now();
  await must(day.append("agent.run", llmRunPayload(a, { prompt, inputSeqs: [], requestHash: pl(sub).sentBodyHash as string, startedAt: at, finishedAt: at, ok: false, errorCode: "timeout", cost: costOf(sub, closed) }), [sub.seq, closed.seq]), "agent.run");
  return true;
}

async function decide(day: DayAccess, llm: LlmDeps, a: LlmInvestor, sub: LogEvent, closed: LogEvent, runs: LogEvent[], fresh: { output: string; truncated: boolean } | null, prompt: LlmPrompt): Promise<Settled> {
  const date = pl(sub).tradingDate as string;
  const cutoff = cutoffOf(date);
  const startedAt = day.clock.now();
  const cost = costOf(sub, closed);
  const linked = { batchSeq: closed.seq, sentBodyHash: pl(sub).sentBodyHash };
  // 締めを過ぎて断られたら CutoffPassed（呼び出し元が timeout の失敗にする）。ほかの理由で断られたら例外
  const write = async (r: Promise<{ ok: true; event: LogEvent } | { ok: false; reason: string }>, what: string) => {
    const x = await r;
    if (x.ok) return x.event;
    if (day.clock.now() >= cutoff) throw new CutoffPassed(what);
    throw new Error(`${what}: ${x.reason}`);
  };
  const run = (x: { purpose: "post" | "order"; inputSeqs: number[] } & ({ ok: true; outputHash: string } | { ok: false; errorCode: string })) =>
    write(day.append("agent.run", { ...llmRunPayload(a, { ...x, prompt, requestHash: pl(sub).sentBodyHash as string, startedAt, finishedAt: day.clock.now(), cost }), ...linked }, [...x.inputSeqs, closed.seq]), "agent.run");
  // 判断の記録は締めより前だけ（記録の検査）。締めを過ぎたら、その日は判断なし
  if (startedAt >= cutoff) {
    if (runs.length > 0) throw new CutoffPassed("after the cutoff");
    await timeout(day, a, sub, closed, prompt);
    return { wrote: true, note: "the answer was not used before the cutoff" };
  }
  // 入力を①より前の記録から作り直し、送った本文と同じであることを確かめる
  const before = day.events().filter((e) => e.seq < sub.seq);
  const at = pl(sub).submittedAt as number;
  const prev = previousBusinessDay(date, day.holidays());
  const input = investorInputOf(before, { agentId: a.id, tradingDate: date, prev, submittedAt: at, account: day.account(a.id), body: (h) => bodyText(day.values, h) });
  const { text, inputSeqs } = investorUserText(input);
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
        output = null; // 正規化した JSON にできない値（parseInvestorOutput の文字の決まりをすり抜けたもの）
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
      // 引用は、規則で動くAIと同じく、入力のうち終値の記録（上場した銘柄だけの日は空）
      const citeSeqs = inputSeqs.filter((seq) => day.events()[seq - 1]?.type === "prices.close");
      await write(day.post({ agentId: a.id, board: decision.post.board, bodyHash, citeSeqs, runSeq: postRun }, [postRun, ...citeSeqs]), "post.published");
      wrote = true;
    }
  }
  // 注文の判断の記録は、投稿の有無・試運転によらず書く（その日の判断が片づいた印にもなる）
  const orderRun = await runSeq("order");
  // 試運転：注文票は書かない（commitSheet を持たない口）
  if (!day.commitSheet) return { wrote, note: "dry run (no order sheet)" };
  if (!day.events().some((e) => (e.type === "order_sheet.committed" || e.type === "order_sheet.rejected") && pl(e).runSeq === orderRun)) {
    await write(day.commitSheet(a.id, { tradingDate: date, orders: decision.orders, runSeq: orderRun, inputSeqs }), `commitSheet ${a.id}`);
    wrote = true;
  }
  return { wrote };
}
