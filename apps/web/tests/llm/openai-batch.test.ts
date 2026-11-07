// OpenAI のバッチの口（fetch で呼ぶ部分）と料金の試験。本物の API は呼ばない。応答は記録済みのもの（recorded/）を返す。
// 記録済みの応答は、公式の資料（Batch API の案内と API の説明）の例の形に合わせて作ったもの。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/events/hash";
import { batchCostDeciyen } from "../../src/llm/cost";
import {
  OpenAIBatchClient,
  findBatchesByInputFile,
  openaiApiKeyFromEnv,
  reconcileResults,
  toOpenAIParams,
  type BatchItemResult,
} from "../../src/llm/openai-batch";
import { openaiBatchPrice } from "../../src/llm/openai-pricing";

const recorded = (name: string) => readFileSync(new URL(`./recorded/${name}`, import.meta.url), "utf8");
const KEY = "sk-proj-test-not-a-real-key";
const BATCH = "batch_690f3a2b7c8c8190a1b2c3d4e5f60718";
const FILE = "file-6F2ksmvXxt4VdoqmHRw6kL";

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
const client = (f: typeof fetch, timeoutMs?: number, baseUrl?: string) => new OpenAIBatchClient({ apiKey: KEY, fetch: f, timeoutMs, baseUrl });
const model = (settings: Record<string, string>) => ({ provider: "openai", modelId: "gpt-6.1-sol", settings });
const params = toOpenAIParams(model({ max_tokens: "25000", reasoning_effort: "medium" }), [
  { role: "system", content: "あなたは投資家です" },
  { role: "user", content: "入力" },
]);
/** abort されるまで待ち、abort で秘密っぽい文の例外を投げる */
const abortable = (init?: RequestInit) =>
  new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted request-id=req_secret123", "AbortError"))));

describe("OpenAI のバッチの口", () => {
  it("ファイルの上げ：決まった URL・見出し・中身で送り、ファイルの情報と、送った本文・そのハッシュを返す", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("openai-file-uploaded.json")));
    const r = await client(f).upload([{ customId: "run-a", params }, { customId: "run-b", params }]);
    const line = '{"custom_id":"run-a","method":"POST","url":"/v1/responses","body":{"model":"gpt-6.1-sol","input":[{"role":"system","content":"あなたは投資家です"},{"role":"user","content":"入力"}],"max_output_tokens":25000,"reasoning":{"effort":"medium"}}}';
    const body = `${line}\n${line.replace("run-a", "run-b")}`;
    expect(r).toEqual({
      ok: true,
      value: { id: FILE, bytes: 412, createdAt: 1762673700_000 },
      sent: { body, sha256: await sha256Hex(new TextEncoder().encode(body)) },
    });
    expect(r.sent.body).not.toContain(KEY);
    expect(`${seen[0]!.init.method} ${seen[0]!.url}`).toBe("POST https://api.openai.com/v1/files");
    expect(seen[0]!.init.redirect).toBe("error");
    expect(seen[0]!.init.headers).toEqual({ authorization: `Bearer ${KEY}` });
    const form = seen[0]!.init.body as FormData;
    expect(form.get("purpose")).toBe("batch");
    const file = form.get("file") as File;
    expect(file.name).toBe("batch.jsonl");
    expect(await file.text()).toBe(body);
  });

  it("ファイルの上げ：型をすり抜けた余分な欄（tools など）は送らない", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("openai-file-uploaded.json")));
    const sneaky = { ...params, tools: [{ type: "web_search" }], input: [{ role: "user", content: "x", extra: 1 }] } as unknown as typeof params;
    await client(f).upload([{ customId: "a", params: sneaky }]);
    const text = await ((seen[0]!.init.body as FormData).get("file") as File).text();
    expect(JSON.parse(text).body).toEqual({ model: "gpt-6.1-sol", input: [{ role: "user", content: "x" }], max_output_tokens: 25000, reasoning: { effort: "medium" } });
  });

  it("作成：上げたファイルの ID で、決まった中身で送り、状態を返す", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("openai-batch-created.json")));
    const r = await client(f).create(FILE);
    expect(r).toEqual({
      ok: true,
      value: {
        id: BATCH, status: "validating", endpoint: "/v1/responses", inputFileId: FILE, outputFileId: null, errorFileId: null,
        counts: { total: 0, completed: 0, failed: 0 }, createdAt: 1762673724_000, expiresAt: 1762760124_000, endedAt: null, validationErrors: 0,
      },
    });
    expect(`${seen[0]!.init.method} ${seen[0]!.url}`).toBe("POST https://api.openai.com/v1/batches");
    expect(seen[0]!.init.headers).toEqual({ authorization: `Bearer ${KEY}`, "content-type": "application/json" });
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ input_file_id: FILE, endpoint: "/v1/responses", completion_window: "24h" });
  });

  it("状態・取り消し・結果の URL。末尾に / のある baseUrl でも / が重ならない", async () => {
    const { f, seen } = fakeFetch((url) => new Response(recorded(url.endsWith("/content") ? "openai-batch-output.jsonl" : "openai-batch-completed.json")));
    const c = client(f, undefined, "https://proxy.example.test/base/");
    expect(await c.retrieve(BATCH)).toMatchObject({
      ok: true,
      value: { status: "completed", outputFileId: "file-Bq7pY1nC2dE3fG4hJ5kL6m", errorFileId: "file-Zx9wV8uT7sR6qP5oN4mL3k", counts: { total: 5, completed: 2, failed: 3 }, endedAt: 1762675331_000 },
    });
    expect((await c.cancel(BATCH)).ok).toBe(true);
    expect((await c.results("file-Bq7pY1nC2dE3fG4hJ5kL6m")).ok).toBe(true);
    expect(seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      `GET https://proxy.example.test/base/v1/batches/${BATCH}`,
      `POST https://proxy.example.test/base/v1/batches/${BATCH}/cancel`,
      "GET https://proxy.example.test/base/v1/files/file-Bq7pY1nC2dE3fG4hJ5kL6m/content",
    ]);
  });

  it("baseUrl は https: だけ。空の ? や # も断る", () => {
    for (const bad of ["http://api.openai.com", "ftp://x", "not a url", "https://user:pw@api.openai.com", "https://api.openai.com?x=1", "https://api.openai.com?", "https://api.openai.com#", "https://api.openai.com/#x"]) {
      expect(() => new OpenAIBatchClient({ apiKey: KEY, baseUrl: bad }), bad).toThrow(RangeError);
    }
  });

  it("一覧：limit・after を付けて読み、上げたファイルの ID で作られたバッチを探せる", async () => {
    const completed = JSON.parse(recorded("openai-batch-completed.json"));
    const other = { ...completed, id: "batch_other", input_file_id: "file-other" };
    const { f, seen } = fakeFetch(() => new Response(JSON.stringify({ object: "list", data: [other, completed], has_more: true, first_id: "batch_other", last_id: BATCH })));
    const r = await client(f).list({ limit: 100, after: "batch_x" });
    expect(r).toMatchObject({ ok: true, value: { hasMore: true, firstId: "batch_other", lastId: BATCH } });
    expect(`${seen[0]!.init.method} ${seen[0]!.url}`).toBe("GET https://api.openai.com/v1/batches?limit=100&after=batch_x");
    expect(r.ok && findBatchesByInputFile(r.value.data, FILE).map((b) => b.id)).toEqual([BATCH]);
    const empty = fakeFetch(() => new Response('{"object":"list","data":[],"has_more":false}'));
    expect(await client(empty.f).list()).toEqual({ ok: true, value: { data: [], hasMore: false, firstId: null, lastId: null } });
    expect(empty.seen[0]!.url).toBe("https://api.openai.com/v1/batches");
    for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { after: "../x" }, { after: "a?b" }]) await expect(client(f).list(bad)).rejects.toThrow(RangeError);
  });

  it("結果（成功のファイル）：output_text だけをつなぎ、トークン数を読む。断りの文は入れない", async () => {
    const { f } = fakeFetch(() => new Response(recorded("openai-batch-output.jsonl")));
    const r = await client(f).results("file-Bq7pY1nC2dE3fG4hJ5kL6m");
    expect(r).toEqual({
      ok: true,
      value: [
        { customId: "run-a", type: "succeeded", status: "completed", output: '{"post":null,"orders":[]}', refused: false, respondedModel: "gpt-6.1-sol", usage: { inputTokens: 20000, outputTokens: 4500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, reasoningTokens: 3000 },
        { customId: "run-b", type: "succeeded", status: "incomplete", incompleteReason: "max_output_tokens", output: "", refused: true, respondedModel: "gpt-6.1-sol", usage: { inputTokens: 20000, outputTokens: 4500, cacheCreationInputTokens: 8192, cacheReadInputTokens: 0 }, reasoningTokens: 4500 },
      ],
    });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("結果（失敗のファイル）：公式の一覧にあるエラーの種類と印だけを残し、エラー文を入れない。期限切れは expired", async () => {
    const { f } = fakeFetch(() => new Response(recorded("openai-batch-errors.jsonl")));
    const r = await client(f).results("file-Zx9wV8uT7sR6qP5oN4mL3k");
    expect(r).toEqual({
      ok: true,
      value: [
        { customId: "run-c", type: "errored", statusCode: 400, errorType: "invalid_request_error" },
        { customId: "run-d", type: "expired" },
        { customId: "run-e", type: "errored", statusCode: 500 },
      ],
    });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("結果の1行が形に合わなければ、その行だけ malformed にして、ほかの行は生かす", async () => {
    const ok = '{"custom_id":"ok-1","response":null,"error":{"code":"batch_expired"}}';
    const usage = (u: object) => JSON.stringify({ custom_id: "bad-3", response: { status_code: 200, body: { object: "response", status: "completed", model: "m", output: [], usage: u } } });
    const lines = [
      ok,
      "not json req_secret123",
      '{"custom_id":"bad-1","response":{"status_code":200,"body":{"object":"response","status":"failed"}}}',
      '{"custom_id":"a/b","response":null,"error":{"code":"batch_expired"}}',
      '{"custom_id":"bad-2","response":null,"error":null}',
      usage({ input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 8, cache_write_tokens: 8 } }),
      usage({ input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 6 } }),
      usage({ input_tokens: -1, output_tokens: 0 }),
    ];
    const { f } = fakeFetch(() => new Response(lines.join("\n")));
    const r = await client(f).results(FILE);
    expect(r).toEqual({
      ok: true,
      value: [
        { customId: "ok-1", type: "expired" },
        { type: "malformed", line: 2 },
        { type: "malformed", line: 3, customId: "bad-1" },
        { type: "malformed", line: 4 },
        { type: "malformed", line: 5, customId: "bad-2" },
        { type: "malformed", line: 6, customId: "bad-3" },
        { type: "malformed", line: 7, customId: "bad-3" },
        { type: "malformed", line: 8, customId: "bad-3" },
      ],
    });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("HTTP の失敗は状態コードだけを返し、本文（エラー文）を入れない", async () => {
    for (const [status, errorCode] of [[429, "rate_limited"], [408, "timeout"], [504, "timeout"], [401, "provider_error"], [500, "provider_error"], [503, "provider_error"]] as const) {
      const { f } = fakeFetch(() => new Response('{"error":{"message":"request-id=req_secret123","type":"invalid_request_error"}}', { status }));
      expect(await client(f).retrieve(BATCH)).toEqual({ ok: false, errorCode, reason: "http", status });
    }
  });

  it("通信断は network、待ち時間切れは timeout、それ以外の例外は unexpected。例外の文を入れない", async () => {
    const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed ECONNRESET request-id=req_secret123")));
    expect(await client(down.f).retrieve(BATCH)).toEqual({ ok: false, errorCode: "provider_error", reason: "network" });
    const odd = fakeFetch(() => Promise.reject(new Error("weird request-id=req_secret123")));
    expect(await client(odd.f).retrieve(BATCH)).toEqual({ ok: false, errorCode: "provider_error", reason: "unexpected" });
    const hang = (async (_: RequestInfo | URL, init?: RequestInit) => abortable(init)) as typeof fetch;
    expect(await client(hang, 5).retrieve(BATCH)).toEqual({ ok: false, errorCode: "timeout", reason: "timeout" });
  });

  it("結果の取り出しは、ほかと別の待ち時間を使う", async () => {
    const slow = (async (_: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((ok) => setTimeout(ok, 30));
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("");
    }) as typeof fetch;
    const c = new OpenAIBatchClient({ apiKey: KEY, fetch: slow, timeoutMs: 5, resultsTimeoutMs: 1000 });
    expect(await c.results(FILE)).toEqual({ ok: true, value: [] });
    expect(await c.retrieve(BATCH)).toMatchObject({ ok: false, errorCode: "timeout" });
  });

  it("作成：応答がない・408・5xx・2xx で形が合わないときは billingUnknown を付ける。ほかの 4xx は付けない", async () => {
    const cases: [typeof fetch, Record<string, unknown>][] = [
      [fakeFetch(() => Promise.reject(new TypeError("fetch failed"))).f, { errorCode: "provider_error", reason: "network", billingUnknown: true }],
      [(async (_: RequestInfo | URL, init?: RequestInit) => abortable(init)) as typeof fetch, { errorCode: "timeout", reason: "timeout", billingUnknown: true }],
      [fakeFetch(() => new Response("", { status: 408 })).f, { errorCode: "timeout", reason: "http", status: 408, billingUnknown: true }],
      [fakeFetch(() => new Response("", { status: 500 })).f, { errorCode: "provider_error", reason: "http", status: 500, billingUnknown: true }],
      [fakeFetch(() => new Response("not json")).f, { errorCode: "provider_error", reason: "malformed", status: 200, billingUnknown: true }],
      [fakeFetch(() => new Response('{"object":"batch","id":"x"}')).f, { errorCode: "provider_error", reason: "malformed", status: 200, billingUnknown: true }],
    ];
    for (const [f, expected] of cases) expect(await client(f, 5).create(FILE)).toEqual({ ok: false, ...expected });
    for (const status of [400, 401, 429]) {
      const r = await client(fakeFetch(() => new Response("", { status })).f).create(FILE);
      expect(r.ok).toBe(false);
      expect(r).not.toHaveProperty("billingUnknown");
    }
  });

  it("ファイルの上げの失敗には billingUnknown を付けず、送った本文は返す", async () => {
    const r = await client(fakeFetch(() => new Response("", { status: 500 })).f).upload([{ customId: "a", params }]);
    expect(r).toMatchObject({ ok: false, errorCode: "provider_error", reason: "http", status: 500 });
    expect(r).not.toHaveProperty("billingUnknown");
    expect(r.sent.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("形が合わない応答は provider_error（中身は返さない）", async () => {
    for (const body of ["not json req_secret123", '{"object":"batch","id":"x","status":"done"}']) {
      const { f } = fakeFetch(() => new Response(body));
      expect(await client(f).retrieve(BATCH)).toEqual({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
      expect(await client(f).list()).toEqual({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
      expect(await client(f).upload([{ customId: "a", params }])).toMatchObject({ ok: false, errorCode: "provider_error", reason: "malformed", status: 200 });
    }
  });

  it("API キーは見出しに入れるだけで、クライアントを文字列にしても出ない。見出しに使えない文字は値を含まない RangeError", () => {
    const c = client(fakeFetch(() => new Response("")).f);
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(String(Object.keys(c))).not.toContain(KEY);
    expect(() => new OpenAIBatchClient({ apiKey: "" })).toThrow(RangeError);
    for (const bad of ["sk-secret\nx", "sk-secret x", "sk-secretあ"]) {
      expect(() => new OpenAIBatchClient({ apiKey: bad })).toThrow(RangeError);
      try {
        new OpenAIBatchClient({ apiKey: bad });
      } catch (e) {
        expect(String(e)).not.toContain("secret");
      }
    }
  });

  it("引数の誤りは呼ばずに RangeError", async () => {
    const { f, seen } = fakeFetch(() => new Response(recorded("openai-file-uploaded.json")));
    const c = client(f);
    await expect(c.upload([])).rejects.toThrow(RangeError);
    await expect(c.upload([{ customId: "a/b", params }])).rejects.toThrow(RangeError);
    await expect(c.upload([{ customId: "a".repeat(65), params }])).rejects.toThrow(RangeError);
    await expect(c.upload([{ customId: "a", params }, { customId: "a", params }])).rejects.toThrow(RangeError);
    await expect(c.upload([{ customId: "a", params }, { customId: "b", params: { ...params, model: "gpt-6-luna" } }])).rejects.toThrow(RangeError);
    await expect(c.upload([{ customId: "a", params: { ...params, max_output_tokens: 15 } }])).rejects.toThrow(RangeError);
    await expect(c.upload([{ customId: "a", params: { ...params, input: [{ role: "tool" as "user", content: "x" }] } }])).rejects.toThrow(RangeError);
    await expect(c.create("../../v1/models")).rejects.toThrow(RangeError);
    await expect(c.retrieve("a?b")).rejects.toThrow(RangeError);
    await expect(c.results("a/b")).rejects.toThrow(RangeError);
    expect(seen).toHaveLength(0);
    expect((await c.upload([{ customId: "a".repeat(64), params }])).ok).toBe(true);
  });
});

describe("結果の突き合わせ（reconcileResults）", () => {
  it("重なった customId と依頼にない customId は信じず、形が合わない行は数える", () => {
    const items: BatchItemResult[] = [
      { customId: "a", type: "expired" },
      { customId: "b", type: "expired" },
      { customId: "b", type: "errored" },
      { customId: "zzz", type: "expired" },
      { type: "malformed", line: 5, customId: "c" },
      { type: "malformed", line: 6 },
    ];
    const r = reconcileResults(["a", "b", "c", "d"], items);
    expect([...r.matched.entries()]).toEqual([["a", { customId: "a", type: "expired" }]]);
    expect(r.duplicated).toEqual(["b"]);
    expect(r.missing).toEqual(["c", "d"]);
    expect(r.unexpected).toBe(1);
    expect(r.malformed).toBe(2);
  });

  it("同じ customId が形の合う行と合わない行の両方に出たら、重なりとして扱う", () => {
    const r = reconcileResults(["a"], [{ customId: "a", type: "expired" }, { type: "malformed", line: 2, customId: "a" }]);
    expect(r.matched.size).toBe(0);
    expect(r.duplicated).toEqual(["a"]);
    expect(r.missing).toEqual([]);
  });
});

describe("送る中身（toOpenAIParams）", () => {
  const user = [{ role: "user" as const, content: "x" }];

  it("messages は役割と本文をそのまま input に入れる。reasoning_effort がなければ入れない", () => {
    const msgs = [{ role: "system" as const, content: "s" }, ...user, { role: "assistant" as const, content: "a" }, ...user];
    expect(toOpenAIParams(model({ max_tokens: "16" }), msgs)).toEqual({ model: "gpt-6.1-sol", input: msgs, max_output_tokens: 16 });
  });

  it("数値の書き方は1つだけ受け付ける。下限は 16", () => {
    for (const m of ["0", "15", "016", "1.0", "+20", "-20", "1e3", " 20", "1234567890"]) expect(() => toOpenAIParams(model({ max_tokens: m }), user), m).toThrow(RangeError);
    for (const e of ["low", "medium", "high", "xhigh", "max"]) expect(toOpenAIParams(model({ max_tokens: "100", reasoning_effort: e }), user).reasoning).toEqual({ effort: e });
    for (const e of ["none", "minimal", "Medium", " low"]) expect(() => toOpenAIParams(model({ max_tokens: "100", reasoning_effort: e }), user), e).toThrow(RangeError);
  });

  it("決まりに合わない settings・messages・提供元は RangeError。temperature は受け付けない", () => {
    expect(() => toOpenAIParams(model({}), user)).toThrow(RangeError);
    expect(() => toOpenAIParams(model({ max_tokens: "100", temperature: "0.2" }), user)).toThrow(RangeError);
    expect(() => toOpenAIParams(model({ max_tokens: "100" }), [])).toThrow(RangeError);
    expect(() => toOpenAIParams(model({ max_tokens: "100" }), [{ role: "system", content: "a" }])).toThrow(RangeError);
    expect(() => toOpenAIParams({ ...model({ max_tokens: "100" }), provider: "anthropic" }, user)).toThrow(RangeError);
  });
});

describe("API キーの読み出し", () => {
  it("環境変数から読む。なければ、値を含まない RangeError", () => {
    expect(openaiApiKeyFromEnv({ OPENAI_API_KEY: KEY })).toBe(KEY);
    expect(() => openaiApiKeyFromEnv({})).toThrow("OPENAI_API_KEY is not set");
    expect(() => openaiApiKeyFromEnv({ OPENAI_API_KEY: "sk-secret\n" })).toThrow(RangeError);
  });
});

describe("OpenAI のバッチの料金", () => {
  it("gpt-6.1-sol：入力2万・出力4,500トークン（推論を含む）は、1ドル160円なら 68（6.8円）", () => {
    // 2万 × 1ドル/100万 ＋ 4,500 × 5ドル/100万 ＝ 0.0425ドル → 6.8円
    const usage = { inputTokens: 20000, outputTokens: 4500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    expect(batchCostDeciyen(usage, openaiBatchPrice("gpt-6.1-sol", usage)!, 160)).toBe(68);
  });

  it("キャッシュへの書き込みは、入力の欄と書き込みの欄の両方で数える（入力の3倍）", () => {
    // (2万 × 1 ＋ 8,192 × 2) × 1ドル/100万 ＋ 4,500 × 5ドル/100万 ＝ 0.058884ドル → 9.42144円 → 切り上げて 9.5円
    const usage = { inputTokens: 20000, outputTokens: 4500, cacheCreationInputTokens: 8192, cacheReadInputTokens: 0 };
    expect(batchCostDeciyen(usage, openaiBatchPrice("gpt-6.1-sol", usage)!, 160)).toBe(95);
  });

  it("入力が 272,000 トークンを超えると、長い文脈の料金（入力2ドル・出力7.5ドル）になる", () => {
    const at = { inputTokens: 272_000, outputTokens: 1000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    const over = { ...at, inputTokens: 272_001 };
    expect(openaiBatchPrice("gpt-6.1-sol", at)).toEqual({ inputCentsPerMTok: 100, outputCentsPerMTok: 500 });
    expect(openaiBatchPrice("gpt-6.1-sol", over)).toEqual({ inputCentsPerMTok: 200, outputCentsPerMTok: 750 });
    expect(batchCostDeciyen(at, openaiBatchPrice("gpt-6.1-sol", at)!, 160)).toBe(444); // 0.277ドル → 44.32円
    expect(batchCostDeciyen(over, openaiBatchPrice("gpt-6.1-sol", over)!, 160)).toBe(883); // 0.551502ドル → 88.24032円
  });

  it("表にないモデルは undefined（toString などの名前も）", () => {
    expect(openaiBatchPrice("gpt-6-astra", { inputTokens: 1 })).toBeUndefined();
    expect(openaiBatchPrice("toString", { inputTokens: 1 })).toBeUndefined();
  });
});
