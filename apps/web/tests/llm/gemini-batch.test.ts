// Gemini のバッチの口（fetch で呼ぶ部分）の試験。本物の API は呼ばない。応答は記録済みのもの（recorded/）を返す。
// 記録済みの応答は、公式の資料（https://ai.google.dev/api/batch-mode）の形から作った。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/events/hash";
import {
  GEMINI_MAX_BODY_BYTES,
  GeminiBatchClient,
  findGeminiBatchByDisplayName,
  geminiApiKeyFromEnv,
  reconcileGeminiResults,
  toGeminiRequest,
  type GeminiItemResult,
  type GeminiList,
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
const GOOGLE = { provider: "google", modelId: MODEL, settings: { max_tokens: "8000", thinking_level: "low" } };
const messages = [
  { role: "system" as const, content: "あなたは投資家です" },
  { role: "user" as const, content: "入力" },
];
const item = [{ customId: "run-a", messages }];
/** abort されるまで待ち、abort で秘密っぽい文の例外を投げる */
const abortable = (init?: RequestInit) =>
  new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted request-id=req_secret123", "AbortError"))));

describe("Gemini のバッチの口", () => {
  it("作成：決まった URL・見出し・中身で送り、状態と、送った本文・そのハッシュを返す。キーは URL に入れない", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("gemini-batch-created.json")));
    const r = await client(f).create(GOOGLE, NAME, item);
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

  it("作成：送るモデルと設定は、渡した LlmModel だけから決める。provider が google でない・モデル名が決まりに合わないなら、呼ばずに RangeError", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("gemini-batch-created.json")));
    const lite = { provider: "google", modelId: "gemini-3.8-flash-lite", settings: { max_tokens: "100" } };
    await client(f).create(lite, NAME, item);
    expect(seen[0]!.url).toBe("https://generativelanguage.googleapis.com/v1/models/gemini-3.8-flash-lite:batchGenerateContent");
    const sent = JSON.parse(seen[0]!.init.body as string);
    expect(sent.batch.model).toBe("models/gemini-3.8-flash-lite");
    expect(sent.batch.inputConfig.requests.requests[0].request.generationConfig).toEqual({ maxOutputTokens: 100 });
    const bad = [
      { ...GOOGLE, provider: "anthropic" },
      { ...GOOGLE, provider: "Google" },
      { ...GOOGLE, modelId: "../x" },
      { ...GOOGLE, modelId: 1 },
      { ...GOOGLE, settings: { max_tokens: "10", temperature: "0.2" } },
    ] as unknown as (typeof GOOGLE)[];
    for (const m of bad) await expect(client(f).create(m, NAME, item)).rejects.toThrow(RangeError);
    // 型をすり抜けた messages（文字列でない内容・知らない役）も送らない
    for (const ms of [[{ role: "user", content: 1 }], [{ role: "tool", content: "x" }], [null], "x"]) {
      await expect(client(f).create(GOOGLE, NAME, [{ customId: "a", messages: ms as never }])).rejects.toThrow(RangeError);
    }
    expect(seen).toHaveLength(1);
  });

  it("作成：本文の大きさは 20,000,000 バイト未満だけを送る（ちょうどは断る）", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("gemini-batch-created.json")));
    const one = (content: string) => [{ customId: "a", messages: [{ role: "user" as const, content }] }];
    await client(f).create(GOOGLE, NAME, one(""));
    const overhead = new TextEncoder().encode(seen[0]!.init.body as string).length;
    await expect(client(f).create(GOOGLE, NAME, one("x".repeat(GEMINI_MAX_BODY_BYTES - overhead)))).rejects.toThrow(RangeError);
    expect(seen).toHaveLength(1);
    const r = await client(f).create(GOOGLE, NAME, one("x".repeat(GEMINI_MAX_BODY_BYTES - overhead - 1)));
    expect(r.ok).toBe(true);
    expect(new TextEncoder().encode(seen[1]!.init.body as string).length).toBe(GEMINI_MAX_BODY_BYTES - 1);
  });

  it("状態・取り消し・結果の URL。末尾に / のある baseUrl でも / が重ならない。取り消しの応答は空の本文でも {} でも成功", async () => {
    const { f, seen } = fakeFetch((url) => new Response(url.endsWith(":cancel") ? "" : recorded("gemini-batch-succeeded.json")));
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
    expect(await client(fakeFetch(() => new Response("{}")).f).cancel(ID)).toEqual({ ok: true, value: null });
    // 空の本文を受け付けるのは取り消しだけ
    expect(await client(fakeFetch(() => new Response("")).f).retrieve(ID)).toEqual({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
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

  it("一覧：pageSize・pageToken を付ける。形の違う項目（埋め込みのバッチ）は、決まりに合う id と displayName だけを返し、ほかは読む", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("gemini-batch-list.json")));
    const r = await client(f).list({ pageSize: 20, pageToken: "tok/+=" });
    expect(r).toMatchObject({ ok: true, value: { unreadable: [{ id: "embed0001", displayName: "someone-else" }], nextPageToken: "CiAKGjBpNDd2Nmp2Zml2cXRwYjBpOXA", batches: [{ id: ID, state: "running", displayName: NAME }] } });
    expect(`${seen[0]!.init.method} ${seen[0]!.url}`).toBe("GET https://generativelanguage.googleapis.com/v1/batches?pageSize=20&pageToken=tok%2F%2B%3D");
    const empty = fakeFetch(() => new Response("{}"));
    expect(await client(empty.f).list()).toEqual({ ok: true, value: { batches: [], unreadable: [], nextPageToken: null } });
    expect(empty.seen[0]!.url).toBe("https://generativelanguage.googleapis.com/v1/batches");
    const odd = {
      operations: [
        { name: "batches/x1", metadata: { displayName: NAME, state: "BATCH_STATE_NEW", model: "m" } },
        { name: "batches/x2", metadata: { displayName: "a b", model: "m", state: "BATCH_STATE_RUNNING" } },
        { name: "operations/x3", metadata: {} },
        "x",
      ],
    };
    expect(await client(fakeFetch(() => new Response(JSON.stringify(odd))).f).list()).toEqual({ ok: true, value: { batches: [], unreadable: [{ id: "x1", displayName: NAME }, { id: "x2" }, {}, {}], nextPageToken: null } });
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
    // 2か所以上にあり、中身が同じなら読む。空 {} と全件、件数違い、中身違いは malformed（黙って結果を失わない）
    const same = { ...op, metadata: { ...op.metadata, output: { inlinedResponses: box } } };
    expect(await client(fakeFetch(() => new Response(JSON.stringify(same))).f).results(ID)).toMatchObject({ ok: true, value: { items: { length: 4 } } });
    const conflicts = [
      { ...op, metadata: { ...op.metadata, output: { inlinedResponses: {} } } },
      { ...op, metadata: { ...op.metadata, output: { inlinedResponses: { inlinedResponses: box.inlinedResponses.slice(0, 3) } } } },
      { ...op, response: { ...op.response, output: { inlinedResponses: { inlinedResponses: [...box.inlinedResponses.slice(0, 3), { error: { code: 5 }, metadata: { key: "run-d" } }] } } } },
    ];
    for (const v of conflicts) {
      expect(await client(fakeFetch(() => new Response(JSON.stringify(v))).f).results(ID)).toEqual({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
    }
    const running = { ...op, done: false, metadata: { ...op.metadata, state: "BATCH_STATE_RUNNING" } };
    expect(await client(fakeFetch(() => new Response(JSON.stringify(running))).f).results(ID)).toMatchObject({ ok: true, value: { status: { state: "running" }, items: [] } });
    const jobState = { ...op, metadata: { ...op.metadata, state: "JOB_STATE_SUCCEEDED" } };
    expect(await client(fakeFetch(() => new Response(JSON.stringify(jobState))).f).results(ID)).toMatchObject({ ok: true, value: { status: { state: "succeeded" } } });
  });

  it("成功で終わったのに結果がない（ファイルで返った場合を含む）・件数が違うなら malformed。取り消し・期限切れで結果がないなら空", async () => {
    const op = JSON.parse(recorded("gemini-batch-succeeded.json"));
    const noResults = { ...op, response: { responsesFile: "files/abc" } };
    expect(await client(fakeFetch(() => new Response(JSON.stringify(noResults))).f).results(ID)).toEqual({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
    // 成功で終わったのに、結果の件数が依頼の件数（requestCount）と違う
    for (const list of [[], op.response.inlinedResponses.inlinedResponses.slice(0, 3)]) {
      const v = { ...op, response: { inlinedResponses: { inlinedResponses: list } } };
      expect(await client(fakeFetch(() => new Response(JSON.stringify(v))).f).results(ID)).toEqual({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
    }
    const emptyBox = { ...op, response: { inlinedResponses: {} } };
    expect(await client(fakeFetch(() => new Response(JSON.stringify(emptyBox))).f).results(ID)).toEqual({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
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
      { error: { code: 0 }, metadata: { key: "bad-6" } },
      { response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 25 } }, metadata: { key: "ok-3" } },
      { response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 12 } }, metadata: { key: "ok-4" } },
    ];
    const v = { ...op, metadata: { ...op.metadata, batchStats: { requestCount: String(list.length) } }, response: { inlinedResponses: { inlinedResponses: list } } };
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
      { type: "malformed", index: 10, customId: "bad-6" },
      // 合計が足し算より大きければ、差（25-18=7）を出力に足す。小さければ足さない
      { customId: "ok-3", type: "succeeded", output: "", respondedModel: null, finishReason: null, blockReason: null, usage: { inputTokens: 10, outputTokens: 15, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
      { customId: "ok-4", type: "succeeded", output: "", respondedModel: null, finishReason: null, blockReason: null, usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
    ]);
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("HTTP の失敗は状態コードだけを返し、本文（エラー文）を入れない", async () => {
    for (const [status, errorCode] of [[429, "rate_limited"], [408, "timeout"], [504, "timeout"], [401, "provider_error"], [503, "rate_limited"], [500, "provider_error"]] as const) {
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

  it("状態と結果の取り出し（終わったバッチは全文が返る）だけ、待ち時間の上限を別に決められる", async () => {
    const hang = (async (_: RequestInfo | URL, init?: RequestInit) => abortable(init)) as typeof fetch;
    const c = new GeminiBatchClient({ apiKey: KEY, fetch: hang, timeoutMs: 5, resultsTimeoutMs: 60_000 });
    expect(await c.list()).toEqual({ ok: false, errorCode: "timeout", reason: "timeout" });
    const slowOk = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(recorded("gemini-batch-succeeded.json"));
    }) as typeof fetch;
    const c2 = new GeminiBatchClient({ apiKey: KEY, fetch: slowOk, timeoutMs: 5, resultsTimeoutMs: 60_000 });
    expect((await c2.results(ID)).ok).toBe(true);
    expect((await c2.retrieve(ID)).ok).toBe(true);
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
      [fakeFetch(() => new Response("", { status: 503 })).f, { errorCode: "rate_limited", reason: "http", status: 503, billingUnknown: true }],
      [fakeFetch(() => new Response("", { status: 500 })).f, { errorCode: "provider_error", reason: "http", status: 500, billingUnknown: true }],
      [fakeFetch(() => new Response("not json")).f, { errorCode: "provider_error", reason: "malformed", status: 200, billingUnknown: true }],
      [fakeFetch(() => new Response('{"name":"batches/x","metadata":{}}')).f, { errorCode: "provider_error", reason: "malformed", status: 200, billingUnknown: true }],
    ];
    for (const [f, expected] of cases) {
      const r = await client(f, 5).create(GOOGLE, NAME, item);
      expect(r).toMatchObject({ ok: false, ...expected });
      expect(r.sent.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const status of [400, 401, 403, 429]) {
      const r = await client(fakeFetch(() => new Response("", { status })).f).create(GOOGLE, NAME, item);
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
      // done と状態の食い違い
      JSON.stringify({ ...op, done: true }),
      JSON.stringify({ ...JSON.parse(recorded("gemini-batch-succeeded.json")), done: false }),
      JSON.stringify({ ...JSON.parse(recorded("gemini-batch-succeeded.json")), done: undefined }),
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
    await expect(c.create(GOOGLE, NAME, [])).rejects.toThrow(RangeError);
    await expect(c.create(GOOGLE, NAME, [{ customId: "a/b", messages }])).rejects.toThrow(RangeError);
    await expect(c.create(GOOGLE, NAME, [{ customId: "a".repeat(65), messages }])).rejects.toThrow(RangeError);
    await expect(c.create(GOOGLE, NAME, [{ customId: "a", messages }, { customId: "a", messages }])).rejects.toThrow(RangeError);
    await expect(c.create({ ...GOOGLE, modelId: "../models/x" }, NAME, item)).rejects.toThrow(RangeError);
    await expect(c.create({ ...GOOGLE, modelId: `${MODEL}:x` }, NAME, item)).rejects.toThrow(RangeError);
    await expect(c.create(GOOGLE, "has space", item)).rejects.toThrow(RangeError);
    await expect(c.create(GOOGLE, "", item)).rejects.toThrow(RangeError);
    await expect(c.create(GOOGLE, NAME, [{ customId: "a", messages: [{ role: "user", content: "x".repeat(GEMINI_MAX_BODY_BYTES) }] }])).rejects.toThrow(RangeError);
    await expect(c.retrieve("../../v1/models")).rejects.toThrow(RangeError);
    await expect(c.cancel("a:b")).rejects.toThrow(RangeError);
    await expect(c.results("")).rejects.toThrow(RangeError);
    expect(seen).toHaveLength(0);
    expect((await c.create(GOOGLE, NAME, [{ customId: "a".repeat(64), messages }])).ok).toBe(true);
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

  it("依頼した customId が重なっていれば RangeError", () => {
    expect(() => reconcileGeminiResults(["a", "a"], [])).toThrow(RangeError);
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

describe("作られたバッチを displayName で探す（findGeminiBatchByDisplayName）", () => {
  const status = (id: string, displayName: string) => ({
    id,
    state: "running" as const,
    done: false,
    model: "models/gemini-3.8-flash",
    displayName,
    counts: { requests: 1, succeeded: 0, failed: 0, pending: 1 },
    createdAt: 0,
    updatedAt: null,
    endedAt: null,
  });
  /** ページの並びを返す一覧（null は失敗）。呼ばれた pageToken を残す */
  const pages = (...ps: (GeminiList | null)[]) => {
    const tokens: (string | undefined)[] = [];
    let i = 0;
    return {
      tokens,
      list: async (o: { pageToken?: string } = {}) => {
        tokens.push(o.pageToken);
        const p = ps[i++];
        return p === null || p === undefined ? ({ ok: false, errorCode: "provider_error", reason: "http", status: 500 } as const) : ({ ok: true, value: p } as const);
      },
    };
  };
  const page = (batches: ReturnType<typeof status>[], unreadable: GeminiList["unreadable"], nextPageToken: string | null): GeminiList => ({ batches, unreadable, nextPageToken });

  it("全ページを読み、見つかれば found。2ページ目にあっても見落とさない", async () => {
    const c = pages(page([status("b1", "other")], [{ displayName: "someone-else" }], "t1"), page([status("b2", NAME)], [], null));
    expect(await findGeminiBatchByDisplayName(c, NAME)).toEqual({ kind: "found", batch: status("b2", NAME), maybeDuplicated: false });
    expect(c.tokens).toEqual([undefined, "t1"]);
  });

  it("読めない項目は、displayName が別の名前なら外し、同じ名前なら foundUnreadable、名前が読めなければ notFound と決めない", async () => {
    expect(await findGeminiBatchByDisplayName(pages(page([], [{ id: "e1", displayName: "x" }], null)), NAME)).toEqual({ kind: "notFound" });
    expect(await findGeminiBatchByDisplayName(pages(page([], [{ id: "u1", displayName: NAME }], null)), NAME)).toEqual({ kind: "foundUnreadable", id: "u1", maybeDuplicated: false });
    expect(await findGeminiBatchByDisplayName(pages(page([], [{ id: "u1" }], null)), NAME)).toEqual({ kind: "unknown", reason: "unreadable" });
    expect(await findGeminiBatchByDisplayName(pages(page([status("b1", NAME)], [{}], null)), NAME)).toEqual({ kind: "found", batch: status("b1", NAME), maybeDuplicated: true });
  });

  it("同じ名前が2つ以上なら duplicated。一覧の失敗・ページが多すぎる・同じページの繰り返しは unknown", async () => {
    expect(await findGeminiBatchByDisplayName(pages(page([status("b1", NAME)], [{ id: "u1", displayName: NAME }, { displayName: NAME }], null)), NAME)).toEqual({ kind: "duplicated", ids: ["b1", "u1"] });
    expect(await findGeminiBatchByDisplayName(pages(page([], [], "t1"), null), NAME)).toEqual({ kind: "unknown", reason: "list_failed" });
    expect(await findGeminiBatchByDisplayName(pages(page([], [], "t1"), page([], [], "t2"), page([], [], null)), NAME, 2)).toEqual({ kind: "unknown", reason: "too_many_pages" });
    expect(await findGeminiBatchByDisplayName(pages(page([], [], "t1"), page([], [], "t1")), NAME)).toEqual({ kind: "unknown", reason: "too_many_pages" });
    await expect(findGeminiBatchByDisplayName(pages(), "a b")).rejects.toThrow(RangeError);
  });

  it("記録済みの一覧の応答から、全ページを読んで探す", async () => {
    const first = JSON.parse(recorded("gemini-batch-list.json"));
    const { f, seen } = fakeFetch(() => new Response(JSON.stringify(seen.length === 1 ? first : { operations: [] })));
    expect(await findGeminiBatchByDisplayName(client(f), NAME)).toMatchObject({ kind: "found", batch: { id: ID }, maybeDuplicated: false });
    expect(seen.map((s) => s.url)).toEqual([
      "https://generativelanguage.googleapis.com/v1/batches?pageSize=1000",
      `https://generativelanguage.googleapis.com/v1/batches?pageSize=1000&pageToken=${first.nextPageToken}`,
    ]);
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
    expect(() => toGeminiRequest({ provider: "openai", modelId: MODEL, settings: { max_tokens: "10" } }, user)).toThrow(RangeError);
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
