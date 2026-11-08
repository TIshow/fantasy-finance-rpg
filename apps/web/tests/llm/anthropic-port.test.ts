// Anthropic のバッチの口（LlmBatchPort）の試験。本物の API は呼ばない。応答は記録済みのもの（recorded/）を返す。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LlmBatchRequest, LlmBatchTicket } from "../../src/contracts";
import { sha256Hex } from "../../src/events/hash";
import { llmTokenCost } from "../../src/events/llm-cost";
import { AnthropicBatchClient } from "../../src/llm/anthropic-batch";
import { anthropicBatchPort, anthropicReservePrice } from "../../src/llm/anthropic-port";
import { BATCH_SEND_TIMEOUT_MS } from "../../src/llm/batch-port";
import { batchCostDeciyen } from "../../src/llm/cost";
import { hangingFetch, settledAt } from "./send-timeout";

const recorded = (name: string) => readFileSync(new URL(`./recorded/${name}`, import.meta.url), "utf8");
const KEY = "sk-ant-test-not-a-real-key";
const ID = "msgbatch_01HkcTjaV5uDC8jWR4ZsDV8d";
const AT = Date.parse("2026-11-09T07:35:00Z");
const PRICE = { inputCentsPer10MTok: 1000, outputCentsPer10MTok: 5000 };

function fakeFetch(respond: (method: string, url: string) => Response | Promise<Response>) {
  const seen: { method: string; url: string; body?: string }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ method: init?.method ?? "GET", url: String(input), body: init?.body as string | undefined });
    return respond(init?.method ?? "GET", String(input));
  }) as typeof fetch;
  return { f, seen };
}
const make = (f: typeof fetch, limit = 1000) =>
  anthropicBatchPort({
    policy: { dailyCostLimit: limit, dryRun: false },
    clock: { now: () => AT + 5000 },
    client: new AnthropicBatchClient({ apiKey: KEY, fetch: f }),
  });

const req = (over: Partial<LlmBatchRequest> = {}): LlmBatchRequest => ({
  agentId: "claude-ai",
  purpose: "order",
  model: { provider: "anthropic", modelId: "claude-sonnet-5-5", settings: { max_tokens: "4000" } },
  prompt: { id: "p", version: "1", hash: "0".repeat(64) },
  inputSeqs: [1],
  messages: [
    { role: "system", content: "あなたは投資家です" },
    { role: "user", content: "入力" },
  ],
  maxCost: 200,
  tradingDate: "2026-11-10",
  submittedAt: AT,
  reservePrice: { ...PRICE, yenPerUsd: 160 },
  maxInputTokens: 20_000,
  maxOutputTokens: 4000,
  ...over,
});

const CID = "claude-ai-20261110";
const BODY = `{"requests":[{"custom_id":"${CID}","params":{"model":"claude-sonnet-5-5","max_tokens":4000,"system":"あなたは投資家です","messages":[{"role":"user","content":"入力"}]}}]}`;

describe("Anthropic のバッチの口", () => {
  it("料金は100万トークンあたりの10倍（1,000万トークンあたりのセント）", () => {
    expect(anthropicReservePrice("claude-sonnet-5-5")).toEqual(PRICE);
    expect(anthropicReservePrice("claude-unknown")).toBeUndefined();
  });

  it("本文を作る：中の1件のIDは customId の前半。送るときは本文をそのまま送り、batchId を返す", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("anthropic-batch-created.json")));
    const p = await make(f).prepare(req());
    const hash = await sha256Hex(new TextEncoder().encode(BODY));
    expect(p).toMatchObject({ body: BODY, sentBodyHash: hash, customId: `${CID}-${hash.slice(0, 16)}`, bodyMaxOutputTokens: 4000 });
    expect(seen).toHaveLength(0);
    const r = await make(f).send(p, 7);
    expect(seen).toEqual([{ method: "POST", url: "https://api.anthropic.com/v1/messages/batches", body: BODY }]);
    expect(r).toEqual({ ok: true, batchId: ID });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("temperature・決まりと違う出力の上限・入力の上限を超える本文は、本文を作る前に断る", async () => {
    const { f } = fakeFetch(() => new Response(recorded("anthropic-batch-created.json")));
    await expect(make(f).prepare(req({ model: { provider: "anthropic", modelId: "claude-sonnet-5-5", settings: { max_tokens: "4000", temperature: "0" } } }))).rejects.toThrow(RangeError);
    // 出力の上限は 4,000。本文が 20,000 バイトを超える依頼は作らない（日本語1文字は3バイト）
    await expect(make(f).prepare(req({ model: { provider: "anthropic", modelId: "claude-sonnet-5-5", settings: { max_tokens: "8000" } }, maxOutputTokens: 8000, maxCost: 1000 }))).rejects.toThrow(RangeError);
    await expect(make(f).prepare(req({ messages: [{ role: "user", content: "あ".repeat(6700) }] }))).rejects.toThrow(/byte length/);
  });

  it("作成の 529・503・通信断は作られたか分からない（billingUnknown）。400 は作られていない（notCreated）。エラー文は返さない", async () => {
    const p = await make(fakeFetch(() => new Response("{}")).f).prepare(req());
    for (const [status, code] of [[529, "rate_limited"], [503, "provider_error"]] as const) {
      const { f } = fakeFetch(() => new Response('{"error":{"message":"request-id=req_secret123"}}', { status }));
      const r = await make(f).send(p, 7);
      expect(r).toEqual({ ok: false, errorCode: code, billingUnknown: true });
      expect(JSON.stringify(r)).not.toContain("secret");
    }
    const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed req_secret123")));
    expect(await make(down.f).send(p, 7)).toEqual({ ok: false, errorCode: "provider_error", billingUnknown: true });
    expect(await make(fakeFetch(() => new Response("{}", { status: 400 })).f).send(p, 7)).toEqual({ ok: false, errorCode: "provider_error", notCreated: true });
  });

  it("作成の待ち時間は送る時間の上限（10分）より短く、返らなければ通信を中断して billingUnknown（裏で送り続けない）", async () => {
    const p = await make(fakeFetch(() => new Response("{}")).f).prepare(req());
    const { f, state } = hangingFetch();
    let r: unknown;
    const at = await settledAt(async () => (r = await make(f).send(p, 7)), BATCH_SEND_TIMEOUT_MS);
    expect(at).not.toBeNull();
    expect(at!).toBeLessThan(BATCH_SEND_TIMEOUT_MS);
    expect(state).toEqual({ calls: 1, aborted: 1 });
    expect(r).toEqual({ ok: false, errorCode: "timeout", billingUnknown: true });
  });

  it("探す：名前も中身も確かめられないので、いつも not_found（提供元に問い合わせない）", async () => {
    const { f, seen } = fakeFetch(() => new Response("{}"));
    const hash = "c".repeat(64);
    expect(await make(f).find({ batchSeq: 3, agentId: "claude-ai", provider: "anthropic", modelId: "claude-sonnet-5-5", customId: `${CID}-${hash.slice(0, 16)}`, sentBodyHash: hash, reservedAt: AT, maxCost: 200, tradingDate: "2026-11-10", submittedAt: AT })).toEqual({ status: "not_found" });
    expect(seen).toHaveLength(0);
  });

  describe("受け取り", () => {
    const ticket: LlmBatchTicket = { batchSeq: 3, agentId: "claude-ai", provider: "anthropic", modelId: "claude-sonnet-5-5", customId: `${CID}-${"c".repeat(16)}`, sentBodyHash: "c".repeat(64), reservedAt: AT, maxCost: 200, tradingDate: "2026-11-10", submittedAt: AT, batchId: ID };
    /** 記録済みの結果の run-a（成功）・run-b（errored）・run-d（expired）を、本文の中の1件のIDに置き換える */
    const results = (as: string) => recorded("anthropic-batch-results.jsonl").replace(`"${as}"`, `"${CID}"`);
    const ended = (resultsBody: string) => fakeFetch((_m, url) => new Response(url.endsWith("/results") ? resultsBody : recorded("anthropic-batch-ended.json")));

    it("終わっていなければ pending。状態が読めなくても pending", async () => {
      expect(await make(fakeFetch(() => new Response(recorded("anthropic-batch-created.json"))).f).collect(ticket)).toEqual({ status: "pending" });
      expect(await make(fakeFetch(() => new Response("", { status: 500 })).f).collect(ticket)).toEqual({ status: "pending" });
    });

    it("成功：text の部分だけを出力にし、費用は予約の料金で数える（cost.ts と同じ値）。上限で止まったら truncated", async () => {
      const r = await make(ended(results("run-a")).f).collect(ticket);
      const usage = { inputTokens: 20_000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
      expect(r).toEqual({ status: "closed", result: "collected", output: '{"post":null,"orders":[]}', respondedModel: "claude-sonnet-5-5", usage: { inputTokens: 20_000, outputTokens: 1500, cost: 44 }, price: PRICE, finishedAt: AT + 5000 });
      expect(llmTokenCost(usage, { ...PRICE, yenPerUsd: 160 })).toBe(batchCostDeciyen(usage, { inputCentsPerMTok: 100, outputCentsPerMTok: 500 }, 160));
      expect(await make(ended(results("run-a").replace('"end_turn"', '"max_tokens"')).f).collect(ticket)).toMatchObject({ result: "collected", truncated: true });
      // キャッシュへの書き込みがあれば、入力の倍率1の予約で見込めないので、予約した費用（答えとトークン数はそのまま）
      const cached = await make(ended(results("run-a").replace('"cache_creation_input_tokens":null', '"cache_creation_input_tokens":3000')).f).collect(ticket);
      expect(cached).toMatchObject({ result: "collected", usage: { cacheCreationInputTokens: 3000, cost: 200 }, costUnknown: true });
      expect(cached).not.toHaveProperty("price");
    });

    it("errored・expired は資料では課金されないが、送ったバッチなので予約した費用（costUnknown）。結果にないときも同じ", async () => {
      expect(await make(ended(results("run-b")).f).collect(ticket)).toMatchObject({ result: "failed", errorCode: "provider_error", usage: { cost: 200 }, costUnknown: true });
      expect(await make(ended(results("run-d")).f).collect(ticket)).toMatchObject({ result: "expired", errorCode: "timeout", usage: { cost: 200 }, costUnknown: true });
      expect(await make(ended(recorded("anthropic-batch-results.jsonl")).f).collect(ticket)).toMatchObject({ result: "failed", usage: { cost: 200 }, costUnknown: true });
    });

    it("打ち切り：処理中なら取り消しを頼み、終わらなければ maxCost の expired", async () => {
      const { f, seen } = fakeFetch(() => new Response(recorded("anthropic-batch-created.json")));
      expect(await make(f).abandon(ticket)).toEqual({ status: "closed", result: "expired", errorCode: "timeout", usage: { inputTokens: 0, outputTokens: 0, cost: 200 }, costUnknown: true, finishedAt: AT + 5000 });
      expect(seen.map((s) => `${s.method} ${s.url.replace("https://api.anthropic.com", "")}`)).toEqual([`GET /v1/messages/batches/${ID}`, `POST /v1/messages/batches/${ID}/cancel`, `GET /v1/messages/batches/${ID}`]);
    });
  });
});
