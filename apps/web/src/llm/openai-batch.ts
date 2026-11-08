// OpenAI の Batch API（まとめて依頼し、あとで受け取る口。料金は標準の半額）を fetch で呼ぶ部分（#179）。
// 依頼の本文（1行1件の JSON）をファイルとして上げ、そのファイルからバッチを作る。結果もファイルで受け取る。
// ファイルの上げ・バッチの作成・一覧・状態・取り消し・結果の取り出しだけ。費用の上限の予約と LlmPort は、契約が決まってから上に置く。
// 作りは anthropic-batch.ts とそろえる。
// - API キーは環境変数から読むだけ（openaiApiKeyFromEnv）。返す値・エラー文・ログに書かない
// - 提供元のエラー文と例外の文（リクエストIDなどを含みうる）は返す値に入れない。HTTP の状態コードと、決まった印だけを返す
// - 依存は足さない（Node の fetch・FormData・Blob を使う）
// 出典（どれも 2026-11-07 確認）：
// - Batch API：https://developers.openai.com/api/docs/guides/batch
// - バッチ・ファイルの API：https://developers.openai.com/api/reference/resources/batches 、
//   https://developers.openai.com/api/reference/resources/files/methods/create
// - Responses API：https://developers.openai.com/api/reference/resources/responses/methods/create
// - エラーの一覧：https://developers.openai.com/api/docs/guides/error-codes
import type { LlmMessage, LlmModel } from "../contracts";
import { sha256Hex } from "../events/hash";
import type { BatchFailure, SentBody } from "./batch-types";
import type { TokenUsage } from "./cost";

export type { BatchCall, BatchFailure, SentBody } from "./batch-types";

export const OPENAI_BASE_URL = "https://api.openai.com";
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
/** バッチの中の依頼が呼ぶ口。OpenAI が推論のモデルに勧める Responses API */
export const OPENAI_BATCH_ENDPOINT = "/v1/responses";
/** 今は 24h だけ選べる */
export const OPENAI_COMPLETION_WINDOW = "24h";
/** 1つのバッチの上限（件数と、ファイルの大きさ） */
export const OPENAI_BATCH_MAX_REQUESTS = 50_000;
export const OPENAI_BATCH_MAX_BYTES = 200 * 1024 * 1024;

/** 見出しに入れられる文字（表示できる ASCII）だけ。外れたら値を含まない RangeError */
function checkApiKey(key: string | undefined, label: string): string {
  if (!key) throw new RangeError(`${label} is empty`);
  if (!/^[\x21-\x7e]{1,1024}$/.test(key)) throw new RangeError(`${label} contains characters that cannot be sent in a header`);
  return key;
}

/** 環境変数から API キーを読む。なければ、または見出しに使えない文字があれば RangeError（キーの値は文に入れない） */
export function openaiApiKeyFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (!env[OPENAI_API_KEY_ENV]) throw new RangeError(`${OPENAI_API_KEY_ENV} is not set`);
  return checkApiKey(env[OPENAI_API_KEY_ENV], OPENAI_API_KEY_ENV);
}

/** 推論の量。gpt-6.1-sol は none を受け付けない（https://developers.openai.com/api/docs/guides/latest-model） */
export const OPENAI_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type OpenAIReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number];

/** Responses API に送る中身。settings と messages から作り、ほかは足さない（ツールなし。EVENT_LOG §3.2） */
export interface OpenAIParams {
  model: string;
  input: { role: LlmMessage["role"]; content: string }[];
  max_output_tokens: number;
  reasoning?: { effort: OpenAIReasoningEffort };
}

export interface BatchRequestItem {
  /** バッチの中の1件のID。英数字・ハイフン・下線で1〜64文字 */
  customId: string;
  params: OpenAIParams;
}

/** 先頭が 0 でない整数（9桁まで）。資料の下限は 16 */
const MAX_TOKENS = /^[1-9][0-9]{0,8}$/;
const MIN_OUTPUT_TOKENS = 16;
const ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant"]);
const EFFORTS: ReadonlySet<string> = new Set(OPENAI_REASONING_EFFORTS);

/**
 * LlmModel と messages から、送る中身を作る。settings は max_tokens（必須。Responses API の max_output_tokens。
 * 推論のトークンを含む上限）と reasoning_effort だけを許す。temperature は断る（推論の量が none でないと、
 * API が受け付けない。gpt-6.1-sol は none を選べない）。
 * messages は役割と本文をそのまま input に入れる（Responses API は input の中に system を置けるので、動かさない）。
 * 決まりに合わなければ RangeError。数値の文字列から数への変換は、契約の「加工せずそのまま送る」と食い違いうる
 * （#179 の lead の判断待ち）。実際に送った本文とハッシュは upload が返す。
 */
export function toOpenAIParams(model: LlmModel, messages: readonly LlmMessage[]): OpenAIParams {
  if (model.provider !== "openai") throw new RangeError("provider must be openai");
  const unknown = Object.keys(model.settings).filter((k) => k !== "max_tokens" && k !== "reasoning_effort");
  if (unknown.length > 0) throw new RangeError(`unsupported settings: ${unknown.join(",")}`);
  const maxTokens = model.settings.max_tokens;
  if (maxTokens === undefined || !MAX_TOKENS.test(maxTokens) || Number(maxTokens) < MIN_OUTPUT_TOKENS) {
    throw new RangeError(`settings.max_tokens must be an integer of at least ${MIN_OUTPUT_TOKENS} without a leading zero`);
  }
  const effort = model.settings.reasoning_effort;
  if (effort !== undefined && !EFFORTS.has(effort)) throw new RangeError(`settings.reasoning_effort must be one of ${OPENAI_REASONING_EFFORTS.join(",")}`);
  if (messages.length === 0 || !messages.some((m) => m.role === "user")) throw new RangeError("messages must include a user message");
  return {
    model: model.modelId,
    input: messages.map((m) => ({ role: m.role, content: m.content })),
    max_output_tokens: Number(maxTokens),
    ...(effort === undefined ? {} : { reasoning: { effort: effort as OpenAIReasoningEffort } }),
  };
}

/**
 * 1件分の行を、決まった欄・決まった順に組み立て直す（型をすり抜けた余分な欄（tools など）を送らない）。
 * 欄の値も確かめ、外れたら RangeError。
 */
function requestLine(item: BatchRequestItem): string {
  // 型をすり抜けた undefined・null・配列でも TypeError にせず、RangeError で断る
  if (!isObj(item.params)) throw new RangeError("params must be an object");
  const p = item.params;
  if (typeof p.model !== "string" || p.model === "") throw new RangeError("params.model must be a non-empty string");
  if (!Number.isSafeInteger(p.max_output_tokens) || p.max_output_tokens < MIN_OUTPUT_TOKENS) throw new RangeError("params.max_output_tokens is invalid");
  if (!Array.isArray(p.input) || p.input.length === 0) throw new RangeError("params.input must not be empty");
  const input = p.input.map((m: unknown) => {
    if (!isObj(m) || !isStr(m.role) || !ROLES.has(m.role) || typeof m.content !== "string") throw new RangeError("params.input has an invalid message");
    return { role: m.role as LlmMessage["role"], content: m.content };
  });
  if (p.reasoning !== undefined && (!isObj(p.reasoning) || !isStr(p.reasoning.effort) || !EFFORTS.has(p.reasoning.effort))) throw new RangeError("params.reasoning.effort is invalid");
  const body = {
    model: p.model,
    input,
    max_output_tokens: p.max_output_tokens,
    ...(p.reasoning === undefined ? {} : { reasoning: { effort: p.reasoning.effort } }),
  };
  return JSON.stringify({ custom_id: item.customId, method: "POST", url: OPENAI_BATCH_ENDPOINT, body });
}

/**
 * 上げるファイルの中身（1行1件の JSON。行は \n でつなぐ）。upload はこれと同じ文字列を送る（ハッシュを先に出すために公開する）。
 * 決まりに合わなければ RangeError
 */
export function openaiBatchFileBody(items: readonly BatchRequestItem[]): string {
  if (!Array.isArray(items) || items.length === 0 || items.length > OPENAI_BATCH_MAX_REQUESTS) throw new RangeError(`requests must be 1 to ${OPENAI_BATCH_MAX_REQUESTS}`);
  const ids = new Set<string>();
  for (const it of items) {
    if (!isObj(it) || !isStr(it.customId) || !CUSTOM_ID.test(it.customId) || ids.has(it.customId)) throw new RangeError("customId must be unique and match ^[A-Za-z0-9_-]{1,64}$");
    ids.add(it.customId);
  }
  // 形の確かめ（requestLine）を先に済ませてから、モデルを数える
  const lines = items.map(requestLine);
  // 1つのファイルには1つのモデルの依頼しか入れられない
  if (new Set(items.map((it) => it.params.model)).size !== 1) throw new RangeError("all requests in a batch must use the same model");
  const body = lines.join("\n");
  if (new TextEncoder().encode(body).length > OPENAI_BATCH_MAX_BYTES) throw new RangeError("batch input is too large");
  return body;
}

/** 上げたファイルの情報 */
export interface UploadedFile {
  id: string;
  bytes: number | null;
  createdAt: number;
}
/** ファイルの上げの結果。成功でも失敗でも、送った本文（1行1件の JSON）とそのハッシュを一緒に返す */
export type UploadResult = OpenAIBatchCall<UploadedFile> & { sent: SentBody };

export type OpenAIBatchState = "validating" | "failed" | "in_progress" | "finalizing" | "completed" | "expired" | "cancelling" | "cancelled";
const STATES: ReadonlySet<string> = new Set(["validating", "failed", "in_progress", "finalizing", "completed", "expired", "cancelling", "cancelled"]);

/** バッチの情報。時刻はミリ秒。検証の失敗（errors）は文を持たず、件数だけ */
export interface BatchStatus {
  id: string;
  status: OpenAIBatchState;
  endpoint: string;
  inputFileId: string;
  /** 成功した依頼の結果のファイル */
  outputFileId: string | null;
  /** 失敗・期限切れの依頼の結果のファイル */
  errorFileId: string | null;
  counts: { total: number; completed: number; failed: number };
  createdAt: number;
  expiresAt: number | null;
  /** 終わった時刻（completed・failed・expired・cancelled のどれか） */
  endedAt: number | null;
  validationErrors: number;
  /** 作成で付けた名前（metadata の custom_id）。なければ null */
  customId: string | null;
}
export type BatchCreateResult = OpenAIBatchCall<BatchStatus> & { billingUnknown?: true };

export interface BatchListOptions {
  /** 1〜100 の整数。なければ提供元の既定（20） */
  limit?: number;
  after?: string;
}
export interface BatchList {
  data: BatchStatus[];
  hasMore: boolean;
  firstId: string | null;
  lastId: string | null;
}

/** エラーの種類（error.type）。公式のエラーの一覧にあるものだけ残す */
export const OPENAI_ERROR_TYPES = ["invalid_request_error", "rate_limit_error", "service_unavailable_error", "insufficient_quota"] as const;
/** エラーの印（error.code）。公式のエラーの一覧と、Batch API の資料（batch_expired）にあるものだけ残す */
export const OPENAI_ERROR_CODES = [
  "credit_balance_exhausted",
  "slow_down",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "server_is_overloaded",
  "batch_expired",
] as const;
export type OpenAIErrorType = (typeof OPENAI_ERROR_TYPES)[number];
export type OpenAIErrorCode = (typeof OPENAI_ERROR_CODES)[number];

/**
 * お金に関わる印：残高切れ・使用額の上限。429 で返るが、待っても通らない（人が残高や上限を直すまで続く）。
 * これらが付いた失敗は rate_limited にせず provider_error にする。
 */
export const OPENAI_BILLING_ERROR_TYPES: readonly OpenAIErrorType[] = ["insufficient_quota"];
export const OPENAI_BILLING_ERROR_CODES: readonly OpenAIErrorCode[] = [
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
];

/**
 * 失敗。BatchFailure に、応答の本文にあったエラーの種類（providerErrorType）と印（providerErrorCode）を足したもの。
 * 公式の一覧にあるときだけ載せる。エラー文は持たない。
 */
export type OpenAIBatchFailure = BatchFailure & { providerErrorType?: OpenAIErrorType; providerErrorCode?: OpenAIErrorCode };
export type OpenAIBatchCall<T> = { ok: true; value: T } | OpenAIBatchFailure;

/** 失敗が、残高切れ・使用額の上限によるものか（待っても通らない。人が確かめる） */
export function isOpenAIBillingError(f: { providerErrorType?: OpenAIErrorType; providerErrorCode?: OpenAIErrorCode }): boolean {
  return (
    (f.providerErrorType !== undefined && OPENAI_BILLING_ERROR_TYPES.includes(f.providerErrorType)) ||
    (f.providerErrorCode !== undefined && OPENAI_BILLING_ERROR_CODES.includes(f.providerErrorCode))
  );
}

/**
 * 1件の結果。
 * succeeded：応答が 200 で、Responses の status が completed か incomplete（出力の上限・内容の検査で途中で止まった）。
 *   どちらも課金される。output は output_text をつないだもの。refused は、モデルが答えを断った部分があったか。
 * errored：応答が 200 でない、または応答がなくエラーだけがある。資料は課金されるのを「完了した依頼のトークン」とだけ書き、
 *   失敗した依頼の課金を書いていない。トークン数も返らないので、呼び出し側は maxCost を費用として残す。
 *   エラーの種類と印は、公式の一覧にあるときだけ持つ。エラー文は持たない。
 * expired：24時間以内に処理されなかった（課金されない）。
 * malformed：その行の形が合わなかったもの（line は何行目か。1から）。課金されたかは分からない（maxCost を費用とする）。
 */
export type BatchItemResult =
  | {
      customId: string;
      type: "succeeded";
      status: "completed" | "incomplete";
      incompleteReason?: "max_output_tokens" | "content_filter";
      output: string;
      refused: boolean;
      respondedModel: string;
      usage: TokenUsage;
      reasoningTokens: number;
    }
  | { customId: string; type: "errored"; statusCode?: number; errorType?: OpenAIErrorType; errorCode?: OpenAIErrorCode }
  | { customId: string; type: "expired" }
  | { type: "malformed"; line: number; customId?: string };

const CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface OpenAIBatchClientOptions {
  apiKey: string;
  /** 試験で差し替える。既定は Node の fetch（包んで呼ぶ） */
  fetch?: typeof fetch;
  /** https: だけ。?・#・利用者名は断る。末尾の / は取る。試験では baseUrl ではなく fetch を差し替える */
  baseUrl?: string;
  /** 1回の HTTP の呼び出し（本文を読み終えるまで）の待ち時間の上限（ミリ秒）。超えたら timeout */
  timeoutMs?: number;
  /** 結果のファイルの取り出しの待ち時間の上限（ミリ秒）。件数が多いと本文が大きくなるので、ほかより長い既定にする */
  resultsTimeoutMs?: number;
  /** ファイルの上げの待ち時間の上限（ミリ秒）。上げるファイルは最大 200MB なので、ほかより長い既定にする */
  uploadTimeoutMs?: number;
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
/** Unix 時刻（秒）をミリ秒に */
const time = (v: unknown): number => need(isCount(v), (v as number) * 1000);
const optTime = (v: unknown): number | null => (v === null || v === undefined ? null : time(v));
const isId = (v: unknown): v is string => isStr(v) && OBJECT_ID.test(v);
/** ID の欄。なければ null。あれば英数字・ハイフン・下線だけ（あとで URL のパスに入れるので、形を確かめる） */
const optId = (v: unknown): string | null => (v === null || v === undefined ? null : need(isId(v), v as string));
const optCount = (v: unknown): number => (v === null || v === undefined ? 0 : need(isCount(v), v as number));

function parseFile(json: unknown): UploadedFile {
  need(isObj(json) && json.object === "file" && isStr(json.id) && OBJECT_ID.test(json.id) && json.purpose === "batch", null);
  const j = json as Record<string, unknown>;
  return { id: j.id as string, bytes: j.bytes === null || j.bytes === undefined ? null : need(isCount(j.bytes), j.bytes as number), createdAt: time(j.created_at) };
}

function parseStatus(json: unknown): BatchStatus {
  need(isObj(json) && json.object === "batch" && isId(json.id) && isStr(json.status) && STATES.has(json.status), null);
  const j = json as Record<string, unknown>;
  need(isStr(j.endpoint) && isId(j.input_file_id), null);
  const c = j.request_counts ?? { total: 0, completed: 0, failed: 0 };
  need(isObj(c) && isCount(c.total) && isCount(c.completed) && isCount(c.failed), null);
  const counts = c as { total: number; completed: number; failed: number };
  const errors = j.errors;
  need(errors === null || errors === undefined || (isObj(errors) && (errors.data === undefined || Array.isArray(errors.data))), null);
  const ends = [j.completed_at, j.failed_at, j.expired_at, j.cancelled_at].map(optTime).filter((t): t is number => t !== null);
  return {
    id: j.id as string,
    status: j.status as OpenAIBatchState,
    endpoint: j.endpoint as string,
    inputFileId: j.input_file_id as string,
    outputFileId: optId(j.output_file_id),
    errorFileId: optId(j.error_file_id),
    counts: { total: counts.total, completed: counts.completed, failed: counts.failed },
    createdAt: time(j.created_at),
    expiresAt: optTime(j.expires_at),
    endedAt: ends.length === 0 ? null : Math.max(...ends),
    validationErrors: isObj(errors) && Array.isArray(errors.data) ? errors.data.length : 0,
    customId: isObj(j.metadata) && isStr(j.metadata.custom_id) ? j.metadata.custom_id : null,
  };
}

function parseList(json: unknown): BatchList {
  need(isObj(json) && json.object === "list" && Array.isArray(json.data) && typeof json.has_more === "boolean", null);
  const j = json as Record<string, unknown>;
  return { data: (j.data as unknown[]).map(parseStatus), hasMore: j.has_more as boolean, firstId: optId(j.first_id), lastId: optId(j.last_id) };
}

const KNOWN_TYPES: ReadonlySet<string> = new Set(OPENAI_ERROR_TYPES);
const KNOWN_CODES: ReadonlySet<string> = new Set(OPENAI_ERROR_CODES);

/** エラーの欄から、公式の一覧にある種類と印だけを取る */
function knownError(error: unknown): { errorType?: OpenAIErrorType; errorCode?: OpenAIErrorCode } {
  if (!isObj(error)) return {};
  return {
    ...(isStr(error.type) && KNOWN_TYPES.has(error.type) ? { errorType: error.type as OpenAIErrorType } : {}),
    ...(isStr(error.code) && KNOWN_CODES.has(error.code) ? { errorCode: error.code as OpenAIErrorCode } : {}),
  };
}

/**
 * 提供元のトークン数を cost.ts の欄に、高めに数える側で割り当てる。
 * input_tokens はキャッシュから読んだ分と書き込んだ分を含む（含まない数が返ったら形が合わないとして断る）。
 * - 入力：input_tokens 全部を入力の単価で数える（読み出し（0.05倍）も入力の単価で数える）
 * - 書き込み：cache_write_tokens を cost.ts の書き込みの欄（入力の2倍）にも入れる。入力の欄と合わせて3倍になり、
 *   12時間の書き込み（2.5倍）より高い。cost.ts の読み出しの欄は使わない。
 *   予約はこの3倍を見込む（openai-port.ts の inputCostFactor）ので、費用は maxCost を超えない
 * - 出力：output_tokens（推論のトークンを含む）
 */
function toTokenUsage(u: Record<string, unknown>): { usage: TokenUsage; reasoningTokens: number } {
  need(isCount(u.input_tokens) && isCount(u.output_tokens), null);
  const inDetails = u.input_tokens_details ?? {};
  const outDetails = u.output_tokens_details ?? {};
  need(isObj(inDetails) && isObj(outDetails), null);
  const input = u.input_tokens as number;
  const output = u.output_tokens as number;
  const cached = optCount((inDetails as Record<string, unknown>).cached_tokens);
  const written = optCount((inDetails as Record<string, unknown>).cache_write_tokens);
  const reasoning = optCount((outDetails as Record<string, unknown>).reasoning_tokens);
  need(cached + written <= input && reasoning <= output, null);
  return { usage: { inputTokens: input, outputTokens: output, cacheCreationInputTokens: written, cacheReadInputTokens: 0 }, reasoningTokens: reasoning };
}

function parseSucceeded(customId: string, body: unknown): BatchItemResult {
  need(isObj(body) && body.object === "response" && (body.status === "completed" || body.status === "incomplete"), null);
  const b = body as Record<string, unknown>;
  need(isStr(b.model) && Array.isArray(b.output) && isObj(b.usage), null);
  let output = "";
  let refused = false;
  // 出力は message の output_text の部分だけをつなぐ（推論の部分などは入れない）
  for (const item of b.output as unknown[]) {
    need(isObj(item), null);
    const it = item as Record<string, unknown>;
    if (it.type !== "message") continue;
    need(Array.isArray(it.content), null);
    for (const part of it.content as unknown[]) {
      need(isObj(part), null);
      const p = part as Record<string, unknown>;
      if (p.type === "output_text") output += need(isStr(p.text), p.text as string);
      else if (p.type === "refusal") refused = true;
    }
  }
  const { usage, reasoningTokens } = toTokenUsage(b.usage as Record<string, unknown>);
  const reason = isObj(b.incomplete_details) ? b.incomplete_details.reason : undefined;
  const incompleteReason =
    b.status === "incomplete" && (reason === "max_output_tokens" || reason === "content_filter") ? { incompleteReason: reason as "max_output_tokens" | "content_filter" } : {};
  return { customId, type: "succeeded", status: b.status as "completed" | "incomplete", ...incompleteReason, output, refused, respondedModel: b.model as string, usage, reasoningTokens };
}

function parseItem(json: unknown): BatchItemResult {
  need(isObj(json) && isStr(json.custom_id) && CUSTOM_ID.test(json.custom_id), null);
  const j = json as Record<string, unknown>;
  const customId = j.custom_id as string;
  const res = j.response;
  if (res === null || res === undefined) {
    need(isObj(j.error), null);
    const err = knownError(j.error);
    return err.errorCode === "batch_expired" ? { customId, type: "expired" } : { customId, type: "errored", ...err };
  }
  need(isObj(res) && isCount(res.status_code), null);
  const r = res as Record<string, unknown>;
  if (r.status_code !== 200) {
    const err = isObj(r.body) ? knownError(r.body.error) : {};
    return { customId, type: "errored", statusCode: r.status_code as number, ...err };
  }
  return parseSucceeded(customId, r.body);
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
  /** 依頼した customId ごとの結果（ちょうど1回だけ出て、形が合っていたもの） */
  matched: Map<string, Exclude<BatchItemResult, { type: "malformed" }>>;
  /** 依頼したのに結果がない customId と、形が合わない行にだけ出た customId */
  missing: string[];
  /** 結果に2回以上出た customId（形が合わない行も数える）。どれを信じるか決められないので matched に入れない */
  duplicated: string[];
  /** 依頼にない customId の結果の数 */
  unexpected: number;
  /** 形が合わなかった行の数 */
  malformed: number;
}

/**
 * 依頼した customId と結果を突き合わせる。成功のファイルと失敗のファイルの結果は、つないでから渡す。
 * 結果の並びは依頼の順と限らない。重なり・依頼にない ID・形が合わない行は、信じずに数だけ返す
 * （呼び出し側は missing と duplicated を maxCost のまま残す）。
 */
export function reconcileResults(requested: readonly string[], items: readonly BatchItemResult[]): ReconciledResults {
  const wanted = new Set(requested);
  const seen = new Map<string, BatchItemResult[]>();
  let unexpected = 0;
  let malformed = 0;
  for (const it of items) {
    if (it.type === "malformed") malformed += 1;
    if (it.customId === undefined) continue;
    if (!wanted.has(it.customId)) {
      if (it.type !== "malformed") unexpected += 1;
      continue;
    }
    seen.set(it.customId, [...(seen.get(it.customId) ?? []), it]);
  }
  const matched: ReconciledResults["matched"] = new Map();
  const duplicated: string[] = [];
  const missing: string[] = [];
  for (const id of wanted) {
    const got = seen.get(id) ?? [];
    const only = got[0];
    if (got.length > 1) duplicated.push(id);
    else if (only !== undefined && only.type !== "malformed") matched.set(id, only);
    else missing.push(id);
  }
  return { matched, missing, duplicated, unexpected, malformed };
}

/**
 * 作成の失敗で billingUnknown が付いたときの突き合わせ。一覧から、上げたファイルの ID で作られたバッチを探す。
 * 渡された一覧の中だけを探す。一覧は複数のページに分かれる（hasMore が true なら、lastId を after に渡して次を読む）ので、
 * 呼び出し側が全ページ（少なくとも、ファイルを上げた時刻より後に作られた分のすべて）を読んでつないでから渡す。
 * ファイルは1回の作成にしか使わないので、見つかれば2つ目を作らない。見つからなくても、一覧の更新が遅れている
 * かもしれないので、自動で作り直さない（運用者が確かめる）。
 */
export function findBatchesByInputFile(batches: readonly BatchStatus[], inputFileId: string): BatchStatus[] {
  return batches.filter((b) => b.inputFileId === inputFileId);
}

/**
 * 2xx でない応答の分類。marks は本文の error.type・error.code のうち、公式の一覧にあるもの。
 * - お金に関わる印（残高切れ・使用額の上限）は、429 でも provider_error（待っても通らない）
 * - 429 と 503（混んでいる・ゆっくり送って。Anthropic の 529 と同じ扱い）は rate_limited
 * - 408・504 は timeout。ほかは provider_error
 */
function failureOf(status: number, marks: { errorType?: OpenAIErrorType; errorCode?: OpenAIErrorCode }): OpenAIBatchFailure {
  const provider = {
    ...(marks.errorType === undefined ? {} : { providerErrorType: marks.errorType }),
    ...(marks.errorCode === undefined ? {} : { providerErrorCode: marks.errorCode }),
  };
  const errorCode: BatchFailure["errorCode"] = isOpenAIBillingError(provider)
    ? "provider_error"
    : status === 429 || status === 503
      ? "rate_limited"
      : status === 408 || status === 504
        ? "timeout"
        : "provider_error";
  return { ok: false, errorCode, reason: "http", status, ...provider };
}

/** 2xx でない応答の本文から、公式の一覧にあるエラーの種類と印だけを取る。読めなければ何も取らない（エラー文は捨てる） */
async function errorMarks(res: Response): Promise<{ errorType?: OpenAIErrorType; errorCode?: OpenAIErrorCode }> {
  try {
    const json: unknown = JSON.parse(await res.text());
    return isObj(json) ? knownError(json.error) : {};
  } catch {
    return {};
  }
}

/**
 * 作成の失敗で、バッチが作られたかもしれないもの。応答がなかった（待ち時間切れ・通信断・それ以外の例外）、
 * 408・5xx（向こうで処理が進んだかもしれない）、2xx なのに本文が読めない・形が合わない（作られている）。
 * 408 以外の 4xx は、作られていないとみなす。
 */
function uncertainOnCreate(f: OpenAIBatchFailure): boolean {
  if (f.status === undefined) return true;
  return f.status === 408 || f.status >= 500 || (f.status >= 200 && f.status < 300);
}

const checkId = (id: string) => {
  if (!OBJECT_ID.test(id)) throw new RangeError("invalid id");
};

/** 接続先。https: だけ。?・#（空でも）・利用者名・パスワードは断る。解析した origin とパスから作り直す */
function checkBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RangeError("baseUrl must be an https URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || raw.includes("?") || raw.includes("#")) {
    throw new RangeError("baseUrl must be an https URL without credentials, query or fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Batch API の呼び出し。どれも reject せず OpenAIBatchCall を返す（引数の誤りだけ RangeError で reject） */
export class OpenAIBatchClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #resultsTimeoutMs: number;
  readonly #uploadTimeoutMs: number;

  constructor(options: OpenAIBatchClientOptions) {
    this.#apiKey = checkApiKey(options.apiKey, "apiKey");
    // 既定の fetch は包んで呼ぶ（this を失った呼び出しにしない）
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#baseUrl = checkBaseUrl(options.baseUrl ?? OPENAI_BASE_URL);
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#resultsTimeoutMs = options.resultsTimeoutMs ?? 120_000;
    this.#uploadTimeoutMs = options.uploadTimeoutMs ?? 120_000;
  }

  /**
   * 依頼の本文（1行1件の JSON。行は \n でつなぐ）をファイルとして上げる（purpose は batch）。
   * 送った本文とそのハッシュを、結果と一緒に返す。ファイルの上げは課金されないので、billingUnknown は付けない。
   */
  async upload(items: readonly BatchRequestItem[]): Promise<UploadResult> {
    return this.uploadBody(openaiBatchFileBody(items));
  }

  /** openaiBatchFileBody で作った中身を、加工せずにファイルとして上げる（契約：記録のハッシュと送った本文を一致させる） */
  async uploadBody(body: string): Promise<UploadResult> {
    if (typeof body !== "string" || body === "") throw new RangeError("body must be a non-empty string");
    const bytes = new TextEncoder().encode(body);
    const sent: SentBody = { body, sha256: await sha256Hex(bytes) };
    const form = new FormData();
    form.append("purpose", "batch");
    form.append("file", new Blob([bytes], { type: "application/jsonl" }), "batch.jsonl");
    const r = await this.#call("POST", "/v1/files", form, (text) => parseFile(JSON.parse(text)), this.#uploadTimeoutMs);
    return { ...r, sent };
  }

  /**
   * 上げたファイルからバッチを作る（依頼）。1つのファイルは1回の作成にだけ使う。
   * 失敗に billingUnknown が付いたら、作られた（＝課金されうる）か分からない。自動で再試行せず、
   * list と findBatchesByInputFile で、そのファイルから作られたバッチがあるかを確かめる。
   * 応答の inputFileId と endpoint が送ったものと違えば、形が合わない（malformed）として billingUnknown を付ける
   * （何かが作られたが、頼んだものか分からない）。
   */
  async create(inputFileId: string, customId?: string): Promise<BatchCreateResult> {
    checkId(inputFileId);
    if (customId !== undefined && !CUSTOM_ID.test(customId)) throw new RangeError("customId must match ^[A-Za-z0-9_-]{1,64}$");
    const metadata = customId === undefined ? {} : { metadata: { custom_id: customId } };
    const body = JSON.stringify({ input_file_id: inputFileId, endpoint: OPENAI_BATCH_ENDPOINT, completion_window: OPENAI_COMPLETION_WINDOW, ...metadata });
    const r = await this.#json("POST", "/v1/batches", body, (json) => {
      const s = parseStatus(json);
      return need(s.inputFileId === inputFileId && s.endpoint === OPENAI_BATCH_ENDPOINT && s.customId === (customId ?? null), s);
    });
    if (!r.ok && uncertainOnCreate(r)) return { ...r, billingUnknown: true };
    return r;
  }

  /** バッチの一覧（新しい順）。作成の失敗に billingUnknown が付いたときの突き合わせに使う */
  async list(options: BatchListOptions = {}): Promise<OpenAIBatchCall<BatchList>> {
    const q = new URLSearchParams();
    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new RangeError("limit must be an integer from 1 to 100");
      q.set("limit", String(options.limit));
    }
    if (options.after !== undefined) {
      checkId(options.after);
      q.set("after", options.after);
    }
    const qs = q.toString();
    return this.#json("GET", `/v1/batches${qs === "" ? "" : `?${qs}`}`, undefined, parseList);
  }

  /** バッチの状態 */
  async retrieve(batchId: string): Promise<OpenAIBatchCall<BatchStatus>> {
    checkId(batchId);
    return this.#json("GET", `/v1/batches/${batchId}`, undefined, parseStatus);
  }

  /** 取り消しを頼む。返る状態はふつう cancelling（最長10分）。cancelled になると、取り消しの前に終わった分の結果は残る */
  async cancel(batchId: string): Promise<OpenAIBatchCall<BatchStatus>> {
    checkId(batchId);
    return this.#json("POST", `/v1/batches/${batchId}/cancel`, undefined, parseStatus);
  }

  /**
   * 結果のファイル（1行1件の JSON）。バッチの outputFileId（成功）と errorFileId（失敗・期限切れ）の両方を読み、
   * つないでから reconcileResults で突き合わせる。形が合わない行は、その行だけ malformed にして、ほかの行は返す。
   */
  async results(fileId: string): Promise<OpenAIBatchCall<BatchItemResult[]>> {
    checkId(fileId);
    return this.#call("GET", `/v1/files/${fileId}/content`, undefined, (text) => {
      const out: BatchItemResult[] = [];
      text.split("\n").forEach((line, i) => {
        if (line.trim() !== "") out.push(parseLine(line, i + 1));
      });
      return out;
    }, this.#resultsTimeoutMs);
  }

  /** ファイルの中身をそのまま返す（find が、上げた本文のハッシュを確かめるのに使う） */
  async fileContent(fileId: string): Promise<OpenAIBatchCall<string>> {
    checkId(fileId);
    return this.#call("GET", `/v1/files/${fileId}/content`, undefined, (text) => text, this.#resultsTimeoutMs);
  }

  #json<T>(method: string, path: string, body: string | undefined, parse: (json: unknown) => T): Promise<OpenAIBatchCall<T>> {
    return this.#call(method, path, body, (text) => parse(JSON.parse(text)), this.#timeoutMs);
  }

  async #call<T>(method: string, path: string, body: string | FormData | undefined, parse: (text: string) => T, timeoutMs: number): Promise<OpenAIBatchCall<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number | undefined;
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${this.#apiKey}` };
      // FormData のときは、fetch が区切りの付いた content-type を付ける
      if (typeof body === "string") headers["content-type"] = "application/json";
      // 転送には従わない（キーの付いた見出しを別の場所へ送らない）
      const res = await this.#fetch(`${this.#baseUrl}${path}`, { method, headers, body, signal: controller.signal, redirect: "error" });
      status = res.status;
      if (!res.ok) {
        // 本文は、公式の一覧にあるエラーの種類と印を取るためだけに読む（エラー文は捨てる）
        return failureOf(res.status, await errorMarks(res));
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
