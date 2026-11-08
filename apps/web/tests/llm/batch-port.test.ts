// バッチの口の共通部分（本文を作る・送る・探す・受け取り・打ち切り）の試験。提供元は呼ばず、偽の driver を使う。
import { describe, expect, it } from "vitest";
import type { LlmBatchRequest, LlmBatchReservation, LlmBatchTicket } from "../../src/contracts";
import { sha256Hex } from "../../src/events/hash";
import { llmTokenCost } from "../../src/events/llm-cost";
import { BatchPort, FIND_AFTER_MS, FIND_BEFORE_MS, batchCustomIdOf, batchItemIdOf, batchItemIdOfCustomId, type BatchDriver, type BatchOutcome, type SendResult } from "../../src/llm/batch-port";

const PRICE = { inputCentsPer10MTok: 1000, outputCentsPer10MTok: 5000 };
const AT = Date.parse("2026-11-09T07:35:00Z"); // 日本時間 16:35
const clock = { now: () => AT + 1000 };
const H = "ab".repeat(32);

function fakeDriver(over: Partial<BatchDriver> = {}, send: () => Promise<SendResult> = async () => ({ ok: true, batchId: "b1" })) {
  const calls = { send: [] as string[], cancel: 0, itemIds: [] as string[] };
  const driver: BatchDriver = {
    provider: "fake",
    settingKeys: ["max_tokens"],
    maxOutputTokens: 2000,
    priceAt: (m) => (m === "m1" ? PRICE : undefined),
    body: (r, itemId) => JSON.stringify({ id: itemId, messages: r.messages }),
    send: (body) => (calls.send.push(body), send()),
    find: async () => ({ status: "not_found" }),
    outcome: async (_t, itemId) => (calls.itemIds.push(itemId), "pending"),
    cancel: async () => ((calls.cancel += 1), true),
    ...over,
  };
  return { driver, calls };
}
const port = (d: BatchDriver, sendTimeoutMs?: number) => new BatchPort(d, { policy: { dailyCostLimit: 1000, dryRun: false }, clock, ...(sendTimeoutMs ? { sendTimeoutMs } : {}) });

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
  maxInputTokens: 20_000,
  maxOutputTokens: 2000,
  ...over,
});
const reservation = (over: Partial<LlmBatchReservation> = {}): LlmBatchReservation => ({ batchSeq: 5, agentId: "ai-1", provider: "fake", modelId: "m1", customId: `ai-1-20261110-${H.slice(0, 16)}`, sentBodyHash: H, reservedAt: AT, maxCost: 160, tradingDate: "2026-11-10", submittedAt: AT, reservePrice: { ...PRICE, yenPerUsd: 160 }, ...over });
const ticket = (over: Partial<LlmBatchTicket> = {}): LlmBatchTicket => ({ ...reservation(), batchId: "b1", ...over });

describe("本文を作る（prepare）", () => {
  it("本文・そのハッシュ・customId（前半＋ハッシュの先頭16文字）・本文の出力の上限を返し、送らない", async () => {
    const { driver, calls } = fakeDriver();
    const p = await port(driver).prepare(req());
    const body = JSON.stringify({ id: "ai-1-20261110", messages: req().messages });
    const hash = await sha256Hex(new TextEncoder().encode(body));
    expect(p).toMatchObject({ body, sentBodyHash: hash, customId: `ai-1-20261110-${hash.slice(0, 16)}`, bodyMaxOutputTokens: 2000 });
    expect(Object.isFrozen(p)).toBe(true);
    expect(calls.send).toHaveLength(0);
  });

  it("customId の前半は47文字まで（長い agentId は先頭から切り詰める）。全体は64文字以内", () => {
    const long = `a${"x".repeat(99)}`;
    expect(batchItemIdOf(long, "2026-11-10")).toBe(`${long.slice(0, 38)}-20261110`);
    const id = batchCustomIdOf(batchItemIdOf(long, "2026-11-10"), H);
    expect(id).toHaveLength(64);
    expect(batchItemIdOfCustomId(id)).toBe(`${long.slice(0, 38)}-20261110`);
  });

  it.each<[string, Partial<LlmBatchRequest>]>([
    ["maxCost が 0", { maxCost: 0 }],
    ["maxCost が NaN", { maxCost: Number.NaN }],
    ["maxCost が小数", { maxCost: 1.5 }],
    // 20,000×1ドル/100万＋2,000×5ドル/100万 ＝ 0.03ドル ＝ 4.8円（48）
    ["上限のトークン数の費用より小さい", { maxCost: 47 }],
    ["予約の料金が料金表と違う", { reservePrice: { ...PRICE, inputCentsPer10MTok: 999, yenPerUsd: 160 } }],
    ["1ドルあたりの円が違う", { reservePrice: { ...PRICE, yenPerUsd: 150 } }],
    ["temperature を送ろうとした", { model: { provider: "fake", modelId: "m1", settings: { max_tokens: "2000", temperature: "0" } } }],
    ["提供元が違う", { model: { provider: "other", modelId: "m1", settings: { max_tokens: "2000" } } }],
    ["料金表にないモデル", { model: { provider: "fake", modelId: "m2", settings: { max_tokens: "2000" } } }],
    ["maxOutputTokens が max_tokens より小さい", { maxOutputTokens: 1999, maxCost: 1000 }],
    ["max_tokens が提供元の出力の上限と違う", { model: { provider: "fake", modelId: "m1", settings: { max_tokens: "1999" } } }],
    ["maxInputTokens が入力の上限（20,000）を超える", { maxInputTokens: 20_001, maxCost: 1000 }],
    ["maxInputTokens が送る本文のバイト数より小さい", { maxInputTokens: 10 }],
    ["maxInputTokens が送る本文のバイト数×inputCostFactor より小さい", { maxInputTokens: 100, maxCost: 1000 }],
    ["agentId に名前に使えない文字がある", { agentId: "ai 1" }],
    ["取引日の形が違う", { tradingDate: "2026/11/10" }],
    ["submittedAt が今から5分より前", { submittedAt: AT - 300_000 }],
    ["messages が配列でない", { messages: "入力" as never }],
    ["messages の content が文字列でない・role が決まりの外", { messages: [{ role: "user", content: 1 }, { role: "tool", content: "x" }] as never }],
  ])("断る（RangeError）：%s", async (_name, over) => {
    const { driver } = fakeDriver({ inputCostFactor: 3 });
    await expect(port(driver).prepare(req(over))).rejects.toThrow(RangeError);
  });

  it("policy・送る時間の上限が外れていれば作れない", () => {
    const { driver } = fakeDriver();
    expect(() => new BatchPort(driver, { policy: { dailyCostLimit: -1, dryRun: false }, clock })).toThrow(RangeError);
    expect(() => port(driver, 600_001)).toThrow(RangeError);
  });
});

describe("送る（send）", () => {
  it("本文を加工せずに送り、作られたら batchId を返す。作られていない・分からないもそのまま返す", async () => {
    const { driver, calls } = fakeDriver();
    const p = await port(driver).prepare(req());
    expect(await port(driver).send(p, 5)).toEqual({ ok: true, batchId: "b1" });
    expect(calls.send).toEqual([p.body]);
    for (const r of [{ ok: false, errorCode: "provider_error", notCreated: true }, { ok: false, errorCode: "rate_limited", billingUnknown: true }] as const) {
      expect(await port(fakeDriver({}, async () => r).driver).send(p, 5)).toEqual(r);
    }
  });

  it("思いがけない例外と、送る時間の上限を超えたものは billingUnknown（文は返さない）", async () => {
    const p = await port(fakeDriver().driver).prepare(req());
    const thrown = fakeDriver({}, async () => Promise.reject(new Error("request-id=req_secret123")));
    expect(await port(thrown.driver).send(p, 5)).toEqual({ ok: false, errorCode: "provider_error", billingUnknown: true });
    const slow = fakeDriver({}, () => new Promise(() => undefined));
    expect(await port(slow.driver, 20).send(p, 5)).toEqual({ ok: false, errorCode: "timeout", billingUnknown: true });
  });

  it("本文を書き換えた・customId が合わないものは送らない（RangeError）", async () => {
    const { driver, calls } = fakeDriver();
    const p = await port(driver).prepare(req());
    await expect(port(driver).send({ ...p, body: `${p.body} ` }, 5)).rejects.toThrow(RangeError);
    await expect(port(driver).send({ ...p, customId: `x-${p.sentBodyHash.slice(0, 16)}` }, 5)).rejects.toThrow(RangeError);
    expect(calls.send).toHaveLength(0);
  });

  it("手で組んだ値（依頼と違う本文・大きすぎる本文・違う出力の上限）は、ハッシュと customId が合っていても送らない", async () => {
    const { driver, calls } = fakeDriver();
    const forged = async (body: string, over: object = {}) => {
      const hash = await sha256Hex(new TextEncoder().encode(body));
      const p = await port(driver).prepare(req());
      return { ...p, body, sentBodyHash: hash, customId: `ai-1-20261110-${hash.slice(0, 16)}`, ...over };
    };
    await expect(port(driver).send(await forged(JSON.stringify({ id: "ai-1-20261110", messages: [{ role: "user", content: "あ".repeat(7000) }] })), 5)).rejects.toThrow(RangeError);
    const p = await port(driver).prepare(req());
    await expect(port(driver).send({ ...p, bodyMaxOutputTokens: 1 }, 5)).rejects.toThrow(RangeError);
    // 依頼の maxInputTokens を、本文のバイト数より小さく書き換えたもの
    await expect(port(driver).send({ ...p, request: { ...p.request, maxInputTokens: 10 } }, 5)).rejects.toThrow(RangeError);
    expect(calls.send).toHaveLength(0);
  });

  it("同じ予約（batchSeq）で2回は送らない（同じ口の中）", async () => {
    const { driver, calls } = fakeDriver();
    const bp = port(driver);
    const p = await bp.prepare(req());
    expect((await bp.send(p, 5)).ok).toBe(true);
    await expect(bp.send(p, 5)).rejects.toThrow(RangeError);
    expect(calls.send).toHaveLength(1);
  });
});

describe("探す（find）", () => {
  it("時刻の範囲（reservedAt の5分前〜15分後）を渡す。例外は unknown。予約の形が違えば RangeError", async () => {
    const seen: number[] = [];
    const { driver } = fakeDriver({ find: async (q) => (seen.push(q.from, q.to), { status: "found", batchId: "b9" }) });
    expect(await port(driver).find(reservation())).toEqual({ status: "found", batchId: "b9" });
    expect(seen).toEqual([AT - FIND_BEFORE_MS, AT + FIND_AFTER_MS]);
    expect(FIND_AFTER_MS).toBe(900_000);
    expect(await port(fakeDriver({ find: async () => Promise.reject(new Error("x")) }).driver).find(reservation())).toEqual({ status: "unknown" });
    await expect(port(driver).find(reservation({ provider: "other" }))).rejects.toThrow(RangeError);
  });
});

describe("受け取りと打ち切り", () => {
  const usage = { inputTokens: 20_000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  const succeeded: BatchOutcome = { kind: "succeeded", output: "{}", respondedModel: "m1-2026", usage, truncated: false };

  it("受け取り：費用は予約の料金で llmTokenCost ちょうど。本文の中の1件のID（customId の前半）で探す。上限で切れたら truncated", async () => {
    const { driver, calls } = fakeDriver({ outcome: async (_t, id) => (calls.itemIds.push(id), succeeded) });
    const r = await port(driver).collect(ticket());
    const cost = llmTokenCost(usage, { ...PRICE, yenPerUsd: 160 });
    expect(r).toEqual({ status: "closed", result: "collected", output: "{}", respondedModel: "m1-2026", usage: { inputTokens: 20_000, outputTokens: 1500, cost }, price: PRICE, finishedAt: AT + 1000 });
    expect(cost).toBe(44); // (20,000×1ドル＋1,500×5ドル)/100万 × 160円 ＝ 4.4円
    expect(calls.itemIds).toEqual(["ai-1-20261110"]);
    expect(await port(fakeDriver({ outcome: async () => ({ ...succeeded, truncated: true }) }).driver).collect(ticket())).toMatchObject({ result: "collected", truncated: true });
    // 費用を予約で見込めない答え：答えとトークン数はそのまま、費用は予約した費用で料金なし
    expect(await port(fakeDriver({ outcome: async () => ({ ...succeeded, costUnknown: true }) }).driver).collect(ticket())).toEqual({ status: "closed", result: "collected", output: "{}", respondedModel: "m1-2026", usage: { inputTokens: 20_000, outputTokens: 1500, cost: 160 }, costUnknown: true, finishedAt: AT + 1000 });
  });

  it("答えのないもの・トークン数が0のものは、予約した費用（costUnknown）。読めないときは pending", async () => {
    const unknown = fakeDriver({ outcome: async () => ({ kind: "costUnknown", result: "failed", errorCode: "provider_error" }) });
    expect(await port(unknown.driver).collect(ticket())).toEqual({ status: "closed", result: "failed", errorCode: "provider_error", usage: { inputTokens: 0, outputTokens: 0, cost: 160 }, costUnknown: true, finishedAt: AT + 1000 });
    for (const u of [{ ...usage, outputTokens: 0 }, { ...usage, inputTokens: 0 }]) {
      expect(await port(fakeDriver({ outcome: async () => ({ ...succeeded, usage: u }) }).driver).collect(ticket())).toMatchObject({ result: "failed", usage: { cost: 160 }, costUnknown: true });
    }
    expect(await port(fakeDriver({ outcome: async () => Promise.reject(new Error("x")) }).driver).collect(ticket())).toEqual({ status: "pending" });
    await expect(port(unknown.driver).collect(ticket({ provider: "other" }))).rejects.toThrow(RangeError);
  });

  it("打ち切り：終わっていなければ取り消しを頼み、まだ終わらなければ maxCost・costUnknown の expired", async () => {
    const { driver, calls } = fakeDriver();
    expect(await port(driver).abandon(ticket())).toEqual({ status: "closed", result: "expired", errorCode: "timeout", usage: { inputTokens: 0, outputTokens: 0, cost: 160 }, costUnknown: true, finishedAt: AT + 1000 });
    expect(calls.cancel).toBe(1);
  });

  it("打ち切り：終わってトークン数が取れたときだけ実際の値（答えは使わない）。0 なら costUnknown", async () => {
    const { driver, calls } = fakeDriver({ outcome: async () => succeeded });
    expect(await port(driver).abandon(ticket())).toEqual({ status: "closed", result: "expired", errorCode: "timeout", usage: { inputTokens: 20_000, outputTokens: 1500, cost: 44 }, price: PRICE, finishedAt: AT + 1000 });
    expect(calls.cancel).toBe(0);
    const zero = fakeDriver({ outcome: async () => ({ ...succeeded, usage: { ...usage, outputTokens: 0 } }) });
    expect(await port(zero.driver).abandon(ticket())).toMatchObject({ result: "expired", costUnknown: true, usage: { cost: 160 } });
  });

  it("費用と料金は控えの予約の料金で出す。今の料金表や口の円が控えと違っても、料金表からモデルが消えても選び直さない", async () => {
    const rp = { inputCentsPer10MTok: 2000, outputCentsPer10MTok: 8000, yenPerUsd: 150 };
    const t = ticket({ reservePrice: rp, maxCost: 1000 });
    const cost = llmTokenCost(usage, rp);
    expect(cost).toBe(78); // (20,000×2ドル＋1,500×8ドル)/100万 × 150円 ＝ 7.8円
    const price = { inputCentsPer10MTok: 2000, outputCentsPer10MTok: 8000 };
    for (const priceAt of [() => PRICE, () => undefined]) {
      const other = (d: BatchDriver) => new BatchPort(d, { policy: { dailyCostLimit: 1000, dryRun: false }, clock, yenPerUsd: 170 });
      expect(await other(fakeDriver({ priceAt, outcome: async () => succeeded }).driver).collect(t)).toMatchObject({ result: "collected", usage: { cost }, price });
      expect(await other(fakeDriver({ priceAt, outcome: async () => succeeded }).driver).abandon(t)).toMatchObject({ result: "expired", usage: { cost }, price });
    }
  });

  it("控えに予約の料金がない・1以上の整数でなければ RangeError", async () => {
    const { driver } = fakeDriver({ outcome: async () => succeeded });
    for (const reservePrice of [undefined, { ...PRICE, yenPerUsd: 0 }, { ...PRICE, inputCentsPer10MTok: 1.5, yenPerUsd: 160 }]) {
      const t = { ...ticket(), reservePrice } as unknown as LlmBatchTicket;
      await expect(port(driver).collect(t)).rejects.toThrow(RangeError);
      await expect(port(driver).abandon(t)).rejects.toThrow(RangeError);
    }
  });
});
