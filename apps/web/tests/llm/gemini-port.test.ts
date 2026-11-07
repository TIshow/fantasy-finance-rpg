// Gemini のバッチの口（LlmBatchPort）の試験。本物の API は呼ばない。応答は記録済みのもの（recorded/）を作り変えて返す。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LlmBatchRequest, LlmBatchTicket } from "../../src/contracts";
import { sha256Hex } from "../../src/events/hash";
import { BatchBudget, batchCustomIdOf } from "../../src/llm/batch-port";
import { GEMINI_CREATE_SETTLE_MS, GeminiBatchClient } from "../../src/llm/gemini-batch";
import { GEMINI_PRICE_SWITCH_AT } from "../../src/llm/gemini-pricing";
import { geminiBatchPort, geminiReservePrice } from "../../src/llm/gemini-port";

const recorded = (name: string) => readFileSync(new URL(`./recorded/${name}`, import.meta.url), "utf8");
const KEY = "AIza-test-not-a-real-key";
const ID = "k7qpd2x1v9m3abcd";
const AT = Date.parse("2026-11-09T07:35:00Z");
const PRICE = { inputCentsPer10MTok: 375, outputCentsPer10MTok: 1875 };
const CID = await batchCustomIdOf("gemini-ai", "2026-11-10");

function fakeFetch(respond: (method: string, url: string) => Response | Promise<Response>) {
  const seen: { method: string; path: string; body?: string }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    seen.push({ method, path: String(input).replace("https://generativelanguage.googleapis.com", ""), body: init?.body as string | undefined });
    return respond(method, String(input));
  }) as typeof fetch;
  return { f, seen };
}
const make = (f: typeof fetch) =>
  geminiBatchPort({
    budget: new BatchBudget({ dailyCostLimit: 1000, dryRun: false }, async () => ({ used: 0, recordedKeys: new Set() })),
    clock: { now: () => AT + 5000 },
    client: new GeminiBatchClient({ apiKey: KEY, fetch: f }),
  });
/** 記録済みの状態を、この依頼の名前（customId）にしたもの */
const created = () => recorded("gemini-batch-created.json").replace("ffr-2026-11-09-a1b2c3", CID);
/** 記録済みの終わったバッチから、key の1件だけを残し、依頼の customId に置き換えたもの */
function finished(key: string, state = "BATCH_STATE_SUCCEEDED") {
  const j = JSON.parse(recorded("gemini-batch-succeeded.json"));
  const list = j.response.inlinedResponses.inlinedResponses.filter((x: { metadata: { key: string } }) => x.metadata.key === key);
  for (const x of list) x.metadata.key = CID;
  j.response.inlinedResponses.inlinedResponses = list;
  j.metadata = { ...j.metadata, displayName: CID, state, batchStats: { requestCount: String(list.length) } };
  return JSON.stringify(j);
}

const req = (over: Partial<LlmBatchRequest> = {}): LlmBatchRequest => ({
  agentId: "gemini-ai",
  purpose: "order",
  model: { provider: "google", modelId: "gemini-3.8-flash", settings: { max_tokens: "8000", thinking_level: "low" } },
  prompt: { id: "p", version: "1", hash: "0".repeat(64) },
  inputSeqs: [1],
  messages: [
    { role: "system", content: "あなたは投資家です" },
    { role: "user", content: "入力" },
  ],
  maxCost: 100,
  tradingDate: "2026-11-10",
  submittedAt: AT,
  reservePrice: { ...PRICE, yenPerUsd: 160 },
  maxInputTokens: 50_000,
  maxOutputTokens: 8000,
  ...over,
});
const ticket = (over: Partial<LlmBatchTicket> = {}): LlmBatchTicket => ({ agentId: "gemini-ai", provider: "google", modelId: "gemini-3.8-flash", batchId: ID, customId: CID, maxCost: 100, tradingDate: "2026-11-10", submittedAt: AT, ...over });

describe("Gemini のバッチの口", () => {
  it("予約の料金は submittedAt で選ぶ（値上げの48時間前からは高いほう）", () => {
    expect(geminiReservePrice("gemini-3.8-flash", AT)).toEqual(PRICE);
    expect(geminiReservePrice("gemini-3.8-flash", GEMINI_PRICE_SWITCH_AT - 1000)).toEqual({ inputCentsPer10MTok: 750, outputCentsPer10MTok: 3750 });
    expect(geminiReservePrice("gemini-unknown", AT)).toBeUndefined();
  });

  it("依頼：名前を customId にした決まった本文を送り、そのハッシュと控えを返す。temperature は送らない", async () => {
    const { f, seen } = fakeFetch(() => new Response(created()));
    const r = await make(f).submit(req());
    const body = `{"batch":{"model":"models/gemini-3.8-flash","displayName":"${CID}","inputConfig":{"requests":{"requests":[{"request":{"systemInstruction":{"parts":[{"text":"あなたは投資家です"}]},"contents":[{"role":"user","parts":[{"text":"入力"}]}],"generationConfig":{"maxOutputTokens":8000,"thinkingConfig":{"thinkingLevel":"LOW"}}},"metadata":{"key":"${CID}"}}]}}}}`;
    expect(seen).toEqual([{ method: "POST", path: "/v1/models/gemini-3.8-flash:batchGenerateContent", body }]);
    expect(r).toEqual({
      ok: true,
      sentBodyHash: await sha256Hex(new TextEncoder().encode(body)),
      ticket: { agentId: "gemini-ai", provider: "google", modelId: "gemini-3.8-flash", batchId: ID, customId: CID, maxCost: 100, tradingDate: "2026-11-10", submittedAt: AT },
    });
  });

  it("値上げをまたぐ依頼は、高い料金で予約しなければ断る。temperature も断る", async () => {
    const { f, seen } = fakeFetch(() => new Response(created()));
    const late = GEMINI_PRICE_SWITCH_AT - 3_600_000;
    await expect(make(f).submit(req({ submittedAt: late }))).rejects.toThrow(RangeError);
    await expect(make(f).submit(req({ model: { provider: "google", modelId: "gemini-3.8-flash", settings: { max_tokens: "8000", temperature: "0" } } }))).rejects.toThrow(RangeError);
    expect(seen).toHaveLength(0);
  });

  it("作成の応答の名前が違えば、作られたか分からない（billingUnknown）", async () => {
    const { f } = fakeFetch(() => new Response(recorded("gemini-batch-created.json")));
    expect(await make(f).submit(req())).toMatchObject({ ok: false, errorCode: "provider_error", billingUnknown: true });
  });

  describe("受け取り", () => {
    it("処理中は pending。読めなくても pending", async () => {
      expect(await make(fakeFetch(() => new Response(created())).f).collect(ticket())).toEqual({ status: "pending" });
      expect(await make(fakeFetch(() => new Response("", { status: 500 })).f).collect(ticket())).toEqual({ status: "pending" });
    });

    it("成功：考えた過程を除いた出力。費用は予約の料金で、考えた過程のトークンも出力に数える", async () => {
      // (20,000×0.375ドル＋4,500×1.875ドル)/100万 ＝ 0.0159375ドル × 160円 ＝ 2.55円 → 2.6円
      expect(await make(fakeFetch(() => new Response(finished("run-a"))).f).collect(ticket())).toEqual({ status: "closed", result: "collected", output: '{"post":null,"orders":[]}', respondedModel: "gemini-3.8-flash", usage: { inputTokens: 20_000, outputTokens: 4500, cost: 26 }, price: PRICE, finishedAt: AT + 5000 });
    });

    it("値上げをまたいだバッチも、予約の料金（submittedAt で選んだ料金）で閉じる", async () => {
      const at = GEMINI_PRICE_SWITCH_AT - 50 * 3_600_000;
      const r = await make(fakeFetch(() => new Response(finished("run-a"))).f).collect(ticket({ submittedAt: at }));
      expect(r).toMatchObject({ result: "collected", price: geminiReservePrice("gemini-3.8-flash", at) });
    });

    it("失敗した1件・バッチの失敗・期限切れで結果がないものは、課金が分からない（maxCost）。エラー文は返さない", async () => {
      const errored = await make(fakeFetch(() => new Response(finished("run-b"))).f).collect(ticket());
      expect(errored).toMatchObject({ result: "failed", errorCode: "provider_error", usage: { cost: 100 }, costUnknown: true });
      expect(JSON.stringify(errored)).not.toContain("secret");
      expect(await make(fakeFetch(() => new Response(finished("none", "BATCH_STATE_EXPIRED"))).f).collect(ticket())).toMatchObject({ result: "expired", errorCode: "timeout", costUnknown: true });
      expect(await make(fakeFetch(() => new Response(finished("none", "BATCH_STATE_FAILED"))).f).collect(ticket())).toMatchObject({ result: "failed", costUnknown: true });
    });

    it("打ち切り：処理中なら取り消しを頼み、終わらなければ maxCost の expired", async () => {
      const { f, seen } = fakeFetch((m) => new Response(m === "POST" ? "" : created()));
      expect(await make(f).abandon(ticket())).toMatchObject({ result: "expired", errorCode: "timeout", usage: { cost: 100 }, costUnknown: true });
      expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([`GET /v1/batches/${ID}`, `POST /v1/batches/${ID}:cancel`, `GET /v1/batches/${ID}`]);
    });
  });

  describe("記録にないバッチを探す（名前で探す）", () => {
    const list = (...ops: string[]) => fakeFetch(() => new Response(`{"operations":[${ops.join(",")}]}`)).f;
    const q = (over = {}) => ({ agentId: "gemini-ai", tradingDate: "2026-11-10", since: AT, now: AT + GEMINI_CREATE_SETTLE_MS + 1, recordedBatchIds: new Set<string>(), ...over });

    it("あれば found、記録にあるものなら none。なければ、1時間たっていれば none、たっていなければ unknown", async () => {
      expect(await make(list(created())).findUnrecorded(q())).toEqual({ kind: "found", batchIds: [ID] });
      expect(await make(list(created())).findUnrecorded(q({ recordedBatchIds: new Set([ID]) }))).toEqual({ kind: "none" });
      expect(await make(list()).findUnrecorded(q())).toEqual({ kind: "none" });
      expect(await make(list()).findUnrecorded(q({ now: AT + 60_000 }))).toEqual({ kind: "unknown" });
    });

    it("同じ名前が2つなら記録にないものを返す。一覧が読めなければ unknown", async () => {
      expect(await make(list(created(), created().replaceAll(ID, "zz9"))).findUnrecorded(q({ recordedBatchIds: new Set([ID]) }))).toEqual({ kind: "found", batchIds: ["zz9"] });
      expect(await make(fakeFetch(() => new Response("", { status: 500 })).f).findUnrecorded(q())).toEqual({ kind: "unknown" });
    });
  });
});
