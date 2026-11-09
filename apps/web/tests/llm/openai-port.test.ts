// OpenAI のバッチの口（LlmBatchPort）の試験。本物の API は呼ばない。応答は記録済みのもの（recorded/）を返す。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LlmBatchRequest, LlmBatchTicket } from "../../src/contracts";
import { sha256Hex } from "../../src/events/hash";
import { llmTokenCost } from "../../src/events/llm-cost";
import { OpenAIBatchClient, openaiBatchFileBody, toOpenAIParams } from "../../src/llm/openai-batch";
import { openaiBatchPort, openaiReservePrice } from "../../src/llm/openai-port";
import { BATCH_SEND_TIMEOUT_MS } from "../../src/llm/batch-port";
import { batchReservationOf } from "../../src/llm/batch-plan";
import { hangingFetch, settledAt } from "./send-timeout";

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
    policy: { dailyCostLimit: 1000, dryRun: false },
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

const IID = "gpt-ai-20261110";
const FILE_BODY = `{"custom_id":"${IID}","method":"POST","url":"/v1/responses","body":{"model":"gpt-6.1-sol","input":[{"role":"system","content":"あなたは投資家です"},{"role":"user","content":"入力"}],"max_output_tokens":16000,"reasoning":{"effort":"medium"}}}`;
/** 記録済みのバッチの応答に、名前（metadata の custom_id）を付けたもの */
const withName = (name: string, customId: string | null) => JSON.stringify({ ...JSON.parse(recorded(name)), metadata: customId === null ? null : { custom_id: customId } });

describe("OpenAI のバッチの口", () => {
  it("予約の料金は短い文脈の料金（入力は 20,000 トークンまで。1,000万トークンあたりのセント）", () => {
    expect(openaiReservePrice("gpt-6.1-sol")).toEqual(PRICE);
    expect(openaiReservePrice("gpt-unknown")).toBeUndefined();
  });

  it("本文はファイルの中身（中の1件のIDは customId の前半）。送るときはそのまま上げ、名前を metadata に付けてバッチを作る", async () => {
    const hash = await sha256Hex(new TextEncoder().encode(FILE_BODY));
    const customId = `${IID}-${hash.slice(0, 16)}`;
    const { f, seen } = fakeFetch((_m, url) => new Response(url.endsWith("/v1/files") ? recorded("openai-file-uploaded.json") : withName("openai-batch-created.json", customId)));
    const p = await make(f).prepare(req());
    expect(p).toMatchObject({ body: FILE_BODY, sentBodyHash: hash, customId, bodyMaxOutputTokens: 16_000 });
    expect(await make(f).send(p, 7)).toEqual({ ok: true, batchId: BATCH });
    expect(await ((seen[0]!.body as FormData).get("file") as File).text()).toBe(FILE_BODY);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /v1/files", "POST /v1/batches"]);
    expect(JSON.parse(seen[1]!.body as string)).toMatchObject({ input_file_id: FILE, metadata: { custom_id: customId } });
  });

  it("temperature・決まりと違う出力の上限・短い文脈と違う料金・入力を3倍で数えない予約・20,000バイトを超える本文は、本文を作る前に断る", async () => {
    const { f } = fakeFetch(() => new Response("{}"));
    await expect(make(f).prepare(req({ model: { provider: "openai", modelId: "gpt-6.1-sol", settings: { max_tokens: "16000", temperature: "1" } } }))).rejects.toThrow(RangeError);
    await expect(make(f).prepare(req({ reservePrice: { inputCentsPer10MTok: 2000, outputCentsPer10MTok: 7500, yenPerUsd: 160 } }))).rejects.toThrow(RangeError);
    await expect(make(f).prepare(req({ model: { provider: "openai", modelId: "gpt-6.1-sol", settings: { max_tokens: "4000" } } }))).rejects.toThrow(RangeError);
    // 予約は 20,000×3×1ドル＋16,000×5ドル ＝ 0.14ドル ＝ 22.4円（224）。入力を1倍で数えた 160 では足りない
    await expect(make(f).prepare(req({ maxCost: 223 }))).rejects.toThrow(/maxCost/);
    expect(await make(f).prepare(req({ maxCost: 224 }))).toMatchObject({ bodyMaxOutputTokens: 16_000 });
    // 本文の上限は3社と同じ 20,000 バイト。日本語1文字は3バイトなので、6,600文字は送れて、6,700文字で超える
    expect(new TextEncoder().encode((await make(f).prepare(req({ messages: [{ role: "user", content: "あ".repeat(6600) }] }))).body).length).toBeGreaterThan(19_800);
    await expect(make(f).prepare(req({ messages: [{ role: "user", content: "あ".repeat(6700) }] }))).rejects.toThrow(/byte length/);
  });

  it("上げの失敗・作成の 400 は作られていない（notCreated）。作成の 503・通信断・名前の違う応答は分からない（billingUnknown）", async () => {
    const p = await make(fakeFetch(() => new Response("{}")).f).prepare(req());
    const up = fakeFetch(() => new Response('{"error":{"message":"req_secret123"}}', { status: 500 }));
    expect(await make(up.f).send(p, 7)).toEqual({ ok: false, errorCode: "provider_error", notCreated: true });
    expect(up.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /v1/files"]); // バッチを作る依頼は出していない
    const created = (respond: () => Response | Promise<Response>) => fakeFetch((_m, url) => (url.endsWith("/v1/files") ? new Response(recorded("openai-file-uploaded.json")) : respond())).f;
    expect(await make(created(() => new Response("{}", { status: 400 }))).send(p, 7)).toEqual({ ok: false, errorCode: "provider_error", notCreated: true });
    for (const respond of [() => new Response('{"error":{"message":"req_secret123"}}', { status: 503 }), () => Promise.reject(new TypeError("req_secret123")), () => new Response(withName("openai-batch-created.json", "other"))]) {
      const r = await make(created(respond)).send(p, 7);
      expect(r).toMatchObject({ ok: false, billingUnknown: true });
      expect(JSON.stringify(r)).not.toContain("secret");
    }
  });

  it("上げと作成の待ち時間の合計は送る時間の上限（10分）より短く、返らなければ通信を中断する（裏で送り続けない）", async () => {
    const p = await make(fakeFetch(() => new Response("{}")).f).prepare(req());
    // 上げが返らない：クライアントの待ち時間で中断して notCreated。返したあとも、裏でバッチを作る依頼を出さない（さらに10分進めて確かめる）
    const up = hangingFetch();
    let r: unknown;
    let callsAtReturn = -1;
    const after = async () => {
      r = await make(up.f).send(p, 7);
      callsAtReturn = up.state.calls;
      await new Promise((resolve) => setTimeout(resolve, BATCH_SEND_TIMEOUT_MS));
    };
    expect(await settledAt(after, 3 * BATCH_SEND_TIMEOUT_MS)).toBeLessThan(2 * BATCH_SEND_TIMEOUT_MS);
    expect(callsAtReturn).toBe(1);
    expect(up.state).toEqual({ calls: 1, aborted: 1 });
    expect(r).toEqual({ ok: false, errorCode: "timeout", notCreated: true });
    // 上げが待ち時間の上限の直前（119秒）に返り、作成が返らない：合計でも10分より前に中断する
    const state = { aborted: 0 };
    const slow = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/v1/files")
        ? new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(recorded("openai-file-uploaded.json"))), 119_000))
        : new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => ((state.aborted += 1), reject(new DOMException("aborted", "AbortError")))))) as typeof fetch;
    const at = await settledAt(async () => (r = await make(slow).send(p, 7)), BATCH_SEND_TIMEOUT_MS);
    expect(at).not.toBeNull();
    expect(at!).toBeLessThan(BATCH_SEND_TIMEOUT_MS);
    expect(state.aborted).toBe(1);
    expect(r).toEqual({ ok: false, errorCode: "timeout", billingUnknown: true });
  });

  describe("探す", () => {
    const H = createHash("sha256").update(FILE_BODY).digest("hex");
    const CID = `${IID}-${H.slice(0, 16)}`;
    const reservation = { batchSeq: 3, agentId: "gpt-ai", provider: "openai", modelId: "gpt-6.1-sol", customId: CID, sentBodyHash: H, reservedAt: AT, maxCost: 300, tradingDate: "2026-11-10", submittedAt: AT, reservePrice: { ...PRICE, yenPerUsd: 160 } };
    const status = (id: string, at: number, customId: string | null = CID) => ({ ...JSON.parse(withName("openai-batch-completed.json", customId)), id, created_at: Math.floor(at / 1000) });
    const lookup = (data: unknown[], file: () => Response = () => new Response(FILE_BODY)) =>
      fakeFetch((_m, url) => (url.includes(`/files/${FILE}/content`) ? file() : new Response(JSON.stringify({ object: "list", data, has_more: false }))));

    it("時刻の範囲で名前の合う候補がちょうど1つで、上げたファイルのハッシュが同じなら found", async () => {
      const { f, seen } = lookup([status("batch_new", AT + 60_000), status("batch_other", AT, "other-name"), status("batch_old", AT - 86_400_000)]);
      expect(await make(f).find(reservation)).toEqual({ status: "found", batchId: "batch_new" });
      expect(seen.map((s) => s.path)).toEqual(["/v1/batches?limit=100", `/v1/files/${FILE}/content`]);
    });

    it("範囲の外・候補が2つ・ハッシュが違う・ファイルを取り出せない（4xx）なら not_found。一覧やファイルが読めなければ unknown", async () => {
      expect(await make(lookup([status("batch_late", AT + 16 * 60_000)]).f).find(reservation)).toEqual({ status: "not_found" });
      expect(await make(lookup([status("batch_early", AT - 6 * 60_000)]).f).find(reservation)).toEqual({ status: "not_found" });
      expect(await make(lookup([status("batch_a", AT), status("batch_b", AT + 1000)]).f).find(reservation)).toEqual({ status: "not_found" });
      expect(await make(lookup([status("batch_a", AT)], () => new Response(`${FILE_BODY} `)).f).find(reservation)).toEqual({ status: "not_found" });
      expect(await make(lookup([status("batch_a", AT)], () => new Response("{}", { status: 403 })).f).find(reservation)).toEqual({ status: "not_found" });
      expect(await make(lookup([status("batch_a", AT)], () => new Response("", { status: 500 })).f).find(reservation)).toEqual({ status: "unknown" });
      expect(await make(fakeFetch(() => new Response("", { status: 500 })).f).find(reservation)).toEqual({ status: "unknown" });
    });
  });

  describe("受け取り", () => {
    const ticketFor = (): LlmBatchTicket => ({ batchSeq: 3, agentId: "gpt-ai", provider: "openai", modelId: "gpt-6.1-sol", customId: `${IID}-${"c".repeat(16)}`, sentBodyHash: "c".repeat(64), reservedAt: AT, maxCost: 300, tradingDate: "2026-11-10", submittedAt: AT, reservePrice: { ...PRICE, yenPerUsd: 160 }, batchId: BATCH });
    /** 終わったバッチ。結果のファイルの as の customId を、本文の中の1件のIDに置き換える */
    const done = (as: string, status = recorded("openai-batch-completed.json")) =>
      fakeFetch((_m, url) => {
        if (url.endsWith(`/files/${OUT}/content`)) return new Response(recorded("openai-batch-output.jsonl").replace(`"${as}"`, `"${IID}"`));
        if (url.endsWith(`/files/${ERR}/content`)) return new Response(recorded("openai-batch-errors.jsonl").replace(`"${as}"`, `"${IID}"`));
        return new Response(status);
      });

    it("処理中は pending", async () => {
      expect(await make(done("run-a", recorded("openai-batch-created.json")).f).collect(ticketFor())).toEqual({ status: "pending" });
    });

    it("成功：出力と、予約の料金で数えた費用。成功と失敗の両方のファイルを読む", async () => {
      const { f, seen } = done("run-a");
      // (20,000×1ドル＋4,500×5ドル)/100万 ＝ 0.0425ドル × 160円 ＝ 6.8円
      expect(await make(f).collect(ticketFor())).toEqual({ status: "closed", result: "collected", output: '{"post":null,"orders":[]}', respondedModel: "gpt-6.1-sol", usage: { inputTokens: 20_000, outputTokens: 4500, cost: 68 }, price: PRICE, finishedAt: AT + 5000 });
      expect(seen.map((s) => s.path)).toEqual([`/v1/batches/${BATCH}`, `/v1/files/${OUT}/content`, `/v1/files/${ERR}/content`]);
    });

    it("キャッシュの書き込みも予約の料金で数える。出力の上限で止まった答え（incomplete）は truncated: true", async () => {
      expect(await make(done("run-b").f).collect(ticketFor())).toMatchObject({ result: "collected", truncated: true, usage: { inputTokens: 20_000, outputTokens: 4500, cacheCreationInputTokens: 8192 } });
    });

    it("入力が上限の 20,000 トークンで、1つを除いてキャッシュへの書き込みで、出力が上限ちょうどでも、記録の費用（3倍）も実際の請求（最大2.5倍）も予約を超えない", async () => {
      const { maxCost, maxBodyBytes } = batchReservationOf({ provider: "openai", modelId: "gpt-6.1-sol" }, AT);
      expect(maxCost).toBe(224);
      expect(maxBodyBytes).toBe(20_000);
      const bytes = new TextEncoder().encode(openaiBatchFileBody([{ customId: IID, params: toOpenAIParams(req().model, [{ role: "user", content: "あ".repeat(6600) }]) }])).length;
      expect(bytes).toBeLessThanOrEqual(maxBodyBytes);
      // 記録済みの run-b の行の使用量を、入力が 20,000 トークンで、1つを除いてキャッシュへの書き込みにしたもの
      const n = 20_000;
      // 実際の請求の最大：書き込みは入力の2.5倍。(1×1ドル＋19,999×2.5ドル＋16,000×5ドル)/100万 × 160円 ＝ 20.80円
      const billedYen = ((1 * 1 + (n - 1) * 2.5 + 16_000 * 5) / 1_000_000) * 160;
      expect(billedYen * 10).toBeLessThanOrEqual(maxCost);
      // 入力を1倍で数えた予約（16円）では足りない
      expect(llmTokenCost({ inputTokens: n, outputTokens: 16_000 }, { ...PRICE, yenPerUsd: 160 })!).toBeLessThan(billedYen * 10);
      const line = JSON.parse(recorded("openai-batch-output.jsonl").split("\n").find((l) => l.includes('"run-b"'))!);
      line.custom_id = IID;
      line.response.body.usage = { input_tokens: n, input_tokens_details: { cached_tokens: 0, cache_write_tokens: n - 1 }, output_tokens: 16_000, output_tokens_details: { reasoning_tokens: 16_000 }, total_tokens: n + 16_000 };
      const { f } = fakeFetch((_m, url) => new Response(url.endsWith(`/files/${OUT}/content`) ? JSON.stringify(line) : recorded(url.endsWith(`/files/${ERR}/content`) ? "openai-batch-errors.jsonl" : "openai-batch-completed.json")));
      const c = await make(f).collect({ ...ticketFor(), maxCost });
      expect(c).toMatchObject({ result: "collected", usage: { inputTokens: n, outputTokens: 16_000, cacheCreationInputTokens: n - 1 } });
      if (c.status !== "closed") throw new Error("pending");
      expect(c.usage.cost).toBeGreaterThanOrEqual(billedYen * 10); // 記録の費用は実際の請求以上（多めに数える）
      expect(c.usage.cost).toBeLessThanOrEqual(maxCost);
    });

    it("期限切れ・失敗した1件・バッチの failed は、予約した費用（costUnknown）。エラー文は返さない", async () => {
      expect(await make(done("run-d").f).collect(ticketFor())).toMatchObject({ result: "expired", errorCode: "timeout", usage: { cost: 300 }, costUnknown: true });
      const failed = await make(done("run-c").f).collect(ticketFor());
      expect(failed).toMatchObject({ result: "failed", errorCode: "provider_error", usage: { cost: 300 }, costUnknown: true });
      expect(JSON.stringify(failed)).not.toContain("secret");
      const failedBatch = JSON.stringify({ ...JSON.parse(recorded("openai-batch-completed.json")), status: "failed", output_file_id: null, error_file_id: null });
      expect(await make(done("run-a", failedBatch).f).collect(ticketFor())).toMatchObject({ result: "failed", costUnknown: true });
      const broken = fakeFetch((_m, url) => (url.includes("/files/") ? new Response("", { status: 500 }) : new Response(recorded("openai-batch-completed.json"))));
      expect(await make(broken.f).collect(ticketFor())).toEqual({ status: "pending" });
    });

    it("打ち切り：処理中なら取り消しを頼み、終わらなければ maxCost の expired", async () => {
      const { f, seen } = fakeFetch(() => new Response(recorded("openai-batch-created.json")));
      expect(await make(f).abandon(ticketFor())).toMatchObject({ result: "expired", errorCode: "timeout", usage: { cost: 300 }, costUnknown: true });
      expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([`GET /v1/batches/${BATCH}`, `POST /v1/batches/${BATCH}/cancel`, `GET /v1/batches/${BATCH}`]);
    });

    it("費用と料金は控えの予約の料金で出す（口の料金表・円が控えと違っても選び直さない）。打ち切りも同じ", async () => {
      const rp = { inputCentsPer10MTok: 2000, outputCentsPer10MTok: 9000, yenPerUsd: 150 };
      const t = { ...ticketFor(), reservePrice: rp, maxCost: 1000 };
      const cost = llmTokenCost({ inputTokens: 20_000, outputTokens: 4500 }, rp);
      expect(cost).toBe(121); // (20,000×2ドル＋4,500×9ドル)/100万 × 150円 ＝ 12.075円
      const other = (f: typeof fetch) => openaiBatchPort({ policy: { dailyCostLimit: 1000, dryRun: false }, clock: { now: () => AT + 5000 }, yenPerUsd: 170, client: new OpenAIBatchClient({ apiKey: KEY, fetch: f }) });
      const price = { inputCentsPer10MTok: 2000, outputCentsPer10MTok: 9000 };
      expect(await other(done("run-a").f).collect(t)).toMatchObject({ result: "collected", usage: { cost }, price });
      expect(await other(done("run-a").f).abandon(t)).toMatchObject({ result: "expired", usage: { cost }, price });
    });
  });
});
