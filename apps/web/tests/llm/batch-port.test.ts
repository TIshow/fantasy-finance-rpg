// バッチの口の共通部分（費用の上限の予約・送る前の確かめ・閉じた結果）の試験。提供元は呼ばず、偽の driver を使う。
import { describe, expect, it } from "vitest";
import type { LlmBatchRequest, LlmBatchTicket } from "../../src/contracts";
import { EventLog } from "../../src/events/append";
import { sha256Hex } from "../../src/events/hash";
import { llmCostUsed, llmTokenCost } from "../../src/events/llm-cost";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH } from "../../src/ledger/types";
import { BatchBudget, BatchPort, batchCustomIdOf, batchKeyOf, batchSpendOf, unknownCostDrafts, type BatchDriver, type BatchOutcome, type BatchSpend, type SendResult } from "../../src/llm/batch-port";

const PRICE = { inputCentsPer10MTok: 1000, outputCentsPer10MTok: 5000 };
const AT = Date.parse("2026-11-09T07:35:00Z"); // 日本時間 16:35
const DAY = "2026-11-09";
const clock = { now: () => AT + 1000 };

function fakeDriver(over: Partial<BatchDriver> = {}, send: () => Promise<SendResult> = async () => ({ ok: true, batchId: "b1", sentBodyHash: "h" })) {
  const calls = { send: 0, cancel: 0 };
  const driver: BatchDriver = {
    provider: "fake",
    settingKeys: ["max_tokens"],
    priceAt: (m) => (m === "m1" ? PRICE : undefined),
    prepare: (r) => ({ body: JSON.stringify(r.messages), send: () => ((calls.send += 1), send()) }),
    outcome: async () => "pending",
    cancel: async () => ((calls.cancel += 1), true),
    lookup: async () => ({ kind: "none" }),
    ...over,
  };
  return { driver, calls };
}
const source = (s: Partial<BatchSpend> = {}) => async (): Promise<BatchSpend> => ({ used: 0, recordedKeys: new Set(), ...s });
const budget = (limit = 1000, src = source()) => new BatchBudget({ dailyCostLimit: limit, dryRun: false }, src);
const port = (d: BatchDriver, b = budget()) => new BatchPort(d, { budget: b, clock });

const req = (over: Partial<LlmBatchRequest> = {}): LlmBatchRequest => ({
  agentId: "ai-1",
  purpose: "order",
  model: { provider: "fake", modelId: "m1", settings: { max_tokens: "2000" } },
  prompt: { id: "p", version: "1", hash: "0".repeat(64) },
  inputSeqs: [1],
  messages: [{ role: "user", content: "入力" }],
  maxCost: 160,
  tradingDate: "2026-11-10",
  submittedAt: AT,
  reservePrice: { ...PRICE, yenPerUsd: 160 },
  maxInputTokens: 50_000,
  maxOutputTokens: 2000,
  ...over,
});
const ticket = (over: Partial<LlmBatchTicket> = {}): LlmBatchTicket => ({ agentId: "ai-1", provider: "fake", modelId: "m1", batchId: "b1", customId: "llm-x", maxCost: 160, tradingDate: "2026-11-10", submittedAt: AT, ...over });

describe("費用の上限の予約（BatchBudget・submit）", () => {
  it("policy が外れていれば作れない。作ったあとに書き換えても効かない", () => {
    for (const bad of [-1, 1.5, Number.NaN, Infinity]) expect(() => budget(bad)).toThrow(RangeError);
    const p = { dailyCostLimit: 10, dryRun: false };
    const b = new BatchBudget(p, source());
    p.dailyCostLimit = 99999;
    expect(b.policy.dailyCostLimit).toBe(10);
  });

  it("記録の分＋予約＋maxCost が上限を超えるなら送らずに budget_exceeded。ちょうどなら送る", async () => {
    const { driver, calls } = fakeDriver();
    const b = budget(1000, source({ used: 840 }));
    expect(await port(driver, b).submit(req({ maxCost: 161 }))).toEqual({ ok: false, errorCode: "budget_exceeded", submittedAt: AT });
    expect(calls.send).toBe(0);
    expect((await port(driver, b).submit(req({ maxCost: 160 }))).ok).toBe(true);
    expect(await b.spent(DAY)).toBe(1000);
  });

  it("同時に呼んでも上限を超えない（判定と予約は1つずつ）", async () => {
    const { driver } = fakeDriver();
    const p = port(driver, budget(1000));
    const rs = await Promise.all([p.submit(req({ maxCost: 600 })), p.submit(req({ agentId: "ai-2", maxCost: 600 }))]);
    expect(rs.map((r) => r.ok)).toEqual([true, false]);
  });

  it("予約は記録に現れたら記録の側で数え、二重に数えない。同じ AI・同じ取引日は2回送らない", async () => {
    const recorded = new Set<string>();
    let used = 0;
    const b = budget(1000, async () => ({ used, recordedKeys: recorded }));
    const { driver } = fakeDriver();
    expect((await port(driver, b).submit(req())).ok).toBe(true);
    await expect(port(driver, b).submit(req())).rejects.toThrow(RangeError);
    recorded.add(batchKeyOf("ai-1", "2026-11-10"));
    used = 160;
    expect(await b.spent(DAY)).toBe(160);
    await expect(port(driver, b).submit(req())).rejects.toThrow(RangeError);
  });

  it("作られたか分からない失敗は予約を残す（rate_limited でも billingUnknown を返す）。作られていない失敗は予約を外す", async () => {
    const b = budget();
    const unknown = fakeDriver({}, async () => ({ ok: false, errorCode: "rate_limited", billingUnknown: true }));
    const r = await port(unknown.driver, b).submit(req());
    expect(r).toEqual({ ok: false, errorCode: "rate_limited", billingUnknown: true, sentBodyHash: await sha256Hex(new TextEncoder().encode(JSON.stringify(req().messages))), submittedAt: AT });
    expect(await b.spent(DAY)).toBe(160);
    const refused = fakeDriver({}, async () => ({ ok: false, errorCode: "provider_error" }));
    expect(await port(refused.driver, b).submit(req({ agentId: "ai-2" }))).toMatchObject({ ok: false, errorCode: "provider_error" });
    expect(await b.spent(DAY)).toBe(160);
    const thrown = fakeDriver({}, async () => {
      throw new Error("request-id=req_secret123");
    });
    const t = await port(thrown.driver, b).submit(req({ agentId: "ai-3" }));
    expect(t).toMatchObject({ ok: false, errorCode: "provider_error", billingUnknown: true });
    expect(JSON.stringify(t)).not.toContain("secret");
  });

  it("記録が読めないときは送らずに budget_exceeded", async () => {
    const { driver, calls } = fakeDriver();
    const b = budget(1000, async () => {
      throw new Error("db down");
    });
    expect(await port(driver, b).submit(req())).toMatchObject({ ok: false, errorCode: "budget_exceeded" });
    expect(calls.send).toBe(0);
  });

  it("記録から使用済みと一意キーを出す（暦日は submittedAt の日本時間）", () => {
    const sub = (seq: number, agentId: string, submittedAt: number) => ({ seq, type: "llm.batch.submitted" as const, recordedAt: submittedAt, payload: { agentId, tradingDate: "2026-11-10", submittedAt, maxCost: 300 } });
    const events = [sub(1, "a", AT), sub(2, "b", AT), { seq: 3, type: "llm.batch.closed" as const, recordedAt: AT, payload: { batchSeq: 1, cost: 12 } }, sub(4, "c", Date.parse("2026-11-09T15:30:00Z"))];
    const s = batchSpendOf(events as never, DAY);
    expect(s.used).toBe(312);
    expect([...s.recordedKeys]).toEqual(["llmbatch:a:2026-11-10", "llmbatch:b:2026-11-10", "llmbatch:c:2026-11-10"]);
  });
});

describe("送る前の確かめ（RangeError で reject し、送らない）", () => {
  it.each<[string, Partial<LlmBatchRequest>]>([
    ["maxCost が 0", { maxCost: 0 }],
    ["maxCost が NaN", { maxCost: Number.NaN }],
    ["maxCost が小数", { maxCost: 1.5 }],
    // 50,000×1ドル/100万＋2,000×5ドル/100万 ＝ 0.06ドル ＝ 9.6円（96）
    ["上限のトークン数の費用より小さい", { maxCost: 95 }],
    ["予約の料金が料金表と違う", { reservePrice: { ...PRICE, inputCentsPer10MTok: 999, yenPerUsd: 160 } }],
    ["1ドルあたりの円が違う", { reservePrice: { ...PRICE, yenPerUsd: 150 } }],
    ["temperature を送ろうとした", { model: { provider: "fake", modelId: "m1", settings: { max_tokens: "2000", temperature: "0" } } }],
    ["提供元が違う", { model: { provider: "other", modelId: "m1", settings: { max_tokens: "2000" } } }],
    ["料金表にないモデル", { model: { provider: "fake", modelId: "m2", settings: { max_tokens: "2000" } } }],
    ["maxOutputTokens が max_tokens より小さい", { maxOutputTokens: 1999, maxCost: 1000 }],
    ["maxInputTokens が送る本文のバイト数より小さい", { maxInputTokens: 10 }],
    ["maxInputTokens が送る本文のバイト数×inputCostFactor より小さい", { maxInputTokens: 60, maxCost: 1000 }],
    ["取引日の形が違う", { tradingDate: "2026/11/10" }],
    ["submittedAt が今から5分より前", { submittedAt: AT - 300_000 }],
    ["submittedAt が今から5分より後", { submittedAt: AT + 302_000 }],
    ["messages が配列でない", { messages: "入力" as never }],
    ["messages の content が文字列でない・role が決まりの外", { messages: [{ role: "user", content: 1 }, { role: "tool", content: "x" }] as never }],
  ])("%s", async (_name, over) => {
    const { driver, calls } = fakeDriver({ inputCostFactor: 3 });
    await expect(port(driver).submit(req(over))).rejects.toThrow(RangeError);
    expect(calls.send).toBe(0);
  });

  it("customId は一意キーから決まり、決まりに合う", async () => {
    const id = await batchCustomIdOf("ai-1", "2026-11-10");
    expect(id).toMatch(/^llm-[0-9a-f]{48}$/);
    expect(await batchCustomIdOf("ai-1", "2026-11-10")).toBe(id);
    expect(await batchCustomIdOf("ai-1", "2026-11-11")).not.toBe(id);
  });
});

describe("受け取りと打ち切り", () => {
  const usage = { inputTokens: 20_000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  const succeeded: BatchOutcome = { kind: "succeeded", output: "{}", respondedModel: "m1-2026", usage };

  it("受け取り：費用は予約の料金で、llmTokenCost ちょうど。料金をそのまま写す", async () => {
    const { driver } = fakeDriver({ outcome: async () => succeeded });
    const r = await port(driver).collect(ticket());
    const cost = llmTokenCost(usage, { ...PRICE, yenPerUsd: 160 });
    expect(r).toEqual({ status: "closed", result: "collected", output: "{}", respondedModel: "m1-2026", usage: { inputTokens: 20_000, outputTokens: 1500, cost }, price: PRICE, finishedAt: AT + 1000 });
    expect(cost).toBe(44); // (20,000×1ドル＋1,500×5ドル)/100万 × 160円 ＝ 4.4円
  });

  it("課金されないもの・分からないもの・読めないとき", async () => {
    const notBilled = fakeDriver({ outcome: async () => ({ kind: "notBilled", result: "expired", errorCode: "timeout" }) });
    expect(await port(notBilled.driver).collect(ticket())).toEqual({ status: "closed", result: "expired", errorCode: "timeout", usage: { inputTokens: 0, outputTokens: 0, cost: 0 }, price: PRICE, finishedAt: AT + 1000 });
    const unknown = fakeDriver({ outcome: async () => ({ kind: "costUnknown", result: "failed", errorCode: "provider_error" }) });
    expect(await port(unknown.driver).collect(ticket())).toEqual({ status: "closed", result: "failed", errorCode: "provider_error", usage: { inputTokens: 0, outputTokens: 0, cost: 160 }, costUnknown: true, finishedAt: AT + 1000 });
    const thrown = fakeDriver({ outcome: async () => Promise.reject(new Error("x")) });
    expect(await port(thrown.driver).collect(ticket())).toEqual({ status: "pending" });
    await expect(port(thrown.driver).collect(ticket({ provider: "other" }))).rejects.toThrow(RangeError);
  });

  it("打ち切り：終わっていなければ取り消しを頼み、まだ終わらなければ maxCost・costUnknown の expired", async () => {
    const { driver, calls } = fakeDriver();
    expect(await port(driver).abandon(ticket())).toEqual({ status: "closed", result: "expired", errorCode: "timeout", usage: { inputTokens: 0, outputTokens: 0, cost: 160 }, costUnknown: true, finishedAt: AT + 1000 });
    expect(calls.cancel).toBe(1);
  });

  it("打ち切り：答えが出ていても使わず expired。費用は実際の値", async () => {
    const { driver, calls } = fakeDriver({ outcome: async () => succeeded });
    expect(await port(driver).abandon(ticket())).toEqual({ status: "closed", result: "expired", errorCode: "timeout", usage: { inputTokens: 20_000, outputTokens: 1500, cost: 44 }, price: PRICE, finishedAt: AT + 1000 });
    expect(calls.cancel).toBe(0);
  });

  it("記録にないバッチを探す：customId を渡し、例外は unknown", async () => {
    const seen: string[] = [];
    const { driver } = fakeDriver({ lookup: async (q) => (seen.push(q.customId), { kind: "found", batchIds: ["b9"] }) });
    expect(await port(driver).findUnrecorded({ agentId: "ai-1", tradingDate: "2026-11-10", since: AT, now: AT, requestedAt: AT, recordedBatchIds: new Set() })).toEqual({ kind: "found", batchIds: ["b9"] });
    expect(seen).toEqual([await batchCustomIdOf("ai-1", "2026-11-10")]);
    const bad = fakeDriver({ lookup: async () => Promise.reject(new Error("x")) });
    expect(await port(bad.driver).findUnrecorded({ agentId: "ai-1", tradingDate: "2026-11-10", since: AT, now: AT, requestedAt: AT, recordedBatchIds: new Set() })).toEqual({ kind: "unknown" });
  });
});

describe("課金されたか分からない依頼の2つの記録（unknownCostDrafts・unrecordedDrafts）", () => {
  const H = "a".repeat(64);
  const l = new EventLog({ holidayTables: new Map([[H, { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set<string>() }]]), accountOf: () => newAccount() });
  async function write(d: Awaited<ReturnType<typeof unknownCostDrafts>>) {
    expect(await l.canAppend(d.submitted)).toBeNull();
    const s = await l.append(d.submitted);
    expect(s.ok && (await l.canAppend(d.closedFor(s.event.seq))) === null && (await l.append(d.closedFor(s.event.seq))).ok).toBe(true);
  }

  it("止まる前に送った依頼（found・unknown）：送らずに書け、費用は maxCost で一意キーも埋まる。billingUnknown でも同じ形で書ける", async () => {
    await l.append({ type: "holidays.adopted", recordedAt: 0, actor: "operator:owner", refs: [], payload: { holidaysSha256: H } });
    for (const agentId of ["ai-1", "ai-2"]) await l.append({ type: "agent.registered", recordedAt: AT - 6 * 3_600_000, actor: "operator:owner", refs: [], payload: { agentId, startDate: "2026-11-10", initialCash: INITIAL_CASH } });
    const { driver, calls } = fakeDriver();
    const d = await port(driver).unrecordedDrafts(req(), AT + 1000);
    expect(d.submitted.payload).toMatchObject({ batchId: null, maxCost: 160, customId: await batchCustomIdOf("ai-1", "2026-11-10"), sentBodyHash: await sha256Hex(new TextEncoder().encode(JSON.stringify(req().messages))) });
    expect(d.closedFor(9).payload).toEqual({ batchSeq: 9, agentId: "ai-1", result: "failed", cost: 160, costUnknown: true, inputTokens: 0, outputTokens: 0 });
    await write(d);
    expect(calls.send).toBe(0);
    expect(llmCostUsed(l.events, DAY)).toBe(160);
    expect(await l.canAppend((await port(driver).unrecordedDrafts(req(), AT + 2000)).submitted)).toMatch(/duplicate key/);
    await expect(port(driver).unrecordedDrafts(req({ maxCost: 95 }), AT + 1000)).rejects.toThrow(RangeError);
    // submit が billingUnknown を返したとき。予約は記録の側に移り、二重に数えない
    const b = new BatchBudget({ dailyCostLimit: 1000, dryRun: false }, async (day: string) => batchSpendOf(l.events, day));
    const r = await port(fakeDriver({}, async () => ({ ok: false, errorCode: "timeout", billingUnknown: true })).driver, b).submit(req({ agentId: "ai-2" }));
    if (r.ok || r.errorCode === "budget_exceeded") throw new Error("unexpected");
    await write(await unknownCostDrafts(req({ agentId: "ai-2" }), r.sentBodyHash, AT + 1000));
    expect(await b.spent(DAY)).toBe(320);
  });
});
