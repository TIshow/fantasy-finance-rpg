// Anthropic のバッチの口（fetch で呼ぶ部分）の試験。本物の API は呼ばない。応答は記録済みのもの（recorded/）を返す。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_VERSION, AnthropicBatchClient, anthropicApiKeyFromEnv, toAnthropicParams } from "../../src/llm/anthropic-batch";

const recorded = (name: string) => readFileSync(new URL(`./recorded/${name}`, import.meta.url), "utf8");
const KEY = "sk-ant-test-not-a-real-key";
const ID = "msgbatch_01HkcTjaV5uDC8jWR4ZsDV8d";

interface Seen {
  url: string;
  init: RequestInit;
}
/** 決まった応答を返す fetch。呼ばれた URL と中身を残す */
function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return respond(String(input));
  }) as typeof fetch;
  return { f, seen };
}
const client = (f: typeof fetch, timeoutMs?: number) => new AnthropicBatchClient({ apiKey: KEY, fetch: f, timeoutMs });
const params = toAnthropicParams({ provider: "anthropic", modelId: "claude-sonnet-5-5", settings: { max_tokens: "2000", temperature: "0.2" } }, [
  { role: "system", content: "あなたは投資家です" },
  { role: "user", content: "入力" },
]);

describe("Anthropic のバッチの口", () => {
  it("作成：決まった URL・見出し・中身で送り、状態を読む", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("anthropic-batch-created.json")));
    const r = await client(f).create([{ customId: "run-a", params }]);
    expect(r).toEqual({
      ok: true,
      value: { id: ID, processingStatus: "in_progress", counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 }, createdAt: Date.parse("2026-11-09T07:35:24.100435Z"), endedAt: null, expiresAt: Date.parse("2026-11-10T07:35:24.100435Z") },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages/batches");
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.headers).toEqual({ "x-api-key": KEY, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" });
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({
      requests: [{ custom_id: "run-a", params: { model: "claude-sonnet-5-5", max_tokens: 2000, temperature: 0.2, system: "あなたは投資家です", messages: [{ role: "user", content: "入力" }] } }],
    });
  });

  it("状態・取り消し・結果の URL", async () => {
    const { f, seen } = fakeFetch((url) => new Response(recorded(url.endsWith("/results") ? "anthropic-batch-results.jsonl" : "anthropic-batch-ended.json")));
    const c = client(f);
    expect(await c.retrieve(ID)).toMatchObject({ ok: true, value: { processingStatus: "ended", endedAt: Date.parse("2026-11-09T08:02:11Z") } });
    expect((await c.cancel(ID)).ok).toBe(true);
    expect((await c.results(ID)).ok).toBe(true);
    expect(seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      `GET https://api.anthropic.com/v1/messages/batches/${ID}`,
      `POST https://api.anthropic.com/v1/messages/batches/${ID}/cancel`,
      `GET https://api.anthropic.com/v1/messages/batches/${ID}/results`,
    ]);
  });

  it("結果：text の部分だけをつなぎ、トークン数を読む。失敗の結果に提供元のエラー文を入れない", async () => {
    const { f } = fakeFetch(() => new Response(recorded("anthropic-batch-results.jsonl")));
    const r = await client(f).results(ID);
    expect(r).toEqual({
      ok: true,
      value: [
        { customId: "run-b", type: "errored" },
        { customId: "run-a", type: "succeeded", output: '{"post":null,"orders":[]}', respondedModel: "claude-sonnet-5-5", stopReason: "end_turn", usage: { inputTokens: 20000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
        { customId: "run-c", type: "canceled" },
        { customId: "run-d", type: "expired" },
      ],
    });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("HTTP の失敗は状態コードだけを返し、本文（エラー文）を入れない", async () => {
    for (const [status, errorCode] of [[429, "rate_limited"], [529, "rate_limited"], [504, "timeout"], [401, "provider_error"], [500, "provider_error"]] as const) {
      const { f } = fakeFetch(() => new Response('{"type":"error","error":{"message":"request-id=req_secret123"}}', { status }));
      const r = await client(f).retrieve(ID);
      expect(r).toEqual({ ok: false, errorCode, status });
    }
  });

  it("通信断は provider_error、待ち時間切れは timeout。例外の文を入れない", async () => {
    const down = fakeFetch(() => Promise.reject(new Error("ECONNRESET request-id=req_secret123")));
    expect(await client(down.f).retrieve(ID)).toEqual({ ok: false, errorCode: "provider_error" });
    const hang = (async (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted request-id=req_secret123"))))) as typeof fetch;
    expect(await client(hang, 5).retrieve(ID)).toEqual({ ok: false, errorCode: "timeout" });
  });

  it("形が合わない応答は provider_error（中身は返さない）", async () => {
    for (const body of ["not json req_secret123", '{"type":"message_batch","id":"x"}', '{"custom_id":"a","result":{"type":"unknown"}}']) {
      const { f } = fakeFetch(() => new Response(body));
      expect(await client(f).retrieve(ID)).toEqual({ ok: false, errorCode: "provider_error", status: 200 });
      expect(await client(f).results(ID)).toEqual({ ok: false, errorCode: "provider_error", status: 200 });
    }
  });

  it("API キーは見出しに入れるだけで、クライアントを文字列にしても出ない", () => {
    const c = client(fakeFetch(() => new Response("")).f);
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(String(Object.keys(c))).not.toContain(KEY);
  });

  it("引数の誤りは呼ばずに RangeError", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("anthropic-batch-created.json")));
    const c = client(f);
    await expect(c.create([])).rejects.toThrow(RangeError);
    await expect(c.create([{ customId: "a/b", params }])).rejects.toThrow(RangeError);
    await expect(c.create([{ customId: "a", params }, { customId: "a", params }])).rejects.toThrow(RangeError);
    await expect(c.retrieve("../../v1/models")).rejects.toThrow(RangeError);
    expect(seen).toHaveLength(0);
    expect(() => new AnthropicBatchClient({ apiKey: "" })).toThrow(RangeError);
  });
});

describe("送る中身（toAnthropicParams）", () => {
  const model = (settings: Record<string, string>) => ({ provider: "anthropic", modelId: "claude-sonnet-5-5", settings });
  const user = [{ role: "user" as const, content: "x" }];

  it("system がなければ system を入れず、temperature がなければ入れない", () => {
    expect(toAnthropicParams(model({ max_tokens: "10" }), user)).toEqual({ model: "claude-sonnet-5-5", max_tokens: 10, messages: user });
  });

  it("決まりに合わない settings・messages は RangeError", () => {
    expect(() => toAnthropicParams(model({}), user)).toThrow(RangeError);
    expect(() => toAnthropicParams(model({ max_tokens: "0" }), user)).toThrow(RangeError);
    expect(() => toAnthropicParams(model({ max_tokens: "10", top_p: "0.5" }), user)).toThrow(RangeError);
    expect(() => toAnthropicParams(model({ max_tokens: "10", temperature: "1.5" }), user)).toThrow(RangeError);
    expect(() => toAnthropicParams(model({ max_tokens: "10" }), [])).toThrow(RangeError);
    expect(() => toAnthropicParams(model({ max_tokens: "10" }), [{ role: "system", content: "a" }])).toThrow(RangeError);
    expect(() => toAnthropicParams(model({ max_tokens: "10" }), [...user, { role: "system", content: "a" }])).toThrow(RangeError);
  });
});

describe("API キーの読み出し", () => {
  it("環境変数から読む。なければ、値を含まない Error", () => {
    expect(anthropicApiKeyFromEnv({ ANTHROPIC_API_KEY: KEY })).toBe(KEY);
    expect(() => anthropicApiKeyFromEnv({})).toThrow("ANTHROPIC_API_KEY is not set");
  });
});
