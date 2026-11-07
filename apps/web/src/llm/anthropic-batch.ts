// Anthropic の Message Batches API（まとめて依頼し、あとで受け取る口。料金は標準の半額）を fetch で呼ぶ部分（#179）。
// 作成・一覧・状態・結果・取り消しだけ。費用の上限の予約と LlmPort は、契約が決まってから上に置く（#179 の platform コメント）。
// - API キーは環境変数から読むだけ（anthropicApiKeyFromEnv）。返す値・エラー文・ログに書かない
// - 提供元のエラー文と例外の文（リクエストIDなどを含みうる）は返す値に入れない。HTTP の状態コードと、決まった印だけを返す
// - 依存は足さない（Node の fetch を使う）
import type { LlmErrorCode, LlmMessage, LlmModel } from "../contracts";
import { sha256Hex } from "../events/hash";
import type { TokenUsage } from "./cost";

/**
 * 送る API の版（anthropic-version の見出し）。
 * 出典：https://platform.claude.com/docs/en/api/versioning （2026-11-07 確認）
 */
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
/**
 * 失敗の理由（秘密を含まない決まった印）。
 * http：応答が 2xx でない。timeout：待ち時間切れ（本文を読む途中を含む）。network：通信の失敗（fetch の TypeError）。
 * malformed：応答の形が合わない。unexpected：それ以外の例外（文は捨てる）
 */
export type BatchFailureReason = "http" | "timeout" | "network" | "malformed" | "unexpected";
/**
 * 失敗。提供元のエラー文は持たない。status は HTTP の状態コード（応答がなかったときはない）。
 * billingUnknown：作成（create）で、バッチが作られた（＝課金されうる）かどうか分からない失敗の印。
 * この印の付いた失敗は自動で再試行しない（2回作ると2回課金されうる）。list で作成の時刻と件数から突き合わせる。
 */
export type BatchFailure = { ok: false; errorCode: BatchErrorCode; reason: BatchFailureReason; status?: number; billingUnknown?: true };
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

/** バッチの情報。customId は入らない（提供元の応答にないため） */
export interface BatchStatus {
  id: string;
  processingStatus: "in_progress" | "canceling" | "ended";
  counts: BatchCounts;
  createdAt: number;
  endedAt: number | null;
  expiresAt: number;
}

/** 作成で実際に送った本文の文字列と、その SHA-256（16進）。API キーは見出しにだけあり、ここには入らない */
export interface SentBody {
  body: string;
  sha256: string;
}
/** 作成の結果。成功でも失敗でも、送った本文を一緒に返す（監査と、課金が分からない失敗の突き合わせに使う） */
export type BatchCreateResult = BatchCall<BatchStatus> & { sent: SentBody };

export interface BatchListOptions {
  /** 1〜1000 の整数。なければ提供元の既定 */
  limit?: number;
  afterId?: string;
  beforeId?: string;
}
export interface BatchList {
  data: BatchStatus[];
  hasMore: boolean;
  firstId: string | null;
  lastId: string | null;
}

/** errored の結果に残すエラーの種類。公式の一覧（https://platform.claude.com/docs/en/api/errors）にあるものだけ */
export const ANTHROPIC_ERROR_TYPES = [
  "invalid_request_error",
  "authentication_error",
  "billing_error",
  "permission_error",
  "not_found_error",
  "conflict_error",
  "rate_limit_error",
  "api_error",
  "timeout_error",
  "overloaded_error",
] as const;
export type AnthropicErrorType = (typeof ANTHROPIC_ERROR_TYPES)[number];

/**
 * 1件の結果。課金されるのは succeeded だけ（errored・canceled・expired は課金されない。公式の資料）。
 * errored は、エラーの種類が公式の一覧にあるときだけ errorType を持つ。エラー文は持たない。
 * malformed は、その行の形が合わなかったもの（line は結果の本文の何行目か。1から）。customId は、決まりに合う文字列のときだけ持つ。
 * malformed の行が課金されたかは分からない（呼び出し側は maxCost を費用として残す）。
 */
export type BatchItemResult =
  | { customId: string; type: "succeeded"; output: string; respondedModel: string; stopReason: string | null; usage: TokenUsage }
  | { customId: string; type: "errored"; errorType?: AnthropicErrorType }
  | { customId: string; type: "canceled" | "expired" }
  | { type: "malformed"; line: number; customId?: string };

const CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BATCH_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** 先頭が 0 でない整数（9桁まで） */
const MAX_TOKENS = /^[1-9][0-9]{0,8}$/;
/** "0"・"1"、または "0." の後に1〜3桁で末尾が 0 でないもの。"0.20"・"1.0"・"1.001" は断る（書き方を1つに決め、ハッシュを揺らさない） */
const TEMPERATURE = /^(0|1|0\.[0-9]{0,2}[1-9])$/;

/**
 * LlmModel と messages から、送る中身を作る。settings は max_tokens（必須）と temperature だけを許す。
 * system は先頭の1件だけ許し、Messages API の system に移す（API は messages の中に system を置けないため）。
 * 内容は変えない。決まりに合わなければ RangeError。
 * 注意：system の移動と、数値の文字列から数への変換は、契約（LlmRequest.messages の「加工せずそのまま送る」）と
 * 食い違いうる。lead の判断待ち（#179 の platform コメント）。実際に送った本文とハッシュは create が返す。
 */
export function toAnthropicParams(model: LlmModel, messages: readonly LlmMessage[]): AnthropicParams {
  const unknown = Object.keys(model.settings).filter((k) => k !== "max_tokens" && k !== "temperature");
  if (unknown.length > 0) throw new RangeError(`unsupported settings: ${unknown.join(",")}`);
  const maxTokens = model.settings.max_tokens;
  if (maxTokens === undefined || !MAX_TOKENS.test(maxTokens)) throw new RangeError("settings.max_tokens must be an integer without a leading zero");
  const temperature = model.settings.temperature;
  if (temperature !== undefined && !TEMPERATURE.test(temperature)) throw new RangeError('settings.temperature must be "0", "1" or "0." followed by 1-3 digits not ending with 0');
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
  /** 試験で差し替える。既定は Node の fetch（包んで呼ぶ） */
  fetch?: typeof fetch;
  /** https: だけ。末尾の / は取る。試験では baseUrl ではなく fetch を差し替える */
  baseUrl?: string;
  /** 1回の HTTP の呼び出し（本文を読み終えるまで）の待ち時間の上限（ミリ秒）。超えたら timeout */
  timeoutMs?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string";
/** 形が合わないとき。呼び出し元で provider_error（malformed）に直す */
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

const optId = (v: unknown): string | null => (v === null || v === undefined ? null : need(isStr(v), v as string));

function parseList(json: unknown): BatchList {
  need(isObj(json) && Array.isArray(json.data) && typeof json.has_more === "boolean", null);
  const j = json as Record<string, unknown>;
  return { data: (j.data as unknown[]).map(parseStatus), hasMore: j.has_more as boolean, firstId: optId(j.first_id), lastId: optId(j.last_id) };
}

const optCount = (v: unknown): number => (v === undefined || v === null ? 0 : need(isCount(v), v as number));
const KNOWN_ERROR_TYPES: ReadonlySet<string> = new Set(ANTHROPIC_ERROR_TYPES);

/** errored の結果から、公式の一覧にあるエラーの種類だけを取る（{ error: { type: "error", error: { type } } } の形） */
function erroredType(result: Record<string, unknown>): AnthropicErrorType | undefined {
  const outer = result.error;
  const inner = isObj(outer) && isObj(outer.error) ? outer.error.type : undefined;
  return isStr(inner) && KNOWN_ERROR_TYPES.has(inner) ? (inner as AnthropicErrorType) : undefined;
}

function parseItem(json: unknown): BatchItemResult {
  need(isObj(json) && isStr(json.custom_id) && CUSTOM_ID.test(json.custom_id) && isObj(json.result), null);
  const j = json as { custom_id: string; result: Record<string, unknown> };
  const type = j.result.type;
  if (type === "errored") {
    const errorType = erroredType(j.result);
    return errorType === undefined ? { customId: j.custom_id, type } : { customId: j.custom_id, type, errorType };
  }
  if (type === "canceled" || type === "expired") return { customId: j.custom_id, type };
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

/** 結果の1行を読む。形が合わなければ、その行だけ malformed にする（ほかの行は生かす） */
function parseLine(line: string, lineNo: number): BatchItemResult {
  let json: unknown;
  try {
    json = JSON.parse(line);
    return parseItem(json);
  } catch {
    const id = isObj(json) && isStr(json.custom_id) && CUSTOM_ID.test(json.custom_id) ? json.custom_id : undefined;
    return id === undefined ? { type: "malformed", line: lineNo } : { type: "malformed", line: lineNo, customId: id };
  }
}

export interface ReconciledResults {
  /** 依頼した customId ごとの結果（重なったものは入れない） */
  matched: Map<string, Exclude<BatchItemResult, { type: "malformed" }>>;
  /** 依頼したのに結果がない customId（malformed の行のものを含む） */
  missing: string[];
  /** 結果に2回以上出た customId。どれを信じるか決められないので matched に入れない */
  duplicated: string[];
  /** 依頼にない customId の結果の数 */
  unexpected: number;
  /** 形が合わなかった行の数 */
  malformed: number;
}

/**
 * 依頼した customId と結果を突き合わせる。結果の並びは依頼の順と限らない。
 * 重なり・依頼にない ID・形が合わない行は、信じずに数だけ返す（呼び出し側は missing と duplicated を maxCost のまま残す）。
 */
export function reconcileResults(requested: readonly string[], items: readonly BatchItemResult[]): ReconciledResults {
  const wanted = new Set(requested);
  const seen = new Map<string, Exclude<BatchItemResult, { type: "malformed" }>[]>();
  let unexpected = 0;
  let malformed = 0;
  for (const it of items) {
    if (it.type === "malformed") {
      malformed += 1;
      continue;
    }
    if (!wanted.has(it.customId)) {
      unexpected += 1;
      continue;
    }
    seen.set(it.customId, [...(seen.get(it.customId) ?? []), it]);
  }
  const matched = new Map<string, Exclude<BatchItemResult, { type: "malformed" }>>();
  const duplicated: string[] = [];
  const missing: string[] = [];
  for (const id of wanted) {
    const got = seen.get(id) ?? [];
    if (got.length === 1) matched.set(id, got[0]!);
    else if (got.length > 1) duplicated.push(id);
    else missing.push(id);
  }
  return { matched, missing, duplicated, unexpected, malformed };
}

function failureOf(status: number): BatchFailure {
  if (status === 429 || status === 529) return { ok: false, errorCode: "rate_limited", reason: "http", status };
  if (status === 408 || status === 504) return { ok: false, errorCode: "timeout", reason: "http", status };
  return { ok: false, errorCode: "provider_error", reason: "http", status };
}

/**
 * 作成の失敗で、バッチが作られたかもしれないもの。応答がなかった（待ち時間切れ・通信断・それ以外の例外）、
 * 408・5xx（向こうで処理が進んだかもしれない）、2xx なのに本文が読めない・形が合わない（作られている）。
 * 408 以外の 4xx（400・401・403・404・413・429 など）は、作られていないとみなす。
 */
function uncertainOnCreate(f: BatchFailure): boolean {
  if (f.status === undefined) return true;
  return f.status === 408 || f.status >= 500 || (f.status >= 200 && f.status < 300);
}

const checkBatchId = (id: string) => {
  if (!BATCH_ID.test(id)) throw new RangeError("invalid batch id");
};

function checkBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RangeError("baseUrl must be an https URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new RangeError("baseUrl must be an https URL without credentials, query or fragment");
  }
  return raw.replace(/\/+$/, "");
}

/** Message Batches API の呼び出し。どれも reject せず BatchCall を返す（引数の誤りだけ RangeError で reject） */
export class AnthropicBatchClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: AnthropicBatchClientOptions) {
    if (!options.apiKey) throw new RangeError("apiKey is empty");
    this.#apiKey = options.apiKey;
    // 既定の fetch は包んで呼ぶ（this を失った呼び出しにしない）
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#baseUrl = checkBaseUrl(options.baseUrl ?? ANTHROPIC_BASE_URL);
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * バッチを作る（依頼）。customId は重ならないこと。送った本文とそのハッシュを、結果と一緒に返す。
   * 失敗に billingUnknown が付いたら、作られたか分からない。自動で再試行せず、list で作成の時刻と件数から突き合わせる。
   * バッチの情報に customId は入らないので、突き合わせは作成の時刻と件数でしかできない（同じ時刻・同じ件数が並ぶと決められない）。
   */
  async create(items: readonly BatchRequestItem[]): Promise<BatchCreateResult> {
    if (items.length === 0) throw new RangeError("no requests");
    const ids = new Set<string>();
    for (const it of items) {
      if (!CUSTOM_ID.test(it.customId) || ids.has(it.customId)) throw new RangeError("customId must be unique and match ^[A-Za-z0-9_-]{1,64}$");
      ids.add(it.customId);
    }
    const body = JSON.stringify({ requests: items.map((it) => ({ custom_id: it.customId, params: it.params })) });
    const sent: SentBody = { body, sha256: await sha256Hex(new TextEncoder().encode(body)) };
    const r = await this.#json("POST", "/v1/messages/batches", body, parseStatus);
    if (!r.ok && uncertainOnCreate(r)) return { ...r, billingUnknown: true, sent };
    return { ...r, sent };
  }

  /** バッチの一覧（新しい順）。作成の失敗に billingUnknown が付いたときの突き合わせに使う */
  async list(options: BatchListOptions = {}): Promise<BatchCall<BatchList>> {
    const q = new URLSearchParams();
    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) throw new RangeError("limit must be an integer from 1 to 1000");
      q.set("limit", String(options.limit));
    }
    if (options.afterId !== undefined) {
      checkBatchId(options.afterId);
      q.set("after_id", options.afterId);
    }
    if (options.beforeId !== undefined) {
      checkBatchId(options.beforeId);
      q.set("before_id", options.beforeId);
    }
    const qs = q.toString();
    return this.#json("GET", `/v1/messages/batches${qs === "" ? "" : `?${qs}`}`, undefined, parseList);
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

  /**
   * 結果（1行1件の JSON）。状態が ended になってから呼ぶ。結果の並びは依頼の順と限らないので、reconcileResults で突き合わせる。
   * 形が合わない行は、その行だけ malformed にして、ほかの行は返す。
   */
  async results(batchId: string): Promise<BatchCall<BatchItemResult[]>> {
    checkBatchId(batchId);
    return this.#call("GET", `/v1/messages/batches/${batchId}/results`, undefined, (text) => {
      const out: BatchItemResult[] = [];
      text.split("\n").forEach((line, i) => {
        if (line.trim() !== "") out.push(parseLine(line, i + 1));
      });
      return out;
    });
  }

  #json<T>(method: string, path: string, body: string | undefined, parse: (json: unknown) => T): Promise<BatchCall<T>> {
    return this.#call(method, path, body, (text) => parse(JSON.parse(text)));
  }

  async #call<T>(method: string, path: string, body: string | undefined, parse: (text: string) => T): Promise<BatchCall<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let status: number | undefined;
    try {
      const headers: Record<string, string> = { "x-api-key": this.#apiKey, "anthropic-version": ANTHROPIC_VERSION };
      if (body !== undefined) headers["content-type"] = "application/json";
      // 転送には従わない（キーの付いた見出しを別の場所へ送らない）
      const res = await this.#fetch(`${this.#baseUrl}${path}`, { method, headers, body, signal: controller.signal, redirect: "error" });
      status = res.status;
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return failureOf(res.status);
      }
      const text = await res.text();
      try {
        return { ok: true, value: parse(text) };
      } catch {
        // 形が合わない応答（JSON でない・欄が足りない）。中身は返さない
        return { ok: false, errorCode: "provider_error", reason: "malformed", status: res.status };
      }
    } catch (e) {
      // 例外の文（リクエストIDなどを含みうる）は捨て、決まった印だけを返す
      const at = status === undefined ? {} : { status };
      if (controller.signal.aborted) return { ok: false, errorCode: "timeout", reason: "timeout", ...at };
      if (e instanceof TypeError) return { ok: false, errorCode: "provider_error", reason: "network", ...at };
      return { ok: false, errorCode: "provider_error", reason: "unexpected", ...at };
    } finally {
      clearTimeout(timer);
    }
  }
}
