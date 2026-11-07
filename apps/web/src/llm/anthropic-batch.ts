// Anthropic の Message Batches API（まとめて依頼し、あとで受け取る口。料金は標準の半額）を fetch で呼ぶ部分（#179）。
// 作成・状態・結果・取り消しの4つだけ。費用の上限の予約と LlmPort は、契約が決まってから上に置く（#179 の platform コメント）。
// - API キーは環境変数から読むだけ（anthropicApiKeyFromEnv）。返す値・エラー文・ログに書かない
// - 提供元のエラー文（リクエストIDなどを含みうる）は返す値に入れない。HTTP の状態コードだけを返す
// - 依存は足さない（Node の fetch を使う）
import type { LlmErrorCode, LlmMessage, LlmModel } from "../contracts";
import type { TokenUsage } from "./cost";

/** 送る API の版（anthropic-version の見出し）。2026-11-07 の公式の資料の値 */
export const ANTHROPIC_VERSION = "2026-10-21";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/** 環境変数から API キーを読む。なければ Error（キーの値は文に入れない） */
export function anthropicApiKeyFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const key = env[ANTHROPIC_API_KEY_ENV];
  if (!key) throw new Error(`${ANTHROPIC_API_KEY_ENV} is not set`);
  return key;
}

export type BatchErrorCode = Extract<LlmErrorCode, "timeout" | "rate_limited" | "provider_error">;
/** 失敗。提供元のエラー文は持たない。status は HTTP の状態コード（応答がなかったときはない） */
export type BatchFailure = { ok: false; errorCode: BatchErrorCode; status?: number };
export type BatchCall<T> = { ok: true; value: T } | BatchFailure;

/** Messages API に送る中身。settings と messages から作り、ほかは足さない（ツールなし。EVENT_LOG §3.2） */
export interface AnthropicParams {
  model: string;
  max_tokens: number;
  temperature?: number;
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

export interface BatchRequestItem {
  /** バッチの中の1件のID。英数字・ハイフン・下線で1〜64文字 */
  customId: string;
  params: AnthropicParams;
}

export interface BatchCounts {
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
}

export interface BatchStatus {
  id: string;
  processingStatus: "in_progress" | "canceling" | "ended";
  counts: BatchCounts;
  createdAt: number;
  endedAt: number | null;
  expiresAt: number;
}

/**
 * 1件の結果。課金されるのは succeeded だけ（errored・canceled・expired は課金されない。公式の資料）。
 * errored の提供元のエラー文は持たない。
 */
export type BatchItemResult =
  | { customId: string; type: "succeeded"; output: string; respondedModel: string; stopReason: string | null; usage: TokenUsage }
  | { customId: string; type: "errored" | "canceled" | "expired" };

const CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BATCH_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TOKENS = /^[1-9][0-9]{0,8}$/;
const TEMPERATURE = /^(0(\.[0-9]{1,3})?|1(\.0{1,3})?)$/;

/**
 * LlmModel と messages から、送る中身を作る。settings は max_tokens（必須）と temperature だけを許す。
 * system は先頭の1件だけ許し、Messages API の system に移す（API は messages の中に system を置けないため）。
 * 内容は変えない。決まりに合わなければ RangeError。
 */
export function toAnthropicParams(model: LlmModel, messages: readonly LlmMessage[]): AnthropicParams {
  const unknown = Object.keys(model.settings).filter((k) => k !== "max_tokens" && k !== "temperature");
  if (unknown.length > 0) throw new RangeError(`unsupported settings: ${unknown.join(",")}`);
  const maxTokens = model.settings.max_tokens;
  if (maxTokens === undefined || !MAX_TOKENS.test(maxTokens)) throw new RangeError("settings.max_tokens must be a positive integer");
  const temperature = model.settings.temperature;
  if (temperature !== undefined && !TEMPERATURE.test(temperature)) throw new RangeError("settings.temperature must be between 0 and 1");
  const [first, ...rest] = messages;
  const system = first?.role === "system" ? first.content : undefined;
  const body = system === undefined ? messages : rest;
  if (body.length === 0 || body[0]!.role !== "user") throw new RangeError("messages must start with a user message");
  const turns = body.map((m) => {
    if (m.role === "system") throw new RangeError("system message must be the first one");
    return { role: m.role, content: m.content };
  });
  return {
    model: model.modelId,
    max_tokens: Number(maxTokens),
    ...(temperature === undefined ? {} : { temperature: Number(temperature) }),
    ...(system === undefined ? {} : { system }),
    messages: turns,
  };
}

export interface AnthropicBatchClientOptions {
  apiKey: string;
  /** 試験で差し替える。既定は Node の fetch */
  fetch?: typeof fetch;
  baseUrl?: string;
  /** 1回の HTTP の呼び出しの待ち時間の上限（ミリ秒）。超えたら timeout */
  timeoutMs?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string";
/** 形が合わないとき。呼び出し元で provider_error に直す */
class Malformed extends Error {}
const need = <T>(ok: boolean, v: T): T => {
  if (!ok) throw new Malformed();
  return v;
};
const time = (v: unknown): number => need(isStr(v) && Number.isFinite(Date.parse(v)), Date.parse(v as string));

function parseStatus(json: unknown): BatchStatus {
  need(isObj(json) && json.type === "message_batch" && isStr(json.id) && isObj(json.request_counts), null);
  const j = json as Record<string, unknown>;
  const ps = j.processing_status;
  need(ps === "in_progress" || ps === "canceling" || ps === "ended", null);
  const c = j.request_counts as Record<string, unknown>;
  const counts = { processing: c.processing, succeeded: c.succeeded, errored: c.errored, canceled: c.canceled, expired: c.expired };
  need(Object.values(counts).every(isCount), null);
  return {
    id: j.id as string,
    processingStatus: ps as BatchStatus["processingStatus"],
    counts: counts as BatchCounts,
    createdAt: time(j.created_at),
    endedAt: j.ended_at === null || j.ended_at === undefined ? null : time(j.ended_at),
    expiresAt: time(j.expires_at),
  };
}

const optCount = (v: unknown): number => (v === undefined || v === null ? 0 : need(isCount(v), v as number));

function parseItem(json: unknown): BatchItemResult {
  need(isObj(json) && isStr(json.custom_id) && isObj(json.result), null);
  const j = json as { custom_id: string; result: Record<string, unknown> };
  const type = j.result.type;
  if (type === "errored" || type === "canceled" || type === "expired") return { customId: j.custom_id, type };
  need(type === "succeeded" && isObj(j.result.message), null);
  const m = j.result.message as Record<string, unknown>;
  need(isStr(m.model) && Array.isArray(m.content) && isObj(m.usage) && (m.stop_reason === null || isStr(m.stop_reason)), null);
  const u = m.usage as Record<string, unknown>;
  need(isCount(u.input_tokens) && isCount(u.output_tokens), null);
  // 出力は text の部分だけをつなぐ（考えた過程の部分などは入れない）
  const output = (m.content as unknown[])
    .filter((b) => isObj(b) && b.type === "text")
    .map((b) => need(isStr((b as Record<string, unknown>).text), (b as Record<string, unknown>).text as string))
    .join("");
  return {
    customId: j.custom_id,
    type: "succeeded",
    output,
    respondedModel: m.model as string,
    stopReason: m.stop_reason as string | null,
    usage: {
      inputTokens: u.input_tokens as number,
      outputTokens: u.output_tokens as number,
      cacheCreationInputTokens: optCount(u.cache_creation_input_tokens),
      cacheReadInputTokens: optCount(u.cache_read_input_tokens),
    },
  };
}

function failureOf(status: number): BatchFailure {
  if (status === 429 || status === 529) return { ok: false, errorCode: "rate_limited", status };
  if (status === 408 || status === 504) return { ok: false, errorCode: "timeout", status };
  return { ok: false, errorCode: "provider_error", status };
}

const checkBatchId = (id: string) => {
  if (!BATCH_ID.test(id)) throw new RangeError("invalid batch id");
};

/** Message Batches API の4つの呼び出し。どれも reject せず BatchCall を返す（引数の誤りだけ RangeError で reject） */
export class AnthropicBatchClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: AnthropicBatchClientOptions) {
    if (!options.apiKey) throw new RangeError("apiKey is empty");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = (options.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** バッチを作る（依頼）。customId は重ならないこと */
  async create(items: readonly BatchRequestItem[]): Promise<BatchCall<BatchStatus>> {
    if (items.length === 0) throw new RangeError("no requests");
    const ids = new Set<string>();
    for (const it of items) {
      if (!CUSTOM_ID.test(it.customId) || ids.has(it.customId)) throw new RangeError("customId must be unique and match ^[A-Za-z0-9_-]{1,64}$");
      ids.add(it.customId);
    }
    const body = JSON.stringify({ requests: items.map((it) => ({ custom_id: it.customId, params: it.params })) });
    return this.#json("POST", "/v1/messages/batches", body, parseStatus);
  }

  /** バッチの状態 */
  async retrieve(batchId: string): Promise<BatchCall<BatchStatus>> {
    checkBatchId(batchId);
    return this.#json("GET", `/v1/messages/batches/${batchId}`, undefined, parseStatus);
  }

  /** 取り消しを頼む。返る状態はふつう canceling。終わると ended になり、取り消しの前に処理した分の結果は残る */
  async cancel(batchId: string): Promise<BatchCall<BatchStatus>> {
    checkBatchId(batchId);
    return this.#json("POST", `/v1/messages/batches/${batchId}/cancel`, undefined, parseStatus);
  }

  /** 結果（1行1件の JSON）。状態が ended になってから呼ぶ。結果の並びは依頼の順と限らないので customId で突き合わせる */
  async results(batchId: string): Promise<BatchCall<BatchItemResult[]>> {
    checkBatchId(batchId);
    return this.#call("GET", `/v1/messages/batches/${batchId}/results`, undefined, (text) =>
      text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => parseItem(JSON.parse(line))),
    );
  }

  #json<T>(method: string, path: string, body: string | undefined, parse: (json: unknown) => T): Promise<BatchCall<T>> {
    return this.#call(method, path, body, (text) => parse(JSON.parse(text)));
  }

  async #call<T>(method: string, path: string, body: string | undefined, parse: (text: string) => T): Promise<BatchCall<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const headers: Record<string, string> = { "x-api-key": this.#apiKey, "anthropic-version": ANTHROPIC_VERSION };
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await this.#fetch(`${this.#baseUrl}${path}`, { method, headers, body, signal: controller.signal });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return failureOf(res.status);
      }
      const text = await res.text();
      try {
        return { ok: true, value: parse(text) };
      } catch {
        // 形が合わない応答（JSON でない・欄が足りない）。中身は返さない
        return { ok: false, errorCode: "provider_error", status: res.status };
      }
    } catch {
      // 通信断・待ち時間切れ。例外の文（リクエストIDなどを含みうる）は捨てる
      return { ok: false, errorCode: controller.signal.aborted ? "timeout" : "provider_error" };
    } finally {
      clearTimeout(timer);
    }
  }
}
