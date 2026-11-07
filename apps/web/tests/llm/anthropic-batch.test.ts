// Anthropic のバッチの口（fetch で呼ぶ部分）の試験。本物の API は呼ばない。応答は記録済みのもの（recorded/）を返す。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/events/hash";
import {
  ANTHROPIC_VERSION,
  AnthropicBatchClient,
  anthropicApiKeyFromEnv,
  reconcileResults,
  toAnthropicParams,
  type BatchItemResult,
} from "../../src/llm/anthropic-batch";

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
const client = (f: typeof fetch, timeoutMs?: number, baseUrl?: string) => new AnthropicBatchClient({ apiKey: KEY, fetch: f, timeoutMs, baseUrl });
const params = toAnthropicParams({ provider: "anthropic", modelId: "claude-sonnet-5-5", settings: { max_tokens: "2000", temperature: "0.2" } }, [
  { role: "system", content: "あなたは投資家です" },
  { role: "user", content: "入力" },
]);
/** abort されるまで待ち、abort で秘密っぽい文の例外を投げる */
const abortable = (init?: RequestInit) =>
  new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted request-id=req_secret123", "AbortError"))));

describe("Anthropic のバッチの口", () => {
  it("作成：決まった URL・見出し・中身で送り、状態と、送った本文・そのハッシュを返す", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("anthropic-batch-created.json")));
    const r = await client(f).create([{ customId: "run-a", params }]);
    const body = seen[0]!.init.body as string;
    expect(r).toEqual({
      ok: true,
      value: { id: ID, processingStatus: "in_progress", counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 }, createdAt: Date.parse("2026-11-09T07:35:24.100435Z"), endedAt: null, expiresAt: Date.parse("2026-11-10T07:35:24.100435Z") },
      sent: { body, sha256: await sha256Hex(new TextEncoder().encode(body)) },
    });
    expect(r.sent.body).not.toContain(KEY);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages/batches");
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.redirect).toBe("error");
    expect(seen[0]!.init.headers).toEqual({ "x-api-key": KEY, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" });
    expect(JSON.parse(body)).toEqual({
      requests: [{ custom_id: "run-a", params: { model: "claude-sonnet-5-5", max_tokens: 2000, temperature: 0.2, system: "あなたは投資家です", messages: [{ role: "user", content: "入力" }] } }],
    });
  });

  it("状態・取り消し・結果の URL。末尾に / のある baseUrl でも / が重ならない", async () => {
    const { f, seen } = fakeFetch((url) => new Response(recorded(url.endsWith("/results") ? "anthropic-batch-results.jsonl" : "anthropic-batch-ended.json")));
    const c = client(f, undefined, "https://proxy.example.test/");
    expect(await c.retrieve(ID)).toMatchObject({ ok: true, value: { processingStatus: "ended", endedAt: Date.parse("2026-11-09T08:02:11Z") } });
    expect((await c.cancel(ID)).ok).toBe(true);
    expect((await c.results(ID)).ok).toBe(true);
    expect(seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      `GET https://proxy.example.test/v1/messages/batches/${ID}`,
      `POST https://proxy.example.test/v1/messages/batches/${ID}/cancel`,
      `GET https://proxy.example.test/v1/messages/batches/${ID}/results`,
    ]);
  });

  it("baseUrl は https: だけ", () => {
    for (const bad of ["http://api.anthropic.com", "ftp://x", "not a url", "https://user:pw@api.anthropic.com", "https://api.anthropic.com?x=1"]) {
      expect(() => new AnthropicBatchClient({ apiKey: KEY, baseUrl: bad })).toThrow(RangeError);
    }
  });

  it("一覧：limit・after_id・before_id を付け、data・has_more・first_id・last_id を読む", async () => {
    const ended = JSON.parse(recorded("anthropic-batch-ended.json"));
    const { f, seen } = fakeFetch(() => new Response(JSON.stringify({ data: [ended], has_more: true, first_id: ID, last_id: ID })));
    const r = await client(f).list({ limit: 20, afterId: "msgbatch_a", beforeId: "msgbatch_b" });
    expect(r).toMatchObject({ ok: true, value: { hasMore: true, firstId: ID, lastId: ID, data: [{ id: ID, processingStatus: "ended" }] } });
    expect(`${seen[0]!.init.method} ${seen[0]!.url}`).toBe("GET https://api.anthropic.com/v1/messages/batches?limit=20&after_id=msgbatch_a&before_id=msgbatch_b");
    const empty = fakeFetch(() => new Response('{"data":[],"has_more":false,"first_id":null,"last_id":null}'));
    expect(await client(empty.f).list()).toEqual({ ok: true, value: { data: [], hasMore: false, firstId: null, lastId: null } });
    expect(empty.seen[0]!.url).toBe("https://api.anthropic.com/v1/messages/batches");
    for (const bad of [{ limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { afterId: "../x" }, { beforeId: "a?b" }]) await expect(client(f).list(bad)).rejects.toThrow(RangeError);
  });

  it("結果：text の部分だけをつなぎ、トークン数を読む。errored は公式の一覧にあるエラーの種類だけを残し、エラー文を入れない", async () => {
    const { f } = fakeFetch(() => new Response(recorded("anthropic-batch-results.jsonl")));
    const r = await client(f).results(ID);
    expect(r).toEqual({
      ok: true,
      value: [
        { customId: "run-b", type: "errored", errorType: "invalid_request_error" },
        { customId: "run-a", type: "succeeded", output: '{"post":null,"orders":[]}', respondedModel: "claude-sonnet-5-5", stopReason: "end_turn", usage: { inputTokens: 20000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
        { customId: "run-c", type: "canceled" },
        { customId: "run-e", type: "errored" },
        { customId: "run-d", type: "expired" },
      ],
    });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("結果の1行が形に合わなければ、その行だけ malformed にして、ほかの行は生かす", async () => {
    const good = '{"custom_id":"ok-1","result":{"type":"canceled"}}';
    const lines = [good, "not json req_secret123", '{"custom_id":"bad-1","result":{"type":"unknown"}}', '{"custom_id":"a/b","result":{"type":"canceled"}}', '{"custom_id":"bad-2","result":{"type":"succeeded","message":{"model":"m","content":[],"usage":{"input_tokens":-1,"output_tokens":0},"stop_reason":null}}}'];
    const { f } = fakeFetch(() => new Response(lines.join("\n")));
    const r = await client(f).results(ID);
    expect(r).toEqual({
      ok: true,
      value: [
        { customId: "ok-1", type: "canceled" },
        { type: "malformed", line: 2 },
        { type: "malformed", line: 3, customId: "bad-1" },
        { type: "malformed", line: 4 },
        { type: "malformed", line: 5, customId: "bad-2" },
      ],
    });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("HTTP の失敗は状態コードだけを返し、本文（エラー文）を入れない", async () => {
    for (const [status, errorCode] of [[429, "rate_limited"], [529, "rate_limited"], [408, "timeout"], [504, "timeout"], [401, "provider_error"], [500, "provider_error"]] as const) {
      const { f } = fakeFetch(() => new Response('{"type":"error","error":{"message":"request-id=req_secret123"}}', { status }));
      const r = await client(f).retrieve(ID);
      expect(r).toEqual({ ok: false, errorCode, reason: "http", status });
    }
  });

  it("通信断は network、待ち時間切れは timeout、それ以外の例外は unexpected。例外の文を入れない", async () => {
    const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed ECONNRESET request-id=req_secret123")));
    expect(await client(down.f).retrieve(ID)).toEqual({ ok: false, errorCode: "provider_error", reason: "network" });
    const odd = fakeFetch(() => Promise.reject(new Error("weird request-id=req_secret123")));
    expect(await client(odd.f).retrieve(ID)).toEqual({ ok: false, errorCode: "provider_error", reason: "unexpected" });
    const hang = (async (_: RequestInfo | URL, init?: RequestInit) => abortable(init)) as typeof fetch;
    expect(await client(hang, 5).retrieve(ID)).toEqual({ ok: false, errorCode: "timeout", reason: "timeout" });
  });

  it("本文を読む途中の待ち時間切れは timeout（状態コードは付く）", async () => {
    const slowBody = (async (_: RequestInfo | URL, init?: RequestInit) => {
      const res = new Response("{}");
      Object.defineProperty(res, "text", { value: () => abortable(init) });
      return res;
    }) as typeof fetch;
    expect(await client(slowBody, 5).retrieve(ID)).toEqual({ ok: false, errorCode: "timeout", reason: "timeout", status: 200 });
  });

  it("作成：応答がない・408・5xx・2xx で形が合わないときは billingUnknown を付ける。ほかの 4xx は付けない", async () => {
    const item = [{ customId: "run-a", params }];
    const cases: [typeof fetch, Record<string, unknown>][] = [
      [fakeFetch(() => Promise.reject(new TypeError("fetch failed"))).f, { errorCode: "provider_error", reason: "network", billingUnknown: true }],
      [(async (_: RequestInfo | URL, init?: RequestInit) => abortable(init)) as typeof fetch, { errorCode: "timeout", reason: "timeout", billingUnknown: true }],
      [fakeFetch(() => new Response("", { status: 408 })).f, { errorCode: "timeout", reason: "http", status: 408, billingUnknown: true }],
      [fakeFetch(() => new Response("", { status: 500 })).f, { errorCode: "provider_error", reason: "http", status: 500, billingUnknown: true }],
      [fakeFetch(() => new Response("not json")).f, { errorCode: "provider_error", reason: "malformed", status: 200, billingUnknown: true }],
      [fakeFetch(() => new Response('{"type":"message_batch","id":"x"}')).f, { errorCode: "provider_error", reason: "malformed", status: 200, billingUnknown: true }],
    ];
    for (const [f, expected] of cases) {
      const r = await client(f, 5).create(item);
      expect(r).toMatchObject({ ok: false, ...expected });
      expect(r.sent.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const status of [400, 401, 429]) {
      const r = await client(fakeFetch(() => new Response("", { status })).f).create(item);
      expect(r.ok).toBe(false);
      expect(r).not.toHaveProperty("billingUnknown");
    }
  });

  it("形が合わない応答は provider_error（中身は返さない）", async () => {
    for (const body of ["not json req_secret123", '{"type":"message_batch","id":"x"}']) {
      const { f } = fakeFetch(() => new Response(body));
      expect(await client(f).retrieve(ID)).toEqual({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
      expect(await client(f).list()).toEqual({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
    }
  });

  it("API キーは見出しに入れるだけで、クライアントを文字列にしても出ない", () => {
    const c = client(fakeFetch(() => new Response("")).f);
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(String(Object.keys(c))).not.toContain(KEY);
  });

  it("引数の誤りは呼ばずに RangeError。customId は64文字まで", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("anthropic-batch-created.json")));
    const c = client(f);
    await expect(c.create([])).rejects.toThrow(RangeError);
    await expect(c.create([{ customId: "a/b", params }])).rejects.toThrow(RangeError);
    await expect(c.create([{ customId: "a".repeat(65), params }])).rejects.toThrow(RangeError);
    await expect(c.create([{ customId: "a", params }, { customId: "a", params }])).rejects.toThrow(RangeError);
    await expect(c.retrieve("../../v1/models")).rejects.toThrow(RangeError);
    expect(seen).toHaveLength(0);
    expect((await c.create([{ customId: "a".repeat(64), params }])).ok).toBe(true);
    expect(() => new AnthropicBatchClient({ apiKey: "" })).toThrow(RangeError);
  });
});

describe("結果の突き合わせ（reconcileResults）", () => {
  it("重なった customId と依頼にない customId は信じず、形が合わない行は数える", () => {
    const items: BatchItemResult[] = [
      { customId: "a", type: "canceled" },
      { customId: "b", type: "expired" },
      { customId: "b", type: "canceled" },
      { customId: "zzz", type: "canceled" },
      { type: "malformed", line: 5, customId: "c" },
    ];
    const r = reconcileResults(["a", "b", "c", "d"], items);
    expect([...r.matched.entries()]).toEqual([["a", { customId: "a", type: "canceled" }]]);
    expect(r.duplicated).toEqual(["b"]);
    expect(r.missing).toEqual(["c", "d"]);
    expect(r.unexpected).toBe(1);
    expect(r.malformed).toBe(1);
  });
});

describe("送る中身（toAnthropicParams）", () => {
  const model = (settings: Record<string, string>) => ({ provider: "anthropic", modelId: "claude-sonnet-5-5", settings });
  const user = [{ role: "user" as const, content: "x" }];

  it("system がなければ system を入れず、temperature がなければ入れない", () => {
    expect(toAnthropicParams(model({ max_tokens: "10" }), user)).toEqual({ model: "claude-sonnet-5-5", max_tokens: 10, messages: user });
  });

  it("数値の書き方は1つだけ受け付ける", () => {
    for (const t of ["0", "1", "0.2", "0.25", "0.001", "0.999"]) expect(toAnthropicParams(model({ max_tokens: "10", temperature: t }), user).temperature).toBe(Number(t));
    for (const t of ["0.20", "1.0", "1.001", "0.", ".5", "00.5", "0.0", "0.1234", "1.5", "-0", "+0.5", " 0.5", "0.5e0"]) {
      expect(() => toAnthropicParams(model({ max_tokens: "10", temperature: t }), user), t).toThrow(RangeError);
    }
    for (const m of ["0", "010", "1.0", "+1", "-1", "1e3", " 10", "1234567890"]) expect(() => toAnthropicParams(model({ max_tokens: m }), user), m).toThrow(RangeError);
  });

  it("決まりに合わない settings・messages は RangeError", () => {
    expect(() => toAnthropicParams(model({}), user)).toThrow(RangeError);
    expect(() => toAnthropicParams(model({ max_tokens: "10", top_p: "0.5" }), user)).toThrow(RangeError);
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
