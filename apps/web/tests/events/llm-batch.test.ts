// LLM のバッチの記録（llm.batch.submitted・llm.batch.closed）と、agent.run の費用の任意の項目（#179）。
// 追記でも照合（admit・replay）でも同じ検査が効くこと。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { sealEvent } from "../../src/events/chain";
import { llmCostUsed, openLlmBatches } from "../../src/events/llm-cost";
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

/**
 * 依頼の記録。既定は alpha が 11-09 16:35 に、11-10 の判断を 150（15円）の予約で依頼したもの。
 * 料金は1ドル・5ドル／100万トークン（1,000万トークンあたり 1000・5000 セント）、160円。上限のトークン数（5万・8,000）の費用は 144
 */
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
    submittedAt: at,
    yenPerUsd: 160,
    inputCentsPer10MTok: 1000,
    outputCentsPer10MTok: 5000,
    maxInputTokens: 50_000,
    maxOutputTokens: 8_000,
    ...extra,
  },
});

/** 閉じた記録。既定は入力2万・出力1,500 で、費用は 44（4.4円）。費用が分からない（costUnknown）なら料金を書かない */
const closed = (at: number, batchSeq: number, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.closed",
  recordedAt: at,
  actor: "system",
  refs: [batchSeq],
  payload: {
    batchSeq,
    agentId: "alpha",
    result: "collected",
    cost: 44,
    inputTokens: 20_000,
    outputTokens: 1_500,
    ...("costUnknown" in extra ? {} : { inputCentsPer10MTok: 1000, outputCentsPer10MTok: 5000 }),
    ...extra,
  },
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

  it("取引日は依頼を決めた時刻（submittedAt）で決める。8:29:59 に決めて 8:30:01 に記録しても当日のまま。記録は1時間以内", async () => {
    const log = await setup();
    const at = jst("2026-11-10", 8, 29) + 59_000;
    await ok(log, { ...submitted(at, { tradingDate: "2026-11-10" }), recordedAt: at + 2_000 });
    const late = "submittedAt must be within an hour before recordedAt";
    expect(await reason(log, { ...submitted(at, { agentId: "beta", tradingDate: "2026-11-10" }), recordedAt: at + 3_600_001 })).toBe(late);
    expect(await reason(log, { ...submitted(at + 3_000, { agentId: "beta", tradingDate: "2026-11-10" }), recordedAt: at + 2_000 })).toBe(late);
    expect(await reason(log, submitted(at + 3_000, { agentId: "beta", submittedAt: "x" }))).toBe(late);
    await ok(log, { ...submitted(at, { agentId: "beta", tradingDate: "2026-11-10" }), recordedAt: at + 3_600_000 });
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
    [{ yenPerUsd: 0 }, "yenPerUsd must be a positive integer"],
    [{ yenPerUsd: 160.5 }, "yenPerUsd must be a positive integer"],
    [{ inputCentsPer10MTok: -1 }, "prices and max token counts must be non-negative integers"],
    [{ outputCentsPer10MTok: "5000" }, "prices and max token counts must be non-negative integers"],
    [{ maxInputTokens: 1.5 }, "prices and max token counts must be non-negative integers"],
    [{ maxOutputTokens: null }, "prices and max token counts must be non-negative integers"],
    // 予約は上限のトークン数から出した費用（144）以上
    [{ maxCost: 143 }, "maxCost must be at least 144 (the cost of the max tokens)"],
    [{ maxInputTokens: Number.MAX_SAFE_INTEGER, inputCentsPer10MTok: 10 ** 9 }, "maxCost must be at least null (the cost of the max tokens)"],
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
    [{ cacheReadInputTokens: -1 }, "cost and token counts must be non-negative integers"],
    [{ costUnknown: true, cost: 150, inputCentsPer10MTok: 1000 }, "an unknown cost has no price"],
    // 実際の費用はトークン数と料金から出した値ちょうど（0 にして枠をあけることはできない）
    [{ cost: 0, inputTokens: 100_000, outputTokens: 50_000 }, "cost must be 560 (from the tokens and the price)"],
    [{ cost: 43 }, "cost must be 44 (from the tokens and the price)"],
    [{ cost: 45 }, "cost must be 44 (from the tokens and the price)"],
    [{ result: "expired", cost: 1, inputTokens: 0, outputTokens: 0 }, "cost must be 0 (from the tokens and the price)"],
    // キャッシュへの書き込みは入力の2倍：1万トークンで 3.2円 を足す
    [{ cacheCreationInputTokens: 10_000 }, "cost must be 76 (from the tokens and the price)"],
    // 料金は予約の料金ちょうど。高くても安くても、0 でも断る（使った額を少なく見せられないように）。書かないのは費用が分からないときだけ
    [{ inputCentsPer10MTok: 1001 }, "the price must equal the reserved price"],
    [{ inputCentsPer10MTok: 999 }, "the price must equal the reserved price"],
    [{ inputCentsPer10MTok: 500, cost: 33 }, "the price must equal the reserved price"],
    [{ outputCentsPer10MTok: 4999 }, "the price must equal the reserved price"],
    [{ inputCentsPer10MTok: 0, outputCentsPer10MTok: 0, cost: 0 }, "the price must equal the reserved price"],
    [{ inputCentsPer10MTok: 0, outputCentsPer10MTok: 0, cost: 0, inputTokens: 1_000_000, outputTokens: 100_000 }, "the price must equal the reserved price"],
    [{ outputCentsPer10MTok: -1 }, "the price must equal the reserved price"],
    [{ outputCentsPer10MTok: null }, "the price must equal the reserved price"],
    [{ outputCentsPer10MTok: "5000" }, "the price must equal the reserved price"],
    [{ inputCentsPer10MTok: undefined }, "the price must equal the reserved price"],
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
    // 入力10万・出力1万は 240。予約（150）を超えても書ける（上限の検査が挙げる）
    await ok(log, closed(jst("2026-11-10", 6, 50), s2.seq, { agentId: "beta", cost: 240, inputTokens: 100_000, outputTokens: 10_000 }));
    await ok(log, closed(jst("2026-11-10", 8, 30), s1.seq, { result: "expired", costUnknown: true, cost: 150, inputTokens: 0, outputTokens: 0 }));
    // キャッシュの欄は予約の料金で数える：(2万×1000 ＋ 1万×2×1000 ＋ 1,500×5000) セント/1,000万 × 160円 ＝ 7.6円
    const log2 = await setup();
    const s3 = await ok(log2, submitted(jst("2026-11-09", 16, 35)));
    await ok(log2, closed(jst("2026-11-10", 6, 50), s3.seq, { cost: 76, cacheCreationInputTokens: 10_000, cacheReadInputTokens: 0 }));
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
    const log2 = await setup();
    const s2 = await ok(log2, submitted(jst("2026-11-09", 16, 35)));
    const c2 = await ok(log2, closed(jst("2026-11-10", 6, 50), s2.seq));
    expect(await admitForged(log2.events, c2.seq, { ...(c2.payload as object), cost: 0 })).toBe(`seq ${c2.seq} (llm.batch.closed): cost must be 44 (from the tokens and the price)`);
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

describe("送る前の確かめ（EventLog.canAppend）", () => {
  /** 送る前に作る記録：batchId は null、送った本文のハッシュは仮の値 */
  const probe = (at: number, extra: Record<string, unknown> = {}) => submitted(at, { batchId: null, sentBodyHash: "0".repeat(64), ...extra });

  it("通るなら null で、何も書かない。そのあと本物の記録を書ける", async () => {
    const log = await setup();
    const at = jst("2026-11-09", 16, 35);
    expect(await log.canAppend(probe(at))).toBeNull();
    expect(log.events).toHaveLength(4);
    await ok(log, { ...submitted(at), recordedAt: at + 5_000 });
  });

  it("送ったあとの記録が断られる場合を、送る前に挙げる：同じ晩・土曜のやり直し（一意キー）、取引日の違い、登録していないAI、祝日の一覧の範囲の外", async () => {
    const log = await setup();
    await ok(log, submitted(jst("2026-11-13", 16, 35), { tradingDate: "2026-11-16" }));
    // 金曜の夕方に依頼したあと、同じ晩と土曜にやり直すと、どちらも月曜の分でキーが重なる
    expect(await log.canAppend(probe(jst("2026-11-13", 20), { tradingDate: "2026-11-16" }))).toMatch(/duplicate key llmbatch:alpha:2026-11-16/);
    expect(await log.canAppend(probe(jst("2026-11-14", 10), { tradingDate: "2026-11-16" }))).toMatch(/duplicate key llmbatch:alpha:2026-11-16/);
    // 8:30 ちょうどに決めたなら、取引日は翌営業日
    expect(await log.canAppend(probe(jst("2026-11-16", 8, 30), { agentId: "beta", tradingDate: "2026-11-16" }))).toBe("tradingDate must be the next trading date");
    expect(await log.canAppend(probe(jst("2026-11-16", 8, 30), { agentId: "delta", tradingDate: "2026-11-17" }))).toBe("unknown agent delta");
    expect(await log.canAppend(probe(jst("2027-12-30", 16, 35), { agentId: "beta", tradingDate: "2028-01-04" }))).toBe("submittedAt is outside the adopted holiday table");
    expect(log.events).toHaveLength(5);
  });

  it("注文票は canAppend でも確かめられない（commitSheet を使う）", async () => {
    const log = await setup();
    expect(await log.canAppend({ ...probe(0), type: "order_sheet.committed" })).toBe("use commitSheet");
  });
});

describe("agent.run の元のバッチ（batchSeq）", () => {
  /** alpha が 11-09 16:35 に依頼し、11-10 6:50 に受け取ったログ */
  async function collected(extra: Record<string, unknown> = {}) {
    const log = await setup();
    const s = await ok(log, submitted(jst("2026-11-09", 16, 35)));
    const c = await ok(log, closed(jst("2026-11-10", 6, 50), s.seq, extra));
    return { log, s, c };
  }
  const llmRun = (batchSeq: number, extra: Record<string, unknown> = {}): Draft => ({ ...run({ batchSeq, sentBodyHash: "b".repeat(64), ...extra }), refs: [batchSeq] });

  it("同じAIの、受け取った（collected）閉じた記録を指し、送った本文のハッシュが依頼と同じなら書ける。照合も通る", async () => {
    const { log, c } = await collected();
    await ok(log, llmRun(c.seq));
    // 規則で動くAI（batchSeq なし）とこれまでの記録はそのまま
    await ok(log, run({}));
    await ok(log, { ...llmRun(c.seq, { purpose: "post" }), recordedAt: jst("2026-11-10", 8, 29) });
    await expect(replay(log.events, { get: () => undefined }, CTX)).resolves.toBeDefined();
  });

  it("指す先・ハッシュ・時刻が合わなければ断る", async () => {
    const { log, s, c } = await collected();
    const target = "batchSeq must be a collected llm.batch.closed of the same agent";
    expect(await reason(log, llmRun(s.seq))).toBe(target);
    expect(await reason(log, llmRun(2))).toBe(target);
    expect(await reason(log, llmRun(c.seq, { agentId: "beta" }))).toBe(target);
    expect(await reason(log, llmRun(c.seq, { sentBodyHash: "c".repeat(64) }))).toBe("sentBodyHash must match the batch submission");
    expect(await reason(log, llmRun(c.seq, { sentBodyHash: undefined }))).toBe("sentBodyHash must match the batch submission");
    expect(await reason(log, { ...llmRun(c.seq), recordedAt: jst("2026-11-10", 8, 30) })).toBe("the run must be recorded before the cutoff of the batch's trading date");
    expect(await reason(log, { ...llmRun(c.seq), refs: [] })).toBe(`payload refers to ${c.seq} outside refs`);
    const e = await ok(log, llmRun(c.seq));
    expect(await admitForged(log.events, e.seq, { ...(e.payload as object), sentBodyHash: "d".repeat(64) })).toBe(`seq ${e.seq} (agent.run): sentBodyHash must match the batch submission`);
  });

  it("入力は、依頼の記録より前に記録したものだけ。依頼そのものと、そのあとの記録は入れられない（照合でも同じ）", async () => {
    const { log, s, c } = await collected();
    const target = "inputSeqs must be recorded before the batch submission";
    const withInputs = (inputSeqs: unknown[]): Draft => ({ ...llmRun(c.seq, { inputSeqs }), refs: [...new Set([c.seq, ...inputSeqs.filter((x) => typeof x === "number")])] });
    // 依頼のあと（20:00）に取り込んだ記録の代わりに、閉じた記録（依頼より後）を入力に入れる
    expect(await reason(log, withInputs([2, c.seq]))).toBe(target);
    expect(await reason(log, withInputs([s.seq]))).toBe(target);
    const e = await ok(log, withInputs([2, s.seq - 1]));
    expect(await admitForged(log.events, e.seq, { ...(e.payload as object), inputSeqs: [2, c.seq] })).toBe(`seq ${e.seq} (agent.run): ${target}`);
  });

  it("1つの答えから書ける実行は、目的（投稿・注文）ごとに1回だけ", async () => {
    const { log, c } = await collected();
    await ok(log, llmRun(c.seq));
    // 同じ目的の2つ目は、成功でも失敗でも断る
    const dup = (purpose: string) => `invalid event: duplicate key llmrun:${c.seq}:${purpose}`;
    expect(await reason(log, llmRun(c.seq))).toBe(dup("order"));
    expect(await reason(log, llmRun(c.seq, { ok: false, errorCode: "invalid_output" }))).toBe(dup("order"));
    // 別の目的（投稿）は1回書ける。その2つ目は断る
    await ok(log, llmRun(c.seq, { purpose: "post" }));
    expect(await reason(log, llmRun(c.seq, { purpose: "post" }))).toBe(dup("post"));
    // batchSeq が数でなければ断る。batchSeq のない実行は何度でも書ける
    expect(await reason(log, llmRun(c.seq, { batchSeq: "3" }))).toBe("invalid batchSeq");
    await ok(log, run({}));
    await ok(log, run({}));
  });

  it("打ち切った（expired）・失敗した（failed）バッチは指せない", async () => {
    for (const result of ["expired", "failed"]) {
      const { log, c } = await collected({ result });
      expect(await reason(log, llmRun(c.seq)), result).toBe("batchSeq must be a collected llm.batch.closed of the same agent");
    }
  });
});

describe("記録を書く前に止まった依頼を、やり直しで見つけたとき（batchId を null にした組）", () => {
  /** 11-09 16:35 に送ったあと、記録を書く前に止まった。やり直しで、記録にないバッチが見つかった（または分からなかった） */
  const sent = jst("2026-11-09", 16, 35);
  const nullPair = async (log: EventLog, at: number, tradingDate: string) => {
    const s = await ok(log, submitted(at, { batchId: null, tradingDate }));
    await ok(log, closed(at, s.seq, { result: "failed", cost: 150, costUnknown: true, inputTokens: 0, outputTokens: 0 }));
    return s;
  };

  it("元の依頼の時刻を submittedAt にすると、1時間を過ぎていれば書けない", async () => {
    const log = await setup();
    expect(await reason(log, { ...submitted(sent, { batchId: null }), recordedAt: jst("2026-11-09", 21) })).toBe("submittedAt must be within an hour before recordedAt");
  });

  it("やり直しの時刻を submittedAt にすれば書けて、予約の費用がやり直した日に数えられる。その日の依頼はもう書けない", async () => {
    const log = await setup();
    const rerun = jst("2026-11-09", 21);
    expect(await log.canAppend(submitted(rerun, { batchId: null, sentBodyHash: "0".repeat(64) }))).toBeNull();
    const s = await nullPair(log, rerun, "2026-11-10");
    expect(s.keys).toEqual(["llmbatch:alpha:2026-11-10"]);
    expect(llmCostUsed(log.events, "2026-11-09")).toBe(150);
    expect(openLlmBatches(log.events)).toEqual([]);
    expect(await log.canAppend(submitted(jst("2026-11-09", 21, 5), { batchId: "msgbatch_02" }))).toMatch(/duplicate key llmbatch:alpha:2026-11-10/);
    await expect(replay(log.events, { get: () => undefined }, CTX)).resolves.toBeDefined();
  });

  it("翌朝（締めの前）にやり直しても、取引日は同じ日。費用はやり直した日（翌日）に数える", async () => {
    const log = await setup();
    await nullPair(log, jst("2026-11-10", 6, 50), "2026-11-10");
    expect(llmCostUsed(log.events, "2026-11-09")).toBe(0);
    expect(llmCostUsed(log.events, "2026-11-10")).toBe(150);
  });

  it("締めのあとにやり直すと、取引日は次の営業日になる（元の取引日では書けない）", async () => {
    const log = await setup();
    const rerun = jst("2026-11-10", 9);
    expect(await reason(log, submitted(rerun, { batchId: null, tradingDate: "2026-11-10" }))).toBe("tradingDate must be the next trading date");
    const s = await nullPair(log, rerun, "2026-11-11");
    expect(s.keys).toEqual(["llmbatch:alpha:2026-11-11"]);
  });
});
