// 検証役（#179、PR #193）：LLM のバッチの記録（llm.batch.submitted・llm.batch.closed）、agent.run の費用の項目、
// 1日の費用の上限の検査（src/events/llm-cost.ts）を壊しにいく。
// 期待は lead の決定（#179 のコメント「LLM を呼ぶ口の契約」）と D-041 の追記（1日100円＝1,000）から書く。
// 追記の処理（EventLog.append）と照合（admit）を通したログに、上限の検査をかける。欠陥の再現は it.fails。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { sealEvent, verifyChain } from "../../src/events/chain";
import { LLM_DAILY_COST_LIMIT, llmCostProblems, llmCostUsed, openLlmBatches } from "../../src/events/llm-cost";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/table";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0, ss = 0, ms = 0) =>
  Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}+09:00`);
const H = "c".repeat(64);
// 2026-11-23（月）は勤労感謝の日として休みにする
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set(["2026-11-23"]) };
const CTX = { holidayTables: new Map([[H, TABLE]]) };
const newLog = () => new EventLog({ ...CTX, accountOf: () => newAccount() });

async function ok(log: EventLog, d: Draft): Promise<LogEvent> {
  const r = await log.append(d);
  if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
  return r.event;
}
const reason = async (log: EventLog, d: Draft) => {
  const r = await log.append(d);
  return r.ok ? "ok" : r.reason;
};

/** 祝日の一覧と、AI 3体（11-09 月曜の朝に登録）のログ */
async function setup(agents = ["alpha", "beta", "gamma"]) {
  const log = newLog();
  await ok(log, { type: "holidays.adopted", recordedAt: 0, actor: "operator:owner", refs: [], payload: { holidaysSha256: H } });
  for (const agentId of agents) {
    await ok(log, { type: "agent.registered", recordedAt: jst("2026-11-09", 8), actor: "operator:owner", refs: [], payload: { agentId, startDate: "2026-11-09", initialCash: INITIAL_CASH } });
  }
  return log;
}

/** 1トークン＝0.1円ちょうどになる料金（1ドル160円で、1,000万トークンあたり625,000セント）。費用とトークン数を同じ数にできる */
const PRICE = { inputCentsPer10MTok: 625_000, outputCentsPer10MTok: 625_000 };

/** 上限のトークン数1・1でも予約が1で済む、ごく安い料金（maxCost 1 の予約に使う。2962eda で上限のトークン数は1以上） */
const CHEAP = { inputCentsPer10MTok: 1, outputCentsPer10MTok: 1 };
const sub = (at: number, agentId: string, tradingDate: string, maxCost: number, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.submitted",
  recordedAt: at,
  actor: "system",
  refs: [],
  payload: {
    agentId, provider: "anthropic", modelId: "m", promptVersion: "v1", sentBodyHash: "b".repeat(64), maxCost, tradingDate,
    submittedAt: at, yenPerUsd: 160, ...PRICE, maxInputTokens: 1, maxOutputTokens: 1, bodyMaxOutputTokens: 1, ...extra,
    // customId の末尾は「-」＋本文のハッシュの先頭16文字（PR #210 の 1ce37a0）。extra.customId は、その前の部分
    customId: `${String(extra.customId ?? `${agentId}-${tradingDate}`)}-${String(extra.sentBodyHash ?? "b".repeat(64)).slice(0, 16)}`,
  },
});
const close = (at: number, s: LogEvent, cost: number, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.closed",
  recordedAt: at,
  actor: "system",
  refs: [s.seq],
  payload: {
    batchSeq: s.seq, agentId: (s.payload as { agentId: string }).agentId, // 受け取り（collected）は入力・出力のトークン数がどちらも1以上（2962eda）。1トークン＝1なので、費用2以上なら入力1・出力（費用−1）にする
    result: "collected", cost, ...((extra.result ?? "collected") === "collected" && cost >= 2 ? { inputTokens: 1, outputTokens: cost - 1 } : { inputTokens: 0, outputTokens: cost }),
    ...(extra.costUnknown === true ? {} : PRICE), ...extra,
  },
});
/** ③ 送った記録（llm.batch.sent）。①（s）を指し、提供元のバッチのIDを足す */
const sent = (at: number, s: LogEvent, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.sent",
  recordedAt: at,
  actor: "system",
  refs: [s.seq],
  payload: { batchSeq: s.seq, agentId: (s.payload as { agentId: string }).agentId, provider: (s.payload as { provider: string }).provider, batchId: `batch_${s.seq}`, ...extra },
});
/** ① を書き、すぐに ③ も書く（送れた依頼）。① を返す */
async function okSent(log: EventLog, d: Draft): Promise<LogEvent> {
  const s = await ok(log, d);
  await ok(log, sent(d.recordedAt, s));
  return s;
}
const run = (at: number, extra: Record<string, unknown> = {}): Draft => ({
  type: "agent.run",
  recordedAt: at,
  actor: "system",
  refs: [],
  payload: { agentId: "alpha", purpose: "order", inputSeqs: [], ok: true, ...extra },
});

/** 保存済みのログ（連鎖だけ作り直したもの）を、新しい追記の処理で先頭から読み直す。最初の問題を返す */
async function admitAll(events: readonly LogEvent[]): Promise<string | null> {
  const log = newLog();
  for (const e of events) {
    const p = await log.admit(e);
    if (p) return p;
  }
  return null;
}
type Forge = Draft & { keys: string[] };
const draftOf = (e: LogEvent): Forge => ({ type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: e.payload as Record<string, unknown> });
async function forge(drafts: readonly Forge[]): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  for (const d of drafts) out.push(await sealEvent(out.at(-1) ?? null, d));
  return out;
}

const DAY = "2026-11-09";

describe("上限（1日1,000＝100円）を超えた使い方を、記録から隠せない", () => {
  // 2026-11-08 の lead の決定（送る前に予約を記録する）で、上限を超える予約は追記の時点で断るようになった（前は追記を通し、検査が挙げた）
  it("3体の予約の合計が上限を超える3つ目の予約は、追記で断る（送る前なので、その依頼は送られない）。ちょうど1,000は通る", async () => {
    const log = await setup();
    await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 400));
    await okSent(log, sub(jst(DAY, 16, 36), "beta", "2026-11-10", 400));
    expect(LLM_DAILY_COST_LIMIT).toBe(1000);
    const before = log.events.length;
    expect(await reason(log, sub(jst(DAY, 16, 37), "gamma", "2026-11-10", 201))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    expect(await log.canAppend(sub(jst(DAY, 16, 37), "gamma", "2026-11-10", 201))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    expect(log.events.length).toBe(before);
    await okSent(log, sub(jst(DAY, 16, 37), "gamma", "2026-11-10", 200));
    expect(llmCostUsed(log.events, DAY)).toBe(1000);
    expect(llmCostProblems(log.events)).toEqual([]);
  });

  it("上限を超える予約を足した保存済みのログ（DB に書ける者の改ざん）は、照合で落ち、上限の検査も挙げる", async () => {
    const log = await setup();
    await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 400));
    await okSent(log, sub(jst(DAY, 16, 36), "beta", "2026-11-10", 400));
    const d = log.events.map(draftOf);
    const extra = { ...sub(jst(DAY, 16, 37), "gamma", "2026-11-10", 201), keys: ["llmbatch:gamma:2026-11-10"] };
    const forged = await forge([...d, extra]);
    expect(await admitAll(forged)).toMatch(/daily LLM cost limit exceeded \(1001 > 1000\)/);
    expect(llmCostProblems(forged)).toEqual([
      { day: DAY, kind: "reservation", seq: forged.length, used: 1001, limit: 1000 },
      { day: DAY, kind: "total", seq: forged.length, used: 1001, limit: 1000 },
    ]);
  });

  it("予約の時点で収まっていても、実費が予約を超えた閉じた記録で合計が超えれば挙げる（翌朝に閉じても依頼した日に付く）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100));
    await okSent(log, sub(jst(DAY, 16, 36), "beta", "2026-11-10", 900));
    expect(llmCostProblems(log.events)).toEqual([]);
    await ok(log, close(jst("2026-11-10", 6, 50), a, 300));
    expect(llmCostUsed(log.events, DAY)).toBe(1200);
    expect(llmCostUsed(log.events, "2026-11-10")).toBe(0);
    // 出力のトークン数（299）が本文の出力の上限（1）を超えているので、output_tokens も挙がる（2962eda）
    expect(llmCostProblems(log.events).map((p) => p.kind)).toEqual(["total", "output_tokens"]);
  });

  it("閉じない依頼は、何日たっても予約のまま数え続ける（打ち切りを書かなくても枠は空かない）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 600));
    await okSent(log, sub(jst("2026-11-12", 16, 35), "beta", "2026-11-13", 10));
    expect(llmCostUsed(log.events, DAY)).toBe(600);
    expect(openLlmBatches(log.events).map((e) => e.seq)).toContain(a.seq);
  });

  // 前は「batchId が null の依頼」。新しい形では「③（送った記録）のない①」が、作られたか分からない依頼にあたる
  it("③のない①（送れたか分からない）は、予約した費用か、送っていないと確かなときの0でだけ閉じられ、閉じるまでは予約を数える", async () => {
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 700));
    expect(llmCostUsed(log.events, DAY)).toBe(700);
    const notSent = "a batch that was not sent can only close as failed";
    expect(await reason(log, close(jst(DAY, 16, 36), a, 0))).toBe(notSent);
    expect(await reason(log, close(jst(DAY, 16, 36), a, 0, { result: "expired" }))).toBe(notSent);
    expect(await reason(log, close(jst(DAY, 16, 36), a, 700, { result: "expired", costUnknown: true }))).toBe(notSent);
    expect(await reason(log, close(jst(DAY, 16, 36), a, 700, { result: "collected", costUnknown: true }))).toBe(notSent);
    // 0と予約のあいだの費用、トークン数のある費用0は書けない
    const zeroOrMax = "a batch that was not sent must cost 0 or the reserved maxCost";
    expect(await reason(log, close(jst(DAY, 16, 36), a, 1, { result: "failed" }))).toBe(zeroOrMax);
    expect(await reason(log, close(jst(DAY, 16, 36), a, 0, { result: "failed", inputTokens: 1 }))).toBe(zeroOrMax);
    expect(await reason(log, close(jst(DAY, 16, 36), a, 0, { result: "failed", cacheReadInputTokens: 1 }))).toBe(zeroOrMax);
    expect(await reason(log, close(jst(DAY, 16, 36), a, 699, { result: "failed", costUnknown: true }))).toBe("an unknown cost must be the reserved maxCost");
    await ok(log, close(jst(DAY, 16, 36), a, 700, { result: "failed", costUnknown: true }));
    // 予約した費用で閉じたので、その日の残りは300。301 の予約は断る
    expect(await reason(log, sub(jst(DAY, 16, 37), "beta", "2026-11-10", 301))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    await okSent(log, sub(jst(DAY, 16, 37), "beta", "2026-11-10", 300));
    expect(llmCostProblems(log.events)).toEqual([]);
  });

  it("③のない①を、送っていないとして費用0の failed で閉じると、その日の枠は空く（lead の決定のとおり）", async () => {
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 700));
    await ok(log, close(jst(DAY, 16, 36), a, 0, { result: "failed", notCreatedError: "timeout" }));
    expect(llmCostUsed(log.events, DAY)).toBe(0);
    // 閉じた①には③を書けない（閉じたあとに送ったことにして、0の費用を隠すことはできない）
    expect(await reason(log, sent(jst(DAY, 16, 37), a))).toBe("the batch is already closed");
    await okSent(log, sub(jst(DAY, 16, 37), "beta", "2026-11-10", 1000));
  });

  it("費用が分からない（costUnknown）として予約より少ない・多い費用で閉じることはできない（追記でも、連鎖を作り直した照合でも）", async () => {
    for (const cost of [0, 1, 599, 601, 10_000]) {
      const log = await setup();
      const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 600));
      expect(await reason(log, close(jst("2026-11-10", 8, 30), a, cost, { result: "expired", costUnknown: true })), String(cost)).toBe("an unknown cost must be the reserved maxCost");
    }
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 600));
    await ok(log, close(jst("2026-11-10", 8, 30), a, 600, { result: "expired", costUnknown: true }));
    const d = log.events.map(draftOf);
    const forged = await forge([...d.slice(0, -1), { ...d.at(-1)!, payload: { ...d.at(-1)!.payload, cost: 0 } }]);
    expect(await admitAll(forged)).toMatch(/an unknown cost must be the reserved maxCost/);
    // costUnknown を消して費用0の expired に書き換えた場合は、llm-batch-sent.test.ts の【高】の試験で扱う（③のある①を費用0で閉じられる穴）
  });

  it("1つの依頼は1回しか閉じられない。高い費用の閉じた記録のあとに安い費用でもう一度閉じても、数えるのは最初の1回", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 600));
    await ok(log, close(jst("2026-11-10", 6, 50), a, 900));
    expect(await reason(log, close(jst("2026-11-10", 7, 20), a, 2))).toMatch(new RegExp(`duplicate key llmclosed:${a.seq}$`));
    // 一意キーを付けずに2つ目を足した保存済みログ（DBに書ける者の改ざん）は、照合でキーを作り直すので落ちる
    const second = { ...draftOf(log.events.at(-1)!), recordedAt: jst("2026-11-10", 7, 20), keys: [], payload: { ...(log.events.at(-1)!.payload as object), cost: 2, outputTokens: 1 } };
    const forged = await forge([...log.events.map(draftOf), second]);
    expect(await admitAll(forged)).toMatch(new RegExp(`duplicate key llmclosed:${a.seq}$`));
    const withKey = await forge([...log.events.map(draftOf), { ...second, keys: [`llmclosed:${a.seq}`] }]);
    expect(await verifyChain(withKey)).toContainEqual(expect.stringMatching(new RegExp(`duplicate key llmclosed:${a.seq}$`)));
    expect(llmCostUsed(forged, DAY)).toBe(900);
  });

  it("同じ AI・同じ取引日の2つ目の依頼（予約を分けて小さく見せる）は書けない", async () => {
    const log = await setup();
    await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 500));
    expect(await reason(log, sub(jst(DAY, 16, 36), "alpha", "2026-11-10", 500, { customId: "other" }))).toMatch(/duplicate key llmbatch:alpha:2026-11-10$/);
  });
});

describe("閉じた記録が指す依頼", () => {
  it("まだない依頼・自分自身・依頼でない記録・別の AI の依頼は指せない", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100));
    const b = await okSent(log, sub(jst(DAY, 16, 36), "beta", "2026-11-10", 100));
    const next = log.events.length + 1;
    const draft = (batchSeq: number, agentId = "alpha"): Draft => ({ type: "llm.batch.closed", recordedAt: jst(DAY, 17), actor: "system", refs: [batchSeq], payload: { batchSeq, agentId, result: "collected", cost: 1, inputTokens: 0, outputTokens: 0 } });
    expect(await reason(log, draft(next))).toBe(`payload refers to ${next} outside refs`);
    expect(await reason(log, draft(next + 5))).toBe(`payload refers to ${next + 5} outside refs`);
    expect(await reason(log, draft(0))).toBe("payload refers to 0 outside refs");
    expect(await reason(log, draft(2))).toBe("batchSeq must be llm.batch.submitted of the same agent");
    expect(await reason(log, draft(b.seq))).toBe("batchSeq must be llm.batch.submitted of the same agent");
    expect(await reason(log, draft(a.seq, "beta"))).toBe("batchSeq must be llm.batch.submitted of the same agent");
    expect(await reason(log, draft(a.seq, "delta"))).toBe("unknown agent delta");
  });

  it("閉じた記録を依頼より前に入れ替えた保存済みログは、照合で落ちる", async () => {
    const log = await setup();
    // ③のない①を送れなかったとして閉じる（①と閉じた記録が隣り合うように）
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100));
    await ok(log, close(jst(DAY, 16, 35), a, 0, { result: "failed", notCreatedError: "timeout" }));
    const d = log.events.map(draftOf);
    // 連鎖を作り直すこと自体ができない（refs は前の記録しか指せない）。refs を消して作り直しても、中身の batchSeq が refs にないので照合で落ちる
    await expect(forge([...d.slice(0, -2), d.at(-1)!, d.at(-2)!])).rejects.toThrow(/refs must point to earlier events/);
    const swapped = await forge([...d.slice(0, -2), { ...d.at(-1)!, refs: [] }, d.at(-2)!]);
    expect(await admitAll(swapped)).not.toBeNull();
  });

  it("閉じた記録の時刻は、依頼の記録より前にできない（時刻は戻らない）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100));
    expect(await reason(log, close(jst(DAY, 16, 34), a, 50))).toMatch(/recordedAt goes backwards/);
  });

  it("閉じた記録に取引日や日付を足して、別の日の分に見せることはできない（知らない項目）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100));
    for (const extra of [{ tradingDate: "2026-11-11" }, { day: "2026-11-10" }, { maxCost: 1 }, { costunknown: true }]) {
      expect(await reason(log, close(jst(DAY, 17), a, 50, extra)), JSON.stringify(extra)).toBe("unknown field in a batch closing");
    }
  });
});

describe("書ける者", () => {
  it("依頼と閉じた記録は system だけ。AI 自身や運営者、別の AI の名では書けない", async () => {
    const log = await setup();
    for (const actor of ["agent:alpha", "agent:beta", "operator:owner"] as const) {
      expect(await reason(log, { ...sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100), actor }), actor).toBe("llm.batch.submitted must be written by system");
    }
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100));
    for (const actor of ["agent:alpha", "operator:owner"] as const) {
      expect(await reason(log, { ...close(jst(DAY, 17), a, 1), actor }), actor).toBe("llm.batch.closed must be written by system");
    }
    // 送った記録（③）も system だけ
    const b = await ok(log, sub(jst(DAY, 16, 35), "beta", "2026-11-10", 100));
    for (const actor of ["agent:beta", "agent:alpha", "operator:owner"] as const) {
      expect(await reason(log, { ...sent(jst(DAY, 17), b), actor }), actor).toBe("llm.batch.sent must be written by system");
    }
    // 保存済みログで書いた者を AI に書き換えても、照合で落ちる
    await ok(log, close(jst(DAY, 17), a, 2));
    const d = log.events.map(draftOf);
    expect(await admitAll(await forge([...d.slice(0, -1), { ...d.at(-1)!, actor: "agent:alpha" }]))).toMatch(/must be written by system/);
  });
});

describe("日本時間の0時の境目と取引日", () => {
  it("23:59:59.999 の依頼はその日に、00:00:00.000 の依頼は翌日に数える。どちらも取引日は同じ次の営業日（締め前）", async () => {
    const log = await setup();
    await okSent(log, sub(jst(DAY, 23, 59, 59, 999), "alpha", "2026-11-10", 600));
    await okSent(log, sub(jst("2026-11-10", 0, 0), "beta", "2026-11-10", 600));
    expect(llmCostUsed(log.events, DAY)).toBe(600);
    expect(llmCostUsed(log.events, "2026-11-10")).toBe(600);
    expect(llmCostProblems(log.events)).toEqual([]);
    // 同じ AI は、日をまたいでも同じ取引日にもう1回は頼めない
    expect(await reason(log, sub(jst("2026-11-10", 0, 1), "alpha", "2026-11-10", 1, { ...CHEAP, customId: "x2" }))).toMatch(/duplicate key llmbatch:alpha:2026-11-10$/);
  });

  // D-047（#228）：11/9 からは、架空の市場は土日・祝日も取引日。取引日は「締めがまだ来ていない最初の暦日」になる
  it("取引日は、記録の時刻で締めがまだ来ていない最初の取引日だけ（前日・当日の締め後・2日先は断る。11/9 以後は土日・祝日も取引日）", async () => {
    const log = await setup();
    const at = jst(DAY, 16, 35);
    for (const td of ["2026-11-09", "2026-11-11", "2026-11-08", "2026-11-14"]) {
      expect(await reason(log, sub(at, "alpha", td, 100)), td).toBe("tradingDate must be the next trading date");
    }
    // 金曜の夜 23:59 は土曜（11-21）。月曜（祝日）・火曜は断る
    for (const td of ["2026-11-23", "2026-11-24"]) {
      expect(await reason(log, sub(jst("2026-11-20", 23, 59), "alpha", td, 100)), td).toBe("tradingDate must be the next trading date");
    }
    await okSent(log, sub(jst("2026-11-20", 23, 59), "alpha", "2026-11-21", 100));
    // 土曜の 00:00 も、締め（8:30）の前なので土曜
    await okSent(log, sub(jst("2026-11-21", 0, 0), "beta", "2026-11-21", 100));
    // 日曜の夜の依頼は、祝日の月曜（11-23）の分
    await okSent(log, sub(jst("2026-11-22", 16, 35), "alpha", "2026-11-23", 100));
    // 当日 8:30 ちょうどは締めのあと。次の日の分になる
    expect(await reason(log, sub(jst("2026-11-24", 8, 30), "gamma", "2026-11-24", 100))).toBe("tradingDate must be the next trading date");
    await okSent(log, sub(jst("2026-11-24", 8, 29, 59, 999), "gamma", "2026-11-24", 100));
  });

  // 前は「一覧の外の時刻では書けない」を確かめていた。D-047 で、11/9 以後の取引日は祝日の一覧を引かなくなったので、
  // 一覧の範囲の外の年（2027年の年末から2028年）でも、締めと受け付けの時間が合えば書ける（core の PR #230 の振る舞い）。
  // これでよいかは lead の判断待ち（#228）。決まりが「一覧の外は断る」になったら、この試験を前の期待に戻す
  it("11/9 以後の時刻は、祝日の一覧の範囲の外でも、締めと受け付けの時間で取引日が決まる（lead の判断待ち）", async () => {
    const log = await setup();
    // 2027-12-30 16:35 の次の取引日は 12-31（年末も取引日）。2028-01-04 は断る
    expect(await reason(log, sub(jst("2027-12-30", 16, 35), "alpha", "2028-01-04", 100))).toBe("tradingDate must be the next trading date");
    await okSent(log, sub(jst("2027-12-30", 16, 35), "alpha", "2027-12-31", 100));
    // 一覧の外の年（2028年）の取引日も書ける
    await okSent(log, sub(jst("2028-01-03", 16, 35), "beta", "2028-01-04", 100));
    // 受け付けの始まり（前の取引日の引け 16:30）より前は、一覧の外でも断る
    expect(await reason(log, sub(jst("2028-01-03", 16, 29, 59, 999), "gamma", "2028-01-04", 100))).toBe("submittedAt must be after the close of the previous trading day");
  });
});

describe("知らない項目と、オブジェクトの特別な名前", () => {
  it("JSON から読んだ __proto__ や constructor の項目は、知らない項目として断る（例外にならない）", async () => {
    const log = await setup();
    const base = sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100);
    for (const json of ['{"__proto__":{"maxCost":1}}', '{"constructor":1}', '{"toString":1}']) {
      // スプレッドでは __proto__ は自分の項目として写らないので、JSON.parse の結果をそのまま使う
      const raw = JSON.parse(JSON.stringify(base.payload).replace(/}$/, `,${json.slice(1, -1)}}`)) as Record<string, unknown>;
      expect(await reason(log, { ...base, payload: raw }), json).toBe("unknown field in a batch submission");
    }
  });

  it("依頼の中身の項目が欠けていれば断る", async () => {
    const log = await setup();
    const base = sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100).payload;
    for (const k of ["provider", "modelId", "promptVersion", "sentBodyHash", "customId", "maxCost", "submittedAt", "yenPerUsd", "inputCentsPer10MTok", "outputCentsPer10MTok", "maxInputTokens", "maxOutputTokens"]) {
      const payload = { ...base };
      delete payload[k];
      expect(await reason(log, { ...sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100), payload }), k).not.toBe("ok");
    }
  });

  it("送る前の予約（①）は、提供元のバッチのIDを持てない（文字列でも null でも、知らない項目として断る）", async () => {
    const log = await setup();
    for (const batchId of ["batch_1", null, "", undefined]) {
      const d = sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100, { batchId });
      expect(await reason(log, d), String(batchId)).toBe("unknown field in a batch submission");
    }
  });

  it("予約の費用に、大きすぎる数・小数・負のゼロ・文字列は使えない", async () => {
    for (const maxCost of [2 ** 53, 1e21, 0.5, -0, Infinity, Number.NaN, "100", true, null]) {
      const log = await setup();
      expect(await reason(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", maxCost as number)), String(maxCost)).not.toBe("ok");
    }
  });
});

describe("これまでの記録と agent.run の費用の項目", () => {
  it("新しい項目のない、これまでの形のログは、照合（replay）を通り、使用済みは0で、上限の問題もない", async () => {
    const log = await setup();
    await ok(log, run(jst(DAY, 16, 35)));
    await ok(log, run(jst(DAY, 16, 36), { ok: false, errorCode: "timeout" }));
    await ok(log, run(jst(DAY, 16, 37), { purpose: "post" }));
    await expect(replay(log.events, { get: () => undefined }, CTX)).resolves.toBeDefined();
    expect(await admitAll(log.events)).toBeNull();
    expect(llmCostUsed(log.events, DAY)).toBe(0);
    expect(llmCostProblems(log.events)).toEqual([]);
  });

  it("agent.run の費用・トークン数に、負・小数・大きすぎる数・文字列・真偽値・配列・null は使えない（追記でも照合でも）", async () => {
    const BAD: Record<string, unknown>[] = [];
    for (const f of ["cost", "inputTokens", "outputTokens"]) for (const v of [-1, 0.1, 2 ** 53, 1e21, Infinity, Number.NaN, "1", true, [], {}, null]) BAD.push({ [f]: v });
    for (const v of [0, -0, -1, 0.5, 2 ** 53, "150", null]) BAD.push({ maxCost: v });
    for (const v of ["A".repeat(64), "a".repeat(63), `${"a".repeat(64)}\n`, "", null, 0]) BAD.push({ sentBodyHash: v });
    const log = await setup();
    for (const extra of BAD) expect(await reason(log, run(jst(DAY, 16, 35), extra)), JSON.stringify(extra) ?? String(extra)).not.toBe("ok");
    // 保存済みログで、正しい値を悪い値に書き換えても照合で落ちる
    await ok(log, run(jst(DAY, 16, 35), { maxCost: 150, cost: 40, inputTokens: 1, outputTokens: 1, sentBodyHash: "a".repeat(64) }));
    const d = log.events.map(draftOf);
    for (const extra of [{ cost: -1 }, { maxCost: 0 }, { inputTokens: "1" }, { sentBodyHash: "A".repeat(64) }]) {
      expect(await admitAll(await forge([...d.slice(0, -1), { ...d.at(-1)!, payload: { ...d.at(-1)!.payload, ...extra } }])), JSON.stringify(extra)).not.toBeNull();
    }
  });

  it("負のゼロの費用は0として記録され、照合でも同じハッシュになる", async () => {
    const log = await setup();
    const e = await ok(log, run(jst(DAY, 16, 35), { cost: -0 }));
    expect(Object.is((e.payload as { cost: number }).cost, -0) || (e.payload as { cost: number }).cost === 0).toBe(true);
    const stored = JSON.parse(JSON.stringify(log.events)) as LogEvent[];
    expect(await admitAll(stored)).toBeNull();
  });

  // 【判断待ち・中】上限の検査は llm.batch.* だけを数え、agent.run の cost は数えない。
  // 今の契約に残る1回ずつ呼ぶ口（LlmPort.complete）を使った分は、agent.run にしか費用が残らないので、
  // 記録からの検査では、1日100円を超えても見つからない。lead の決定の「その日の使用済み」が batch だけでよいかを決めてもらう。
  // （バッチを使った実行の agent.run にも費用が入るなら、両方を足すと二重に数えるので、直し方は lead の判断による）
  it.fails("【判断待ち】バッチを使わずに呼んだ agent.run の費用が1日1,000を超えたら、上限の検査が挙げる（今は挙げない）", async () => {
    const log = await setup();
    await ok(log, run(jst(DAY, 16, 35), { maxCost: 1500, cost: 1500, inputTokens: 1, outputTokens: 1, sentBodyHash: "a".repeat(64) }));
    expect(llmCostUsed(log.events, DAY)).toBe(1500);
    expect(llmCostProblems(log.events)).not.toEqual([]);
  });
});
