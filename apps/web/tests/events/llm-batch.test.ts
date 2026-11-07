// LLM のバッチの記録（llm.batch.submitted・llm.batch.closed）と、agent.run の費用の任意の項目（#179）。
// 追記でも照合（admit・replay）でも同じ検査が効くこと。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { sealEvent } from "../../src/events/chain";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/index";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const H = "a".repeat(64);
const table: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set() };
const CTX = { holidayTables: new Map([[H, table]]) };

async function ok(log: EventLog, d: Draft) {
  const r = await log.append(d);
  if (!r.ok) throw new Error(r.reason);
  return r.event;
}

const reason = async (log: EventLog, d: Draft) => {
  const r = await log.append(d);
  return r.ok ? "ok" : r.reason;
};

/** 祝日の一覧と、AI 3体（2026-11-09 月曜の朝に登録。開始日は 11-10）のログ */
async function setup(agents = ["alpha", "beta", "gamma"]) {
  const log = new EventLog({ ...CTX, accountOf: () => newAccount() });
  await ok(log, { type: "holidays.adopted", recordedAt: 0, actor: "operator:owner", refs: [], payload: { holidaysSha256: H } });
  for (const agentId of agents) {
    await ok(log, { type: "agent.registered", recordedAt: jst("2026-11-09", 10), actor: "operator:owner", refs: [], payload: { agentId, startDate: "2026-11-10", initialCash: INITIAL_CASH } });
  }
  return log;
}

/** 依頼の記録。既定は alpha が 11-09 16:35 に、11-10 の判断を 150（15円）の予約で依頼したもの */
const submitted = (at: number, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.submitted",
  recordedAt: at,
  actor: "system",
  refs: [],
  payload: {
    agentId: "alpha",
    provider: "anthropic",
    modelId: "claude-sonnet-5-5",
    promptVersion: "v1",
    sentBodyHash: "b".repeat(64),
    batchId: "msgbatch_01",
    customId: "alpha-2026-11-10",
    maxCost: 150,
    tradingDate: "2026-11-10",
    ...extra,
  },
});

const closed = (at: number, batchSeq: number, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.closed",
  recordedAt: at,
  actor: "system",
  refs: [batchSeq],
  payload: { batchSeq, agentId: "alpha", result: "collected", cost: 40, inputTokens: 20_000, outputTokens: 1_500, ...extra },
});

const run = (extra: Record<string, unknown>): Draft => ({
  type: "agent.run",
  recordedAt: jst("2026-11-10", 7),
  actor: "system",
  refs: [],
  payload: { agentId: "alpha", purpose: "order", inputSeqs: [], ok: true, ...extra },
});

/** 中身を差し替えて連鎖を作り直したログ（追記の処理を通らずに保存されたもの）を、照合に通す */
async function admitForged(events: readonly LogEvent[], seq: number, payload: Record<string, unknown>): Promise<string | null> {
  const out: LogEvent[] = [];
  for (const e of events) out.push(await sealEvent(out.at(-1) ?? null, { type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: e.seq === seq ? payload : e.payload }));
  const fresh = new EventLog({ ...CTX, accountOf: () => newAccount() });
  for (const e of out) {
    const problem = await fresh.admit(e);
    if (problem) return problem;
  }
  return null;
}

describe("llm.batch.submitted", () => {
  it("書ける。一意キーは llmbatch:<AIのID>:<取引日>。同じ AI・同じ取引日は2回書けない", async () => {
    const log = await setup();
    const e = await ok(log, submitted(jst("2026-11-09", 16, 35)));
    expect(e.keys).toEqual(["llmbatch:alpha:2026-11-10"]);
    expect(await reason(log, submitted(jst("2026-11-09", 16, 40), { batchId: "msgbatch_02" }))).toMatch(/duplicate key llmbatch:alpha:2026-11-10/);
    // 別の AI なら書ける
    await ok(log, submitted(jst("2026-11-09", 16, 40), { agentId: "beta", provider: "openai" }));
  });

  it("取引日は、記録した時刻で締めがまだ来ていない最初の営業日だけ（金曜の夕方なら月曜。8:30 より前なら当日）", async () => {
    const log = await setup();
    expect(await reason(log, submitted(jst("2026-11-09", 16, 35), { tradingDate: "2026-11-11" }))).toBe("tradingDate must be the next trading date");
    expect(await reason(log, submitted(jst("2026-11-09", 16, 35), { tradingDate: "2026-11-09" }))).toBe("tradingDate must be the next trading date");
    await ok(log, submitted(jst("2026-11-10", 8, 29), { tradingDate: "2026-11-10" }));
    expect(await reason(log, submitted(jst("2026-11-10", 8, 30), { agentId: "beta", tradingDate: "2026-11-10" }))).toBe("tradingDate must be the next trading date");
    await ok(log, submitted(jst("2026-11-13", 16, 35), { agentId: "beta", tradingDate: "2026-11-16" }));
  });

  it("書けるのは system だけ。登録していない AI、祝日の一覧がないときは書けない", async () => {
    const log = await setup();
    expect(await reason(log, { ...submitted(jst("2026-11-09", 16, 35)), actor: "agent:alpha" })).toBe("llm.batch.submitted must be written by system");
    expect(await reason(log, { ...submitted(jst("2026-11-09", 16, 35)), actor: "operator:owner" })).toBe("llm.batch.submitted must be written by system");
    expect(await reason(log, submitted(jst("2026-11-09", 16, 35), { agentId: "delta" }))).toBe("unknown agent delta");
    const empty = new EventLog({ ...CTX, accountOf: () => newAccount() });
    expect(await reason(empty, submitted(jst("2026-11-09", 16, 35)))).toMatch(/unknown agent alpha|no holiday table adopted/);
  });

  it("batchId は null（作られたか分からない依頼）でもよい", async () => {
    const log = await setup();
    await ok(log, submitted(jst("2026-11-09", 16, 35), { batchId: null }));
  });

  const BAD: [Record<string, unknown>, string][] = [
    [{ extra: 1 }, "unknown field in a batch submission"],
    [{ provider: "" }, "provider, modelId and promptVersion are required (up to 100 characters)"],
    [{ modelId: 5 }, "provider, modelId and promptVersion are required (up to 100 characters)"],
    [{ promptVersion: "x".repeat(101) }, "provider, modelId and promptVersion are required (up to 100 characters)"],
    [{ sentBodyHash: "B".repeat(64) }, "sentBodyHash must be a SHA-256 hex digest"],
    [{ sentBodyHash: "b".repeat(63) }, "sentBodyHash must be a SHA-256 hex digest"],
    [{ batchId: "" }, "batchId must be a provider batch id or null"],
    [{ batchId: "a b" }, "batchId must be a provider batch id or null"],
    [{ batchId: "x".repeat(257) }, "batchId must be a provider batch id or null"],
    [{ customId: "a:b" }, "customId must match ^[A-Za-z0-9_-]{1,64}$"],
    [{ customId: "x".repeat(65) }, "customId must match ^[A-Za-z0-9_-]{1,64}$"],
    [{ maxCost: 0 }, "maxCost must be a positive integer"],
    [{ maxCost: -1 }, "maxCost must be a positive integer"],
    [{ maxCost: "150" }, "maxCost must be a positive integer"],
    [{ tradingDate: "2026-11-31" }, "invalid tradingDate"],
  ];

  it("形の合わない中身は、追記でも照合でも同じ理由で断る", async () => {
    for (const [extra, why] of BAD) {
      const log = await setup();
      expect(await reason(log, submitted(jst("2026-11-09", 16, 35), extra)), JSON.stringify(extra)).toBe(why);
    }
    const log = await setup();
    const e = await ok(log, submitted(jst("2026-11-09", 16, 35)));
    expect(await admitForged(log.events, e.seq, { ...(e.payload as object), sentBodyHash: "z".repeat(64) })).toBe(`seq ${e.seq} (llm.batch.submitted): sentBodyHash must be a SHA-256 hex digest`);
    expect(await admitForged(log.events, e.seq, { ...(e.payload as object), maxCost: 0 })).toBe(`seq ${e.seq} (llm.batch.submitted): maxCost must be a positive integer`);
  });
});

describe("llm.batch.closed", () => {
  it("同じ AI の依頼を指して1回だけ閉じられる。照合（replay）も通る", async () => {
    const log = await setup();
    const s = await ok(log, submitted(jst("2026-11-09", 16, 35)));
    const c = await ok(log, closed(jst("2026-11-10", 6, 50), s.seq));
    expect(c.keys).toEqual([`llmclosed:${s.seq}`]);
    expect(await reason(log, closed(jst("2026-11-10", 7, 20), s.seq, { result: "expired" }))).toMatch(new RegExp(`duplicate key llmclosed:${s.seq}`));
    // 依頼より後に閉じる記録は、別の依頼の受け取りのあとでもよい（記録の時刻は戻らない）
    const log2 = await setup();
    const sa = await ok(log2, submitted(jst("2026-11-09", 16, 35)));
    const sb = await ok(log2, submitted(jst("2026-11-09", 16, 36), { agentId: "beta" }));
    await ok(log2, closed(jst("2026-11-10", 6, 50), sb.seq, { agentId: "beta", result: "expired", cost: 0, inputTokens: 0, outputTokens: 0 }));
    await ok(log2, closed(jst("2026-11-10", 6, 51), sa.seq));
    await expect(replay(log2.events, { get: () => undefined }, CTX)).resolves.toBeDefined();
    await expect(replay(log.events, { get: () => undefined }, CTX)).resolves.toBeDefined();
  });

  it("依頼でない記録・別の AI の依頼・refs にない seq は指せない", async () => {
    const log = await setup();
    const s = await ok(log, submitted(jst("2026-11-09", 16, 35)));
    expect(await reason(log, closed(jst("2026-11-10", 6, 50), 2))).toBe("batchSeq must be llm.batch.submitted of the same agent");
    expect(await reason(log, closed(jst("2026-11-10", 6, 50), s.seq, { agentId: "beta" }))).toBe("batchSeq must be llm.batch.submitted of the same agent");
    expect(await reason(log, { ...closed(jst("2026-11-10", 6, 50), s.seq), refs: [] })).toBe(`payload refers to ${s.seq} outside refs`);
    expect(await reason(log, closed(jst("2026-11-10", 6, 50), s.seq + 1))).toBe(`payload refers to ${s.seq + 1} outside refs`);
    expect(await reason(log, { ...closed(jst("2026-11-10", 6, 50), s.seq), actor: "operator:owner" })).toBe("llm.batch.closed must be written by system");
  });

  const BAD: [Record<string, unknown>, string][] = [
    [{ extra: 1 }, "unknown field in a batch closing"],
    [{ result: "canceled" }, "result must be collected, expired or failed"],
    [{ cost: -1 }, "cost and token counts must be non-negative integers"],
    [{ cost: 1.5 }, "cost and token counts must be non-negative integers"],
    [{ inputTokens: null }, "cost and token counts must be non-negative integers"],
    [{ outputTokens: "1" }, "cost and token counts must be non-negative integers"],
    [{ costUnknown: true, cost: 149 }, "an unknown cost must be the reserved maxCost"],
    [{ costUnknown: false }, "an unknown cost must be the reserved maxCost"],
  ];

  it("形の合わない中身は断る。費用が分からないときは予約した費用ちょうど（実費が予約を超えるのは書ける）", async () => {
    for (const [extra, why] of BAD) {
      const log = await setup();
      const s = await ok(log, submitted(jst("2026-11-09", 16, 35)));
      expect(await reason(log, closed(jst("2026-11-10", 6, 50), s.seq, extra)), JSON.stringify(extra)).toBe(why);
    }
    const log = await setup();
    const s1 = await ok(log, submitted(jst("2026-11-09", 16, 35)));
    const s2 = await ok(log, submitted(jst("2026-11-09", 16, 36), { agentId: "beta" }));
    await ok(log, closed(jst("2026-11-10", 6, 50), s2.seq, { agentId: "beta", cost: 151 }));
    await ok(log, closed(jst("2026-11-10", 8, 30), s1.seq, { result: "expired", costUnknown: true, cost: 150, inputTokens: 0, outputTokens: 0 }));
  });

  it("batchId が null の依頼は、failed・予約した費用（costUnknown）でだけ閉じられる", async () => {
    const log = await setup();
    const s = await ok(log, submitted(jst("2026-11-09", 16, 35), { batchId: null }));
    const why = "a submission without a batch id must close as failed with the reserved cost";
    expect(await reason(log, closed(jst("2026-11-09", 16, 36), s.seq, { result: "collected" }))).toBe(why);
    expect(await reason(log, closed(jst("2026-11-09", 16, 36), s.seq, { result: "failed", cost: 0 }))).toBe(why);
    await ok(log, closed(jst("2026-11-09", 16, 36), s.seq, { result: "failed", cost: 150, costUnknown: true, inputTokens: 0, outputTokens: 0 }));
  });

  it("照合でも、差し替えた中身を同じ理由で断る", async () => {
    const log = await setup();
    const s = await ok(log, submitted(jst("2026-11-09", 16, 35)));
    const c = await ok(log, closed(jst("2026-11-10", 6, 50), s.seq, { costUnknown: true, cost: 150 }));
    expect(await admitForged(log.events, c.seq, { ...(c.payload as object), cost: 100 })).toBe(`seq ${c.seq} (llm.batch.closed): an unknown cost must be the reserved maxCost`);
  });
});

describe("agent.run の費用とトークン数（任意の項目）", () => {
  it("書かなくてよい（規則で動く AI と、これまでの記録）。書くなら決まった形", async () => {
    const log = await setup();
    await ok(log, run({}));
    await ok(log, run({ maxCost: 150, cost: 42, inputTokens: 20_000, outputTokens: 1_500, sentBodyHash: "c".repeat(64) }));
    await ok(log, run({ ok: false, errorCode: "timeout", maxCost: 150, cost: 150, inputTokens: 0, outputTokens: 0 }));
    await expect(replay(log.events, { get: () => undefined }, CTX)).resolves.toBeDefined();
    const BAD: [Record<string, unknown>, string][] = [
      [{ maxCost: 0 }, "maxCost must be a positive integer"],
      [{ maxCost: 1.5 }, "maxCost must be a positive integer"],
      [{ cost: -1 }, "cost must be a non-negative integer"],
      [{ inputTokens: "1" }, "inputTokens must be a non-negative integer"],
      [{ outputTokens: null }, "outputTokens must be a non-negative integer"],
      [{ sentBodyHash: "c".repeat(65) }, "sentBodyHash must be a SHA-256 hex digest"],
      [{ sentBodyHash: 1 }, "sentBodyHash must be a SHA-256 hex digest"],
    ];
    for (const [extra, why] of BAD) expect(await reason(log, run(extra)), JSON.stringify(extra)).toBe(why);
    // 目的の検査が先
    expect(await reason(log, run({ purpose: "chat", maxCost: 0 }))).toBe("purpose must be post or order");
    const e = log.events.at(-1)!;
    expect(await admitForged(log.events, e.seq, { ...(e.payload as object), cost: -5 })).toBe(`seq ${e.seq} (agent.run): cost must be a non-negative integer`);
  });
});
