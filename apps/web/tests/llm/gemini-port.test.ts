// Gemini のバッチの口（LlmBatchPort）の試験。本物の API は呼ばない。応答は記録済みのもの（recorded/）を作り変えて返す。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LlmBatchRequest, LlmBatchTicket } from "../../src/contracts";
import { sha256Hex } from "../../src/events/hash";
import { GeminiBatchClient } from "../../src/llm/gemini-batch";
import { llmTokenCost } from "../../src/events/llm-cost";
import { GEMINI_PRICE_SWITCH_AT } from "../../src/llm/gemini-pricing";
import { GEMINI_MAX_OUTPUT_TOKENS, geminiBatchPort, geminiReservePrice } from "../../src/llm/gemini-port";
import { BATCH_SEND_TIMEOUT_MS } from "../../src/llm/batch-port";
import { hangingFetch, settledAt } from "./send-timeout";

const recorded = (name: string) => readFileSync(new URL(`./recorded/${name}`, import.meta.url), "utf8");
const KEY = "AIza-test-not-a-real-key";
const ID = "k7qpd2x1v9m3abcd";
const AT = Date.parse("2026-11-09T07:35:00Z");
const PRICE = { inputCentsPer10MTok: 375, outputCentsPer10MTok: 1875 };
/** 本文の中の1件のID（表示名と1件のキー）。customId の前半 */
const CID = "gemini-ai-20261110";

function fakeFetch(respond: (method: string, url: string) => Response | Promise<Response>) {
  const seen: { method: string; path: string; body?: string }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    seen.push({ method, path: String(input).replace("https://generativelanguage.googleapis.com", ""), body: init?.body as string | undefined });
    return respond(method, String(input));
  }) as typeof fetch;
  return { f, seen };
}
const make = (f: typeof fetch, now = AT + 5000) =>
  geminiBatchPort({
    policy: { dailyCostLimit: 1000, dryRun: false },
    clock: { now: () => now },
    client: new GeminiBatchClient({ apiKey: KEY, fetch: f }),
  });
/** 記録済みの状態を、この依頼の表示名にしたもの */
const created = () => recorded("gemini-batch-created.json").replace("ffr-2026-11-09-a1b2c3", CID);
/** 記録済みの終わったバッチから、key の1件だけを残し、本文の中の1件のIDに置き換えたもの */
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
  // (20,000×0.375ドル＋8,000×1.875ドル)/100万 × 160円 ＝ 3.6円
  maxCost: 36,
  tradingDate: "2026-11-10",
  submittedAt: AT,
  reservePrice: { ...PRICE, yenPerUsd: 160 },
  maxInputTokens: 20_000,
  maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
  ...over,
});
const ticket = (over: Partial<LlmBatchTicket> = {}): LlmBatchTicket => ({ batchSeq: 3, agentId: "gemini-ai", provider: "google", modelId: "gemini-3.8-flash", customId: `${CID}-${"c".repeat(16)}`, sentBodyHash: "c".repeat(64), reservedAt: AT, maxCost: 100, tradingDate: "2026-11-10", submittedAt: AT, batchId: ID, ...over });

describe("Gemini のバッチの口", () => {
  it("予約の料金は submittedAt で選ぶ（値上げの48時間前からは高いほう）", () => {
    expect(geminiReservePrice("gemini-3.8-flash", AT)).toEqual(PRICE);
    expect(geminiReservePrice("gemini-3.8-flash", GEMINI_PRICE_SWITCH_AT - 1000)).toEqual({ inputCentsPer10MTok: 750, outputCentsPer10MTok: 3750 });
    expect(geminiReservePrice("gemini-unknown", AT)).toBeUndefined();
  });

  it("本文：表示名と1件のキーは customId の前半。送るときは本文をそのまま送り、batchId を返す", async () => {
    const { f, seen } = fakeFetch(() => new Response(created()));
    const body = `{"batch":{"model":"models/gemini-3.8-flash","displayName":"${CID}","inputConfig":{"requests":{"requests":[{"request":{"systemInstruction":{"parts":[{"text":"あなたは投資家です"}]},"contents":[{"role":"user","parts":[{"text":"入力"}]}],"generationConfig":{"maxOutputTokens":8000,"thinkingConfig":{"thinkingLevel":"LOW"}}},"metadata":{"key":"${CID}"}}]}}}}`;
    const hash = await sha256Hex(new TextEncoder().encode(body));
    const p = await make(f).prepare(req());
    expect(p).toMatchObject({ body, sentBodyHash: hash, customId: `${CID}-${hash.slice(0, 16)}`, bodyMaxOutputTokens: 8000 });
    expect(await make(f).send(p, 7)).toEqual({ ok: true, batchId: ID });
    expect(seen).toEqual([{ method: "POST", path: "/v1/models/gemini-3.8-flash:batchGenerateContent", body }]);
  });

  it("出力の上限は 8,000。違う max_tokens・足りない予約・20,000 バイトを超える本文・temperature・値上げをまたぐのに安い料金は断る", async () => {
    const { f } = fakeFetch(() => new Response(created()));
    await expect(make(f).prepare(req({ model: { provider: "google", modelId: "gemini-3.8-flash", settings: { max_tokens: "65536" } }, maxOutputTokens: 65_536, maxCost: 1000 }))).rejects.toThrow(RangeError);
    await expect(make(f).prepare(req({ maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS - 1 }))).rejects.toThrow(RangeError);
    expect(llmTokenCost({ inputTokens: 20_000, outputTokens: GEMINI_MAX_OUTPUT_TOKENS }, { ...PRICE, yenPerUsd: 160 })).toBe(36);
    await expect(make(f).prepare(req({ maxCost: 35 }))).rejects.toThrow(RangeError);
    await expect(make(f).prepare(req({ messages: [{ role: "user", content: "あ".repeat(6700) }] }))).rejects.toThrow(/byte length/);
    await expect(make(f).prepare(req({ model: { provider: "google", modelId: "gemini-3.8-flash", settings: { max_tokens: "8000", temperature: "0" } } }))).rejects.toThrow(RangeError);
    const late = GEMINI_PRICE_SWITCH_AT - 3_600_000;
    await expect(make(f, late + 5000).prepare(req({ submittedAt: late }))).rejects.toThrow(RangeError);
  });

  it("作成の応答の名前が違えば分からない（billingUnknown）。400 は作られていない（notCreated）", async () => {
    const p = await make(fakeFetch(() => new Response("{}")).f).prepare(req());
    expect(await make(fakeFetch(() => new Response(recorded("gemini-batch-created.json"))).f).send(p, 7)).toEqual({ ok: false, errorCode: "provider_error", billingUnknown: true });
    expect(await make(fakeFetch(() => new Response("{}", { status: 400 })).f).send(p, 7)).toEqual({ ok: false, errorCode: "provider_error", notCreated: true });
  });

  it("作成の待ち時間は送る時間の上限（10分）より短く、返らなければ通信を中断して billingUnknown（裏で送り続けない）", async () => {
    const p = await make(fakeFetch(() => new Response("{}")).f).prepare(req());
    const { f, state } = hangingFetch();
    let r: unknown;
    expect(await settledAt(async () => (r = await make(f).send(p, 7)), BATCH_SEND_TIMEOUT_MS)).toBeLessThan(BATCH_SEND_TIMEOUT_MS);
    expect(state).toEqual({ calls: 1, aborted: 1 });
    expect(r).toEqual({ ok: false, errorCode: "timeout", billingUnknown: true });
  });

  it("探す：表示名は本文の中にあり customId を持てないので、いつも not_found（提供元に問い合わせない）", async () => {
    const { f, seen } = fakeFetch(() => new Response(created()));
    const { batchId: _b, ...reservation } = ticket();
    expect(await make(f).find(reservation)).toEqual({ status: "not_found" });
    expect(seen).toHaveLength(0);
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

    it("考えた過程と合計の残りを出力に数えても、出力の上限までなら費用は maxCost を超えない。上限で止まった答えは truncated: true", async () => {
      const j = JSON.parse(finished("run-a"));
      const usage = j.response.inlinedResponses.inlinedResponses[0].response.usageMetadata;
      Object.assign(usage, { promptTokenCount: 20_000, candidatesTokenCount: 3000, thoughtsTokenCount: 4000, totalTokenCount: 20_000 + GEMINI_MAX_OUTPUT_TOKENS });
      j.response.inlinedResponses.inlinedResponses[0].response.candidates[0].finishReason = "MAX_TOKENS";
      const r = await make(fakeFetch(() => new Response(JSON.stringify(j))).f).collect(ticket({ maxCost: 36 }));
      expect(r).toMatchObject({ result: "collected", truncated: true, usage: { inputTokens: 20_000, outputTokens: GEMINI_MAX_OUTPUT_TOKENS } });
      if (r.status !== "closed") throw new Error("pending");
      expect(r.usage.cost).toBeLessThanOrEqual(36);
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
});
