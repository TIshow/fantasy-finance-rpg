// Anthropic のバッチの口（LlmBatchPort）の試験。本物の API は呼ばない。応答は記録済みのもの（recorded/）を返す。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LlmBatchRequest, LlmBatchTicket } from "../../src/contracts";
import { sha256Hex } from "../../src/events/hash";
import { llmTokenCost } from "../../src/events/llm-cost";
import { AnthropicBatchClient } from "../../src/llm/anthropic-batch";
import { anthropicBatchPort, anthropicReservePrice } from "../../src/llm/anthropic-port";
import { BatchBudget, batchCustomIdOf } from "../../src/llm/batch-port";
import { batchCostDeciyen } from "../../src/llm/cost";

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
    budget: new BatchBudget({ dailyCostLimit: limit, dryRun: false }, async () => ({ used: 0, recordedKeys: new Set() })),
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

describe("Anthropic のバッチの口", () => {
  it("料金は100万トークンあたりの10倍（1,000万トークンあたりのセント）", () => {
    expect(anthropicReservePrice("claude-sonnet-5-5")).toEqual(PRICE);
    expect(anthropicReservePrice("claude-unknown")).toBeUndefined();
  });

  it("依頼：決まった本文を送り、そのバイト列のハッシュと控えを返す。temperature は送らない", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("anthropic-batch-created.json")));
    const r = await make(f).submit(req());
    const customId = await batchCustomIdOf("claude-ai", "2026-11-10");
    const body = `{"requests":[{"custom_id":"${customId}","params":{"model":"claude-sonnet-5-5","max_tokens":4000,"system":"あなたは投資家です","messages":[{"role":"user","content":"入力"}]}}]}`;
    expect(seen).toEqual([{ method: "POST", url: "https://api.anthropic.com/v1/messages/batches", body }]);
    expect(r).toEqual({
      ok: true,
      sentBodyHash: await sha256Hex(new TextEncoder().encode(body)),
      ticket: { agentId: "claude-ai", provider: "anthropic", modelId: "claude-sonnet-5-5", batchId: ID, customId, maxCost: 200, tradingDate: "2026-11-10", submittedAt: AT },
    });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("temperature・決まりと違う出力の上限・入力の上限を超える本文は、送る前に断る", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("anthropic-batch-created.json")));
    await expect(make(f).submit(req({ model: { provider: "anthropic", modelId: "claude-sonnet-5-5", settings: { max_tokens: "4000", temperature: "0" } } }))).rejects.toThrow(RangeError);
    // 出力の上限は 4,000。本文が 20,000 バイトを超える依頼は送らない（日本語1文字は3バイト）
    await expect(make(f).submit(req({ model: { provider: "anthropic", modelId: "claude-sonnet-5-5", settings: { max_tokens: "8000" } }, maxOutputTokens: 8000, maxCost: 1000 }))).rejects.toThrow(RangeError);
    await expect(make(f).submit(req({ messages: [{ role: "user", content: "あ".repeat(6700) }] }))).rejects.toThrow(/byte length/);
    expect(seen).toHaveLength(0);
  });

  it("作成の 529・503・通信断は作られたか分からない（billingUnknown）。400 は作られていない。エラー文は返さない", async () => {
    for (const [status, code] of [[529, "rate_limited"], [503, "provider_error"]] as const) {
      const { f } = fakeFetch(() => new Response('{"error":{"message":"request-id=req_secret123"}}', { status }));
      const r = await make(f).submit(req());
      expect(r).toMatchObject({ ok: false, errorCode: code, billingUnknown: true });
      expect(JSON.stringify(r)).not.toContain("secret");
    }
    const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed req_secret123")));
    expect(await make(down.f).submit(req())).toMatchObject({ ok: false, errorCode: "provider_error", billingUnknown: true });
    const bad = fakeFetch(() => new Response("{}", { status: 400 }));
    const r = await make(bad.f).submit(req());
    expect(r).toMatchObject({ ok: false, errorCode: "provider_error" });
    expect("billingUnknown" in r).toBe(false);
  });

  describe("受け取り", () => {
    const ticketFor = async (): Promise<LlmBatchTicket> => ({ agentId: "claude-ai", provider: "anthropic", modelId: "claude-sonnet-5-5", batchId: ID, customId: await batchCustomIdOf("claude-ai", "2026-11-10"), maxCost: 200, tradingDate: "2026-11-10", submittedAt: AT });
    /** 記録済みの結果の run-a（成功）・run-b（errored）・run-d（expired）を、依頼の customId に置き換える */
    const results = async (as: string) => recorded("anthropic-batch-results.jsonl").replace(`"${as}"`, `"${await batchCustomIdOf("claude-ai", "2026-11-10")}"`);
    const ended = (resultsBody: string) => fakeFetch((_m, url) => new Response(url.endsWith("/results") ? resultsBody : recorded("anthropic-batch-ended.json")));

    it("終わっていなければ pending。状態が読めなくても pending", async () => {
      expect(await make(fakeFetch(() => new Response(recorded("anthropic-batch-created.json"))).f).collect(await ticketFor())).toEqual({ status: "pending" });
      expect(await make(fakeFetch(() => new Response("", { status: 500 })).f).collect(await ticketFor())).toEqual({ status: "pending" });
    });

    it("成功：text の部分だけを出力にし、費用は予約の料金で数える（cost.ts と同じ値）", async () => {
      const r = await make(ended(await results("run-a")).f).collect(await ticketFor());
      const usage = { inputTokens: 20_000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
      expect(r).toEqual({ status: "closed", result: "collected", output: '{"post":null,"orders":[]}', respondedModel: "claude-sonnet-5-5", usage: { inputTokens: 20_000, outputTokens: 1500, cost: 44 }, price: PRICE, finishedAt: AT + 5000 });
      expect(llmTokenCost(usage, { ...PRICE, yenPerUsd: 160 })).toBe(batchCostDeciyen(usage, { inputCentsPerMTok: 100, outputCentsPerMTok: 500 }, 160));
      // 出力の上限（max_tokens）で止まった答えは truncated: true
      expect(await make(ended((await results("run-a")).replace('"end_turn"', '"max_tokens"')).f).collect(await ticketFor())).toMatchObject({ result: "collected", truncated: true });
    });

    it("errored・expired は課金されない（費用0）。結果にないときは課金が分からない（maxCost）", async () => {
      expect(await make(ended(await results("run-b")).f).collect(await ticketFor())).toMatchObject({ result: "failed", errorCode: "provider_error", usage: { cost: 0 }, price: PRICE });
      expect(await make(ended(await results("run-d")).f).collect(await ticketFor())).toMatchObject({ result: "expired", errorCode: "timeout", usage: { cost: 0 }, price: PRICE });
      expect(await make(ended(recorded("anthropic-batch-results.jsonl")).f).collect(await ticketFor())).toMatchObject({ result: "failed", usage: { cost: 200 }, costUnknown: true });
    });

    it("打ち切り：処理中なら取り消しを頼み、終わらなければ maxCost の expired", async () => {
      const { f, seen } = fakeFetch(() => new Response(recorded("anthropic-batch-created.json")));
      expect(await make(f).abandon(await ticketFor())).toEqual({ status: "closed", result: "expired", errorCode: "timeout", usage: { inputTokens: 0, outputTokens: 0, cost: 200 }, costUnknown: true, finishedAt: AT + 5000 });
      expect(seen.map((s) => `${s.method} ${s.url.replace("https://api.anthropic.com", "")}`)).toEqual([`GET /v1/messages/batches/${ID}`, `POST /v1/messages/batches/${ID}/cancel`, `GET /v1/messages/batches/${ID}`]);
    });
  });

  describe("記録にないバッチを探す", () => {
    const status = (id: string, createdAt: string) => ({ ...JSON.parse(recorded("anthropic-batch-ended.json")), id, created_at: createdAt });
    const q = { agentId: "claude-ai", tradingDate: "2026-11-10", since: AT - 600_000, now: AT, recordedBatchIds: new Set(["msgbatch_rec"]) };

    it("since より後に作られた、記録にないものを返す。古いものに届いたら止める", async () => {
      const page = { data: [status("msgbatch_new", "2026-11-09T07:36:00Z"), status("msgbatch_rec", "2026-11-09T07:35:30Z"), status("msgbatch_old", "2026-11-08T07:35:00Z")], has_more: true, first_id: "msgbatch_new", last_id: "msgbatch_old" };
      const { f, seen } = fakeFetch(() => new Response(JSON.stringify(page)));
      expect(await make(f).findUnrecorded(q)).toEqual({ kind: "found", batchIds: ["msgbatch_new"] });
      expect(seen).toHaveLength(1);
    });

    it("なければ none。一覧が読めなければ unknown", async () => {
      expect(await make(fakeFetch(() => new Response('{"data":[],"has_more":false,"first_id":null,"last_id":null}')).f).findUnrecorded(q)).toEqual({ kind: "none" });
      expect(await make(fakeFetch(() => new Response("", { status: 500 })).f).findUnrecorded(q)).toEqual({ kind: "unknown" });
    });
  });
});
