// Gemini のバッチの口（fetch で呼ぶ部分）の試験。本物の API は呼ばない。応答は記録済みのもの（recorded/）を返す。
// 記録済みの応答は、公式の資料（https://ai.google.dev/api/batch-mode）の形から作った。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/events/hash";
import {
  GEMINI_MAX_BODY_BYTES,
  GeminiBatchClient,
  geminiApiKeyFromEnv,
  reconcileGeminiResults,
  toGeminiRequest,
  type GeminiItemResult,
  type GeminiRequest,
} from "../../src/llm/gemini-batch";

const recorded = (name: string) => readFileSync(new URL(`./recorded/${name}`, import.meta.url), "utf8");
const KEY = "AIza-test-not-a-real-key";
const ID = "k7qpd2x1v9m3abcd";
const NAME = "ffr-2026-11-09-a1b2c3";
const MODEL = "gemini-3.8-flash";

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
const client = (f: typeof fetch, timeoutMs?: number, baseUrl?: string) => new GeminiBatchClient({ apiKey: KEY, fetch: f, timeoutMs, resultsTimeoutMs: timeoutMs, baseUrl });
const request = toGeminiRequest({ provider: "google", modelId: MODEL, settings: { max_tokens: "8000", thinking_level: "low" } }, [
  { role: "system", content: "あなたは投資家です" },
  { role: "user", content: "入力" },
]);
const item = [{ customId: "run-a", request }];
/** abort されるまで待ち、abort で秘密っぽい文の例外を投げる */
const abortable = (init?: RequestInit) =>
  new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted request-id=req_secret123", "AbortError"))));

describe("Gemini のバッチの口", () => {
  it("作成：決まった URL・見出し・中身で送り、状態と、送った本文・そのハッシュを返す。キーは URL に入れない", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("gemini-batch-created.json")));
    const r = await client(f).create(MODEL, NAME, item);
    const body = seen[0]!.init.body as string;
    expect(r).toEqual({
      ok: true,
      value: {
        id: ID,
        state: "pending",
        done: false,
        model: "models/gemini-3.8-flash",
        displayName: NAME,
        counts: { requests: 3, succeeded: 0, failed: 0, pending: 3 },
        createdAt: Date.parse("2026-11-09T07:35:24.100435Z"),
        updatedAt: Date.parse("2026-11-09T07:35:24.100435Z"),
        endedAt: null,
      },
      sent: { body, sha256: await sha256Hex(new TextEncoder().encode(body)) },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://generativelanguage.googleapis.com/v1/models/gemini-3.8-flash:batchGenerateContent");
    expect(seen[0]!.url).not.toContain(KEY);
    expect(r.sent.body).not.toContain(KEY);
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.redirect).toBe("error");
    expect(seen[0]!.init.headers).toEqual({ "x-goog-api-key": KEY, "content-type": "application/json" });
    expect(body).toBe(
      JSON.stringify({
        batch: {
          model: "models/gemini-3.8-flash",
          displayName: NAME,
          inputConfig: {
            requests: {
              requests: [
                {
                  request: {
                    systemInstruction: { parts: [{ text: "あなたは投資家です" }] },
                    contents: [{ role: "user", parts: [{ text: "入力" }] }],
                    generationConfig: { maxOutputTokens: 8000, thinkingConfig: { thinkingLevel: "LOW" } },
                  },
                  metadata: { key: "run-a" },
                },
              ],
            },
          },
        },
      }),
    );
  });

  it("作成：型をすり抜けた余分な欄（tools など）は送らず、決まった欄・順に組み立て直す。形が違えば呼ばずに RangeError", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("gemini-batch-created.json")));
    const sneaky = { ...request, tools: [{ googleSearch: {} }], generationConfig: { ...request.generationConfig, temperature: 2 } } as unknown as GeminiRequest;
    await client(f).create(MODEL, NAME, [{ customId: "run-a", request: sneaky }]);
    const sent = JSON.parse(seen[0]!.init.body as string);
    expect(sent.batch.inputConfig.requests.requests[0].request).toEqual(request);
    const bad = [
      { ...request, contents: [] },
      { ...request, contents: [{ role: "model", parts: [{ text: "x" }] }] },
      { ...request, contents: [{ role: "user", parts: [{ text: "x" }, { text: "y" }] }] },
      { ...request, contents: [{ role: "user", parts: [{ inlineData: { data: "x" } }] }] },
      { ...request, generationConfig: { maxOutputTokens: 1.5 } },
      { ...request, generationConfig: { maxOutputTokens: 10, thinkingConfig: { thinkingLevel: "MINIMAL" } } },
      { ...request, systemInstruction: { parts: [{ text: "a", thought: true }] } },
    ] as unknown as GeminiRequest[];
    for (const b of bad) await expect(client(f).create(MODEL, NAME, [{ customId: "run-a", request: b }])).rejects.toThrow(RangeError);
    expect(seen).toHaveLength(1);
  });

  it("状態・取り消し・結果の URL。末尾に / のある baseUrl でも / が重ならない", async () => {
    const { f, seen } = fakeFetch((url) => new Response(url.endsWith(":cancel") ? "{}" : recorded("gemini-batch-succeeded.json")));
    const c = client(f, undefined, "https://proxy.example.test/base/");
    expect(await c.retrieve(ID)).toMatchObject({ ok: true, value: { state: "succeeded", done: true, endedAt: Date.parse("2026-11-09T08:02:11Z") } });
    expect(await c.cancel(ID)).toEqual({ ok: true, value: null });
    expect((await c.results(ID)).ok).toBe(true);
    expect(seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      `GET https://proxy.example.test/base/v1/batches/${ID}`,
      `POST https://proxy.example.test/base/v1/batches/${ID}:cancel`,
      `GET https://proxy.example.test/base/v1/batches/${ID}`,
    ]);
    expect(seen.every((s) => !s.url.includes(KEY))).toBe(true);
  });

  it("baseUrl は https: だけ。空の ? や # も断る", () => {
    for (const bad of ["http://generativelanguage.googleapis.com", "ftp://x", "not a url", "https://user:pw@example.test", "https://example.test?x=1", "https://example.test?", "https://example.test/#", "https://example.test/a?#"]) {
      expect(() => new GeminiBatchClient({ apiKey: KEY, baseUrl: bad }), bad).toThrow(RangeError);
    }
  });

  it("API キーに見出しに使えない文字があれば、値を含まない RangeError", () => {
    for (const bad of ["abc\ndef", "abc def", "鍵", "a\r\nx-evil: 1"]) {
      let message = "";
      try {
        new GeminiBatchClient({ apiKey: bad });
      } catch (e) {
        expect(e).toBeInstanceOf(RangeError);
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(bad);
    }
    expect(() => new GeminiBatchClient({ apiKey: "" })).toThrow(RangeError);
  });

  it("一覧：pageSize・pageToken を付ける。形の違う項目（埋め込みのバッチ）は数えて外し、ほかは返す", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("gemini-batch-list.json")));
    const r = await client(f).list({ pageSize: 20, pageToken: "tok/+=" });
    expect(r).toMatchObject({ ok: true, value: { unreadable: 1, nextPageToken: "CiAKGjBpNDd2Nmp2Zml2cXRwYjBpOXA", batches: [{ id: ID, state: "running", displayName: NAME }] } });
    expect(`${seen[0]!.init.method} ${seen[0]!.url}`).toBe("GET https://generativelanguage.googleapis.com/v1/batches?pageSize=20&pageToken=tok%2F%2B%3D");
    const empty = fakeFetch(() => new Response("{}"));
    expect(await client(empty.f).list()).toEqual({ ok: true, value: { batches: [], unreadable: 0, nextPageToken: null } });
    expect(empty.seen[0]!.url).toBe("https://generativelanguage.googleapis.com/v1/batches");
    for (const bad of [{ pageSize: 0 }, { pageSize: 1001 }, { pageSize: 1.5 }, { pageToken: "" }, { pageToken: "a b" }, { pageToken: "a\nb" }]) {
      await expect(client(f).list(bad)).rejects.toThrow(RangeError);
    }
  });

  it("結果：text の部分だけをつなぎ（考えた過程の要約は入れない）、トークン数を読む。失敗はコードだけを残し、エラー文を入れない", async () => {
    const { f } = fakeFetch(() => new Response(recorded("gemini-batch-succeeded.json")));
    const r = await client(f).results(ID);
    expect(r.ok && r.value.status).toMatchObject({ state: "succeeded", counts: { requests: 4, succeeded: 2, failed: 2, pending: 0 } });
    expect(r.ok && r.value.items).toEqual([
      {
        customId: "run-a",
        type: "succeeded",
        output: '{"post":null,"orders":[]}',
        respondedModel: "gemini-3.8-flash",
        finishReason: "STOP",
        blockReason: null,
        usage: { inputTokens: 20000, outputTokens: 4500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      },
      { customId: "run-b", type: "errored", errorCode: 3 },
      {
        customId: "run-c",
        type: "succeeded",
        output: "",
        respondedModel: "gemini-3.8-flash",
        finishReason: null,
        blockReason: "SAFETY",
        usage: { inputTokens: 120, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      },
      { customId: "run-d", type: "errored" },
    ]);
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("結果の置き場所は3通り読む（metadata.output・response.output・response）。終わる前は空", async () => {
    const op = JSON.parse(recorded("gemini-batch-succeeded.json"));
    const box = op.response.inlinedResponses;
    const variants = [
      { ...op, response: undefined, metadata: { ...op.metadata, output: { inlinedResponses: box } } },
      { ...op, response: { output: { inlinedResponses: box } } },
      op,
    ];
    for (const v of variants) {
      const r = await client(fakeFetch(() => new Response(JSON.stringify(v))).f).results(ID);
      expect(r.ok && r.value.items.map((i) => i.type)).toEqual(["succeeded", "errored", "succeeded", "errored"]);
    }
    const running = { ...op, done: false, metadata: { ...op.metadata, state: "BATCH_STATE_RUNNING" } };
    expect(await client(fakeFetch(() => new Response(JSON.stringify(running))).f).results(ID)).toMatchObject({ ok: true, value: { status: { state: "running" }, items: [] } });
    const jobState = { ...op, metadata: { ...op.metadata, state: "JOB_STATE_SUCCEEDED" } };
    expect(await client(fakeFetch(() => new Response(JSON.stringify(jobState))).f).results(ID)).toMatchObject({ ok: true, value: { status: { state: "succeeded" } } });
  });

  it("成功で終わったのに結果がない（ファイルで返った場合を含む）なら malformed。取り消し・期限切れで結果がないなら空", async () => {
    const op = JSON.parse(recorded("gemini-batch-succeeded.json"));
    const noResults = { ...op, response: { responsesFile: "files/abc" } };
    expect(await client(fakeFetch(() => new Response(JSON.stringify(noResults))).f).results(ID)).toEqual({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
    for (const state of ["BATCH_STATE_CANCELLED", "BATCH_STATE_EXPIRED", "BATCH_STATE_FAILED"]) {
      const v = { ...op, response: undefined, error: { code: 1, message: "req_secret123" }, metadata: { ...op.metadata, state } };
      const r = await client(fakeFetch(() => new Response(JSON.stringify(v))).f).results(ID);
      expect(r).toMatchObject({ ok: true, value: { items: [], status: { errorCode: 1 } } });
      expect(JSON.stringify(r)).not.toContain("secret");
    }
  });

  it("結果の1件が形に合わなければ、その1件だけ malformed にして、ほかは生かす", async () => {
    const op = JSON.parse(recorded("gemini-batch-succeeded.json"));
    const good = { error: { code: 1 }, metadata: { key: "ok-1" } };
    const list = [
      good,
      "not an object req_secret123",
      { response: { candidates: [] }, metadata: { key: "bad-1" } },
      { error: { code: 1 }, metadata: { key: "a/b" } },
      { response: { usageMetadata: { promptTokenCount: -1 } }, metadata: { key: "bad-2" } },
      { response: { candidates: [{}, {}], usageMetadata: { promptTokenCount: 1 } }, metadata: { key: "bad-3" } },
      { response: { candidates: [{ finishReason: "free text req_secret123" }], usageMetadata: { promptTokenCount: 1 } }, metadata: { key: "bad-4" } },
      { error: { code: 1 }, response: { usageMetadata: { promptTokenCount: 1 } }, metadata: { key: "bad-5" } },
      { response: { usageMetadata: { promptTokenCount: 1, thoughtsTokenCount: "12" } }, metadata: { key: "ok-2" } },
    ];
    const v = { ...op, response: { inlinedResponses: { inlinedResponses: list } } };
    const r = await client(fakeFetch(() => new Response(JSON.stringify(v))).f).results(ID);
    expect(r.ok && r.value.items).toEqual([
      { customId: "ok-1", type: "errored", errorCode: 1 },
      { type: "malformed", index: 2 },
      { type: "malformed", index: 3, customId: "bad-1" },
      { type: "malformed", index: 4 },
      { type: "malformed", index: 5, customId: "bad-2" },
      { type: "malformed", index: 6, customId: "bad-3" },
      { type: "malformed", index: 7, customId: "bad-4" },
      { type: "malformed", index: 8, customId: "bad-5" },
      { customId: "ok-2", type: "succeeded", output: "", respondedModel: null, finishReason: null, blockReason: null, usage: { inputTokens: 1, outputTokens: 12, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
    ]);
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("HTTP の失敗は状態コードだけを返し、本文（エラー文）を入れない", async () => {
    for (const [status, errorCode] of [[429, "rate_limited"], [408, "timeout"], [504, "timeout"], [401, "provider_error"], [503, "provider_error"], [500, "provider_error"]] as const) {
      const { f } = fakeFetch(() => new Response('{"error":{"code":1,"message":"request-id=req_secret123"}}', { status }));
      expect(await client(f).retrieve(ID)).toEqual({ ok: false, errorCode, reason: "http", status });
    }
  });

  it("通信断は network、待ち時間切れは timeout、それ以外の例外は unexpected。例外の文を入れない", async () => {
    const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed ECONNRESET request-id=req_secret123")));
    expect(await client(down.f).retrieve(ID)).toEqual({ ok: false, errorCode: "provider_error", reason: "network" });
    const odd = fakeFetch(() => Promise.reject(new Error("weird request-id=req_secret123")));
    expect(await client(odd.f).retrieve(ID)).toEqual({ ok: false, errorCode: "provider_error", reason: "unexpected" });
    const hang = (async (_: RequestInfo | URL, init?: RequestInit) => abortable(init)) as typeof fetch;
    expect(await client(hang, 5).retrieve(ID)).toEqual({ ok: false, errorCode: "timeout", reason: "timeout" });
    expect(await client(hang, 5).results(ID)).toEqual({ ok: false, errorCode: "timeout", reason: "timeout" });
  });

  it("結果の取り出しだけ、待ち時間の上限を別に決められる", async () => {
    const hang = (async (_: RequestInfo | URL, init?: RequestInit) => abortable(init)) as typeof fetch;
    const c = new GeminiBatchClient({ apiKey: KEY, fetch: hang, timeoutMs: 5, resultsTimeoutMs: 60_000 });
    expect(await c.retrieve(ID)).toEqual({ ok: false, errorCode: "timeout", reason: "timeout" });
    const slowOk = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(recorded("gemini-batch-succeeded.json"));
    }) as typeof fetch;
    const c2 = new GeminiBatchClient({ apiKey: KEY, fetch: slowOk, timeoutMs: 5, resultsTimeoutMs: 60_000 });
    expect((await c2.results(ID)).ok).toBe(true);
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
    const cases: [typeof fetch, Record<string, unknown>][] = [
      [fakeFetch(() => Promise.reject(new TypeError("fetch failed"))).f, { errorCode: "provider_error", reason: "network", billingUnknown: true }],
      [(async (_: RequestInfo | URL, init?: RequestInit) => abortable(init)) as typeof fetch, { errorCode: "timeout", reason: "timeout", billingUnknown: true }],
      [fakeFetch(() => new Response("", { status: 408 })).f, { errorCode: "timeout", reason: "http", status: 408, billingUnknown: true }],
      [fakeFetch(() => new Response("", { status: 503 })).f, { errorCode: "provider_error", reason: "http", status: 503, billingUnknown: true }],
      [fakeFetch(() => new Response("not json")).f, { errorCode: "provider_error", reason: "malformed", status: 200, billingUnknown: true }],
      [fakeFetch(() => new Response('{"name":"batches/x","metadata":{}}')).f, { errorCode: "provider_error", reason: "malformed", status: 200, billingUnknown: true }],
    ];
    for (const [f, expected] of cases) {
      const r = await client(f, 5).create(MODEL, NAME, item);
      expect(r).toMatchObject({ ok: false, ...expected });
      expect(r.sent.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const status of [400, 401, 403, 429]) {
      const r = await client(fakeFetch(() => new Response("", { status })).f).create(MODEL, NAME, item);
      expect(r.ok).toBe(false);
      expect(r).not.toHaveProperty("billingUnknown");
    }
  });

  it("形が合わない応答は provider_error（中身は返さない）", async () => {
    const op = JSON.parse(recorded("gemini-batch-created.json"));
    const bodies = [
      "not json req_secret123",
      JSON.stringify({ ...op, name: "operations/x" }),
      JSON.stringify({ ...op, metadata: { ...op.metadata, state: "BATCH_STATE_UNSPECIFIED" } }),
      JSON.stringify({ ...op, metadata: { ...op.metadata, "@type": "type.googleapis.com/x.EmbedContentBatch" } }),
      JSON.stringify({ ...op, metadata: { ...op.metadata, batchStats: { requestCount: "-1" } } }),
      JSON.stringify({ ...op, metadata: { ...op.metadata, createTime: "yesterday" } }),
    ];
    for (const body of bodies) {
      const { f } = fakeFetch(() => new Response(body));
      expect(await client(f).retrieve(ID), body).toEqual({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
    }
    expect(await client(fakeFetch(() => new Response('{"operations":"x"}')).f).list()).toEqual({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
    expect(await client(fakeFetch(() => new Response("[]")).f).cancel(ID)).toEqual({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
  });

  it("API キーは見出しに入れるだけで、クライアントを文字列にしても出ない", () => {
    const c = client(fakeFetch(() => new Response("")).f);
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(String(Object.keys(c))).not.toContain(KEY);
  });

  it("引数の誤りは呼ばずに RangeError", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("gemini-batch-created.json")));
    const c = client(f);
    await expect(c.create(MODEL, NAME, [])).rejects.toThrow(RangeError);
    await expect(c.create(MODEL, NAME, [{ customId: "a/b", request }])).rejects.toThrow(RangeError);
    await expect(c.create(MODEL, NAME, [{ customId: "a".repeat(65), request }])).rejects.toThrow(RangeError);
    await expect(c.create(MODEL, NAME, [{ customId: "a", request }, { customId: "a", request }])).rejects.toThrow(RangeError);
    await expect(c.create("../models/x", NAME, item)).rejects.toThrow(RangeError);
    await expect(c.create(`${MODEL}:x`, NAME, item)).rejects.toThrow(RangeError);
    await expect(c.create(MODEL, "has space", item)).rejects.toThrow(RangeError);
    await expect(c.create(MODEL, "", item)).rejects.toThrow(RangeError);
    const huge = toGeminiRequest({ provider: "google", modelId: MODEL, settings: { max_tokens: "10" } }, [{ role: "user", content: "x".repeat(GEMINI_MAX_BODY_BYTES) }]);
    await expect(c.create(MODEL, NAME, [{ customId: "a", request: huge }])).rejects.toThrow(RangeError);
    await expect(c.retrieve("../../v1/models")).rejects.toThrow(RangeError);
    await expect(c.cancel("a:b")).rejects.toThrow(RangeError);
    await expect(c.results("")).rejects.toThrow(RangeError);
    expect(seen).toHaveLength(0);
    expect((await c.create(MODEL, NAME, [{ customId: "a".repeat(64), request }])).ok).toBe(true);
  });
});

describe("結果の突き合わせ（reconcileGeminiResults）", () => {
  it("重なった customId と依頼にない customId は信じず、形が合わない1件は数える", () => {
    const items: GeminiItemResult[] = [
      { customId: "a", type: "errored" },
      { customId: "b", type: "errored", errorCode: 3 },
      { customId: "b", type: "errored" },
      { customId: "zzz", type: "errored" },
      { type: "malformed", index: 5, customId: "c" },
      { type: "malformed", index: 6 },
    ];
    const r = reconcileGeminiResults(["a", "b", "c", "d"], items);
    expect([...r.matched.entries()]).toEqual([["a", { customId: "a", type: "errored" }]]);
    expect(r.duplicated).toEqual(["b"]);
    expect(r.missing).toEqual(["c", "d"]);
    expect(r.unexpected).toBe(1);
    expect(r.malformed).toBe(2);
  });

  it("同じ customId が、形の合う1件と合わない1件の両方に出たら、重なりとして扱う", () => {
    const r = reconcileGeminiResults(["a"], [
      { customId: "a", type: "errored" },
      { type: "malformed", index: 2, customId: "a" },
    ]);
    expect(r.matched.size).toBe(0);
    expect(r.duplicated).toEqual(["a"]);
    expect(r.missing).toEqual([]);
  });
});

describe("送る中身（toGeminiRequest）", () => {
  const model = (settings: Record<string, string>) => ({ provider: "google", modelId: MODEL, settings });
  const user = [{ role: "user" as const, content: "x" }];

  it("system がなければ systemInstruction を入れず、thinking_level がなければ thinkingConfig を入れない。assistant は model にする", () => {
    expect(toGeminiRequest(model({ max_tokens: "10" }), user)).toEqual({ contents: [{ role: "user", parts: [{ text: "x" }] }], generationConfig: { maxOutputTokens: 10 } });
    expect(toGeminiRequest(model({ max_tokens: "10" }), [...user, { role: "assistant", content: "y" }, ...user]).contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
  });

  it("数値・設定の書き方は1つだけ受け付ける", () => {
    for (const [t, level] of [["low", "LOW"], ["medium", "MEDIUM"], ["high", "HIGH"]] as const) {
      expect(toGeminiRequest(model({ max_tokens: "10", thinking_level: t }), user).generationConfig.thinkingConfig).toEqual({ thinkingLevel: level });
    }
    for (const t of ["minimal", "LOW", "Low", " low", "toString", ""]) expect(() => toGeminiRequest(model({ max_tokens: "10", thinking_level: t }), user), t).toThrow(RangeError);
    for (const m of ["0", "010", "1.0", "+1", "-1", "1e3", " 10", "1234567890"]) expect(() => toGeminiRequest(model({ max_tokens: m }), user), m).toThrow(RangeError);
  });

  it("temperature（Gemini 3.6 Flash 以降は黙って無視される）とほかの設定は断る。決まりに合わない messages も RangeError", () => {
    expect(() => toGeminiRequest(model({ max_tokens: "10", temperature: "0.2" }), user)).toThrow(RangeError);
    expect(() => toGeminiRequest(model({}), user)).toThrow(RangeError);
    expect(() => toGeminiRequest(model({ max_tokens: "10" }), [])).toThrow(RangeError);
    expect(() => toGeminiRequest(model({ max_tokens: "10" }), [{ role: "system", content: "a" }])).toThrow(RangeError);
    expect(() => toGeminiRequest(model({ max_tokens: "10" }), [{ role: "assistant", content: "a" }])).toThrow(RangeError);
    expect(() => toGeminiRequest(model({ max_tokens: "10" }), [...user, { role: "system", content: "a" }])).toThrow(RangeError);
  });
});

describe("API キーの読み出し", () => {
  it("環境変数から読む。ない・見出しに使えない文字があるときは、値を含まない Error", () => {
    expect(geminiApiKeyFromEnv({ GEMINI_API_KEY: KEY })).toBe(KEY);
    expect(() => geminiApiKeyFromEnv({})).toThrow("GEMINI_API_KEY is not set");
    expect(() => geminiApiKeyFromEnv({ GEMINI_API_KEY: "abc\nsecret" })).toThrow("GEMINI_API_KEY has characters not allowed in a header");
  });
});
