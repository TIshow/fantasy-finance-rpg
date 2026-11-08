// OpenAI のバッチの口（LlmBatchPort）の試験。本物の API は呼ばない。応答は記録済みのもの（recorded/）を返す。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LlmBatchRequest, LlmBatchTicket } from "../../src/contracts";
import { sha256Hex } from "../../src/events/hash";
import { llmTokenCost } from "../../src/events/llm-cost";
import { BatchBudget, batchCustomIdOf } from "../../src/llm/batch-port";
import { OpenAIBatchClient, openaiBatchFileBody, toOpenAIParams } from "../../src/llm/openai-batch";
import { OPENAI_CREATE_SETTLE_MS, openaiBatchPort, openaiReservePrice } from "../../src/llm/openai-port";

const recorded = (name: string) => readFileSync(new URL(`./recorded/${name}`, import.meta.url), "utf8");
const KEY = "sk-test-not-a-real-key";
const BATCH = "batch_690f3a2b7c8c8190a1b2c3d4e5f60718";
const FILE = "file-6F2ksmvXxt4VdoqmHRw6kL";
const OUT = "file-Bq7pY1nC2dE3fG4hJ5kL6m";
const ERR = "file-Zx9wV8uT7sR6qP5oN4mL3k";
const AT = Date.parse("2026-11-09T07:35:00Z");
const PRICE = { inputCentsPer10MTok: 1000, outputCentsPer10MTok: 5000 };

function fakeFetch(respond: (method: string, url: string) => Response | Promise<Response>) {
  const seen: { method: string; path: string; body?: unknown }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    seen.push({ method, path: String(input).replace("https://api.openai.com", ""), body: init?.body });
    return respond(method, String(input));
  }) as typeof fetch;
  return { f, seen };
}
const make = (f: typeof fetch) =>
  openaiBatchPort({
    budget: new BatchBudget({ dailyCostLimit: 1000, dryRun: false }, async () => ({ used: 0, recordedKeys: new Set() })),
    clock: { now: () => AT + 5000 },
    client: new OpenAIBatchClient({ apiKey: KEY, fetch: f }),
  });

const req = (over: Partial<LlmBatchRequest> = {}): LlmBatchRequest => ({
  agentId: "gpt-ai",
  purpose: "order",
  model: { provider: "openai", modelId: "gpt-6.1-sol", settings: { max_tokens: "16000", reasoning_effort: "medium" } },
  prompt: { id: "p", version: "1", hash: "0".repeat(64) },
  inputSeqs: [1],
  messages: [
    { role: "system", content: "あなたは投資家です" },
    { role: "user", content: "入力" },
  ],
  maxCost: 300,
  tradingDate: "2026-11-10",
  submittedAt: AT,
  reservePrice: { ...PRICE, yenPerUsd: 160 },
  maxInputTokens: 20_000,
  maxOutputTokens: 16_000,
  ...over,
});

describe("OpenAI のバッチの口", () => {
  it("予約の料金は短い文脈の料金（入力は 20,000 トークンまで。1,000万トークンあたりのセント）", () => {
    expect(openaiReservePrice("gpt-6.1-sol")).toEqual(PRICE);
    expect(openaiReservePrice("gpt-unknown")).toBeUndefined();
  });

  it("依頼：ファイルを上げてからバッチを作る。送った本文のハッシュは、上げたファイルの中身のハッシュ", async () => {
    const { f, seen } = fakeFetch((_m, url) => new Response(recorded(url.endsWith("/v1/files") ? "openai-file-uploaded.json" : "openai-batch-created.json")));
    const r = await make(f).submit(req());
    const customId = await batchCustomIdOf("gpt-ai", "2026-11-10");
    const file = `{"custom_id":"${customId}","method":"POST","url":"/v1/responses","body":{"model":"gpt-6.1-sol","input":[{"role":"system","content":"あなたは投資家です"},{"role":"user","content":"入力"}],"max_output_tokens":16000,"reasoning":{"effort":"medium"}}}`;
    expect(await ((seen[0]!.body as FormData).get("file") as File).text()).toBe(file);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /v1/files", "POST /v1/batches"]);
    expect(r).toEqual({
      ok: true,
      sentBodyHash: await sha256Hex(new TextEncoder().encode(file)),
      ticket: { agentId: "gpt-ai", provider: "openai", modelId: "gpt-6.1-sol", batchId: BATCH, customId, maxCost: 300, tradingDate: "2026-11-10", submittedAt: AT },
    });
  });

  it("temperature・決まりと違う出力の上限・短い文脈と違う料金・6,666バイトを超える本文は、送る前に断る", async () => {
    const { f, seen } = fakeFetch(() => new Response("{}"));
    await expect(make(f).submit(req({ model: { provider: "openai", modelId: "gpt-6.1-sol", settings: { max_tokens: "16000", temperature: "1" } } }))).rejects.toThrow(RangeError);
    await expect(make(f).submit(req({ reservePrice: { inputCentsPer10MTok: 2000, outputCentsPer10MTok: 7500, yenPerUsd: 160 } }))).rejects.toThrow(RangeError);
    await expect(make(f).submit(req({ model: { provider: "openai", modelId: "gpt-6.1-sol", settings: { max_tokens: "4000" } } }))).rejects.toThrow(RangeError);
    // 入力の上限 20,000 ÷ 倍率3。日本語1文字は3バイトなので、2,200文字で超える
    await expect(make(f).submit(req({ messages: [{ role: "user", content: "あ".repeat(2200) }] }))).rejects.toThrow(/byte length/);
    expect(seen).toHaveLength(0);
  });

  it("上げの失敗は作られていない。作成の 503・通信断は作られたか分からない（rate_limited でも billingUnknown）", async () => {
    const up = fakeFetch(() => new Response('{"error":{"message":"req_secret123"}}', { status: 500 }));
    const r1 = await make(up.f).submit(req());
    expect(r1).toMatchObject({ ok: false, errorCode: "provider_error" });
    expect("billingUnknown" in r1).toBe(false);
    for (const respond of [() => new Response('{"error":{"message":"req_secret123"}}', { status: 503 }), () => Promise.reject(new TypeError("req_secret123"))]) {
      const { f } = fakeFetch((_m, url) => (url.endsWith("/v1/files") ? new Response(recorded("openai-file-uploaded.json")) : respond()));
      const r = await make(f).submit(req());
      expect(r).toMatchObject({ ok: false, billingUnknown: true });
      expect(JSON.stringify(r)).not.toContain("secret");
    }
  });

  describe("受け取り", () => {
    const ticketFor = async (): Promise<LlmBatchTicket> => ({ agentId: "gpt-ai", provider: "openai", modelId: "gpt-6.1-sol", batchId: BATCH, customId: await batchCustomIdOf("gpt-ai", "2026-11-10"), maxCost: 300, tradingDate: "2026-11-10", submittedAt: AT });
    /** 終わったバッチ。結果のファイルの as の customId を、依頼の customId に置き換える */
    const done = async (as: string, status = recorded("openai-batch-completed.json")) => {
      const id = await batchCustomIdOf("gpt-ai", "2026-11-10");
      return fakeFetch((_m, url) => {
        if (url.endsWith(`/files/${OUT}/content`)) return new Response(recorded("openai-batch-output.jsonl").replace(`"${as}"`, `"${id}"`));
        if (url.endsWith(`/files/${ERR}/content`)) return new Response(recorded("openai-batch-errors.jsonl").replace(`"${as}"`, `"${id}"`));
        return new Response(status);
      });
    };

    it("処理中は pending", async () => {
      expect(await make((await done("run-a", recorded("openai-batch-created.json"))).f).collect(await ticketFor())).toEqual({ status: "pending" });
    });

    it("成功：出力と、予約の料金で数えた費用。成功と失敗の両方のファイルを読む", async () => {
      const { f, seen } = await done("run-a");
      // (20,000×1ドル＋4,500×5ドル)/100万 ＝ 0.0425ドル × 160円 ＝ 6.8円
      expect(await make(f).collect(await ticketFor())).toEqual({ status: "closed", result: "collected", output: '{"post":null,"orders":[]}', respondedModel: "gpt-6.1-sol", usage: { inputTokens: 20_000, outputTokens: 4500, cost: 68 }, price: PRICE, finishedAt: AT + 5000 });
      expect(seen.map((s) => s.path)).toEqual([`/v1/batches/${BATCH}`, `/v1/files/${OUT}/content`, `/v1/files/${ERR}/content`]);
    });

    it("キャッシュの書き込みも予約の料金で数える。出力の上限で止まった答え（incomplete）は truncated: true", async () => {
      expect(await make((await done("run-b")).f).collect(await ticketFor())).toMatchObject({ result: "collected", truncated: true, usage: { inputTokens: 20_000, outputTokens: 4500, cacheCreationInputTokens: 8192 } });
    });

    it("キャッシュの書き込みが入力のほぼすべてで、出力が max_tokens ちょうどでも、費用は maxCost を超えない（予約は入力の3倍を見込む）", async () => {
      const id = await batchCustomIdOf("gpt-ai", "2026-11-10");
      const bytes = new TextEncoder().encode(openaiBatchFileBody([{ customId: id, params: toOpenAIParams(req().model, req().messages) }])).length;
      const maxCost = llmTokenCost({ inputTokens: bytes * 3, outputTokens: 16_000 }, { ...PRICE, yenPerUsd: 160 })!;
      const created = () => fakeFetch((_m, url) => new Response(recorded(url.endsWith("/v1/files") ? "openai-file-uploaded.json" : "openai-batch-created.json"))).f;
      await expect(make(created()).submit(req({ maxInputTokens: bytes * 3 - 1, maxCost }))).rejects.toThrow(RangeError);
      const r = await make(created()).submit(req({ maxInputTokens: bytes * 3, maxCost }));
      if (!r.ok) throw new Error("submit failed");
      // 記録済みの run-b の行の使用量を、入力が本文のバイト数ちょうどで、1つを除いてキャッシュへの書き込みにしたもの
      const line = JSON.parse(recorded("openai-batch-output.jsonl").split("\n").find((l) => l.includes('"run-b"'))!);
      line.custom_id = id;
      line.response.body.usage = { input_tokens: bytes, input_tokens_details: { cached_tokens: 0, cache_write_tokens: bytes - 1 }, output_tokens: 16_000, output_tokens_details: { reasoning_tokens: 16_000 }, total_tokens: bytes + 16_000 };
      const { f } = fakeFetch((_m, url) => new Response(url.endsWith(`/files/${OUT}/content`) ? JSON.stringify(line) : recorded(url.endsWith(`/files/${ERR}/content`) ? "openai-batch-errors.jsonl" : "openai-batch-completed.json")));
      const c = await make(f).collect(r.ticket);
      expect(c).toMatchObject({ result: "collected", usage: { inputTokens: bytes, outputTokens: 16_000, cacheCreationInputTokens: bytes - 1 } });
      if (c.status !== "closed") throw new Error("pending");
      expect(c.usage.cost).toBeLessThanOrEqual(maxCost);
    });

    it("期限切れは課金されない。失敗した1件は課金が分からない（maxCost）。エラー文は返さない", async () => {
      expect(await make((await done("run-d")).f).collect(await ticketFor())).toMatchObject({ result: "expired", errorCode: "timeout", usage: { cost: 0 }, price: PRICE });
      const failed = await make((await done("run-c")).f).collect(await ticketFor());
      expect(failed).toMatchObject({ result: "failed", errorCode: "provider_error", usage: { cost: 300 }, costUnknown: true });
      expect(JSON.stringify(failed)).not.toContain("secret");
    });

    it("バッチが failed、または結果のファイルが読めない", async () => {
      const failedBatch = JSON.stringify({ ...JSON.parse(recorded("openai-batch-completed.json")), status: "failed", output_file_id: null, error_file_id: null });
      expect(await make((await done("run-a", failedBatch)).f).collect(await ticketFor())).toMatchObject({ result: "failed", costUnknown: true });
      const broken = fakeFetch((_m, url) => (url.includes("/files/") ? new Response("", { status: 500 }) : new Response(recorded("openai-batch-completed.json"))));
      expect(await make(broken.f).collect(await ticketFor())).toEqual({ status: "pending" });
    });

    it("打ち切り：処理中なら取り消しを頼み、終わらなければ maxCost の expired", async () => {
      const { f, seen } = fakeFetch(() => new Response(recorded("openai-batch-created.json")));
      expect(await make(f).abandon(await ticketFor())).toMatchObject({ result: "expired", errorCode: "timeout", usage: { cost: 300 }, costUnknown: true });
      expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([`GET /v1/batches/${BATCH}`, `POST /v1/batches/${BATCH}/cancel`, `GET /v1/batches/${BATCH}`]);
    });
  });

  it("記録にないバッチを探す：since（秒に切り下げ）より後に作られた、記録にないもの。送ってから1時間たつまでは none にしない", async () => {
    const status = (id: string, createdAt: number) => ({ ...JSON.parse(recorded("openai-batch-completed.json")), id, created_at: Math.floor(createdAt / 1000) });
    // batch_sec は since と同じ秒に作られた（created_at は秒なので、切り下げずに比べると since より前に見える）
    const page = { object: "list", data: [status("batch_new", AT), status("batch_rec", AT), status("batch_sec", AT - 600_000), status("batch_old", AT - 86_400_000)], has_more: true, first_id: "batch_new", last_id: "batch_old" };
    const q = { agentId: "gpt-ai", tradingDate: "2026-11-10", since: AT - 600_000 + 999, now: AT + OPENAI_CREATE_SETTLE_MS, requestedAt: AT, recordedBatchIds: new Set(["batch_rec"]) };
    expect(await make(fakeFetch(() => new Response(JSON.stringify(page))).f).findUnrecorded(q)).toEqual({ kind: "found", batchIds: ["batch_new", "batch_sec"] });
    const empty = () => fakeFetch(() => new Response('{"object":"list","data":[],"has_more":false}')).f;
    expect(await make(empty()).findUnrecorded(q)).toEqual({ kind: "none" });
    expect(await make(empty()).findUnrecorded({ ...q, now: AT + OPENAI_CREATE_SETTLE_MS - 1 })).toEqual({ kind: "unknown" });
    expect(await make(fakeFetch(() => new Response("", { status: 500 })).f).findUnrecorded(q)).toEqual({ kind: "unknown" });
  });
});
