// Gemini API のバッチ（Batch API。まとめて依頼し、あとで受け取る口。料金は標準の半額）を fetch で呼ぶ部分（#179）。
// 作成・一覧・状態・結果・取り消しだけ。費用の上限の予約と LlmPort は、契約が決まってから上に置く（#179）。
// - Vertex AI ではなく Gemini API（API キーで使う口。generativelanguage.googleapis.com）を使う。
//   Vertex AI はクラウドのプロジェクトとサービスアカウントの準備が要り、Anthropic の分と同じ「API キー1つ」の形にならないため
// - API キーは環境変数から読むだけ（geminiApiKeyFromEnv）。URL のクエリには入れず、x-goog-api-key の見出しで送る。
//   返す値・エラー文・ログに書かない
// - 提供元のエラー文（message・details）と例外の文は返す値に入れない。HTTP の状態コードと、決まった印・数だけを返す
// - 依存は足さない（Node の fetch を使う）
// 出典（どれも 2026-11-07 確認）：
// - バッチの使い方：https://ai.google.dev/gemini-api/docs/batch-mode
// - バッチの API の形：https://ai.google.dev/api/batch-mode
// - API の版（v1 は安定版）：https://ai.google.dev/gemini-api/docs/api-versions
// - モデルの一覧：https://ai.google.dev/gemini-api/docs/models
import type { LlmMessage, LlmModel } from "../contracts";
import { sha256Hex } from "../events/hash";
import type { BatchCall, BatchFailure, SentBody } from "./anthropic-batch";

/**
 * 使うモデル：Gemini 3.8 Flash（安定版。バッチに対応）。Flash は Google のモデルの中くらいの性能・価格の帯
 * （上に Gemini 4 Argon と Gemini 3.1 Pro（試用版）、下に Flash-Lite）。
 * 出典：https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash （2026-11-07 確認）
 */
export const GEMINI_MODEL_ID = "gemini-3.8-flash";
/** v1（安定版）。資料の例は v1beta だが、バッチの API は v1 にもあり、v1 は壊れる変更を新しい版でしか入れない */
export const GEMINI_API_VERSION = "v1";
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
/** 1回の作成で送れる本文の大きさの上限（このバイト数「未満」だけを送る）。資料の「20MB 未満」を、小さいほうの 20,000,000 バイトで読む */
export const GEMINI_MAX_BODY_BYTES = 20_000_000;
/** LlmModel.provider のうち、この口が受け付ける値 */
export const GEMINI_PROVIDER = "google";

/** 見出しに入れられる文字（表示できる ASCII で空白なし）だけの API キー */
const API_KEY = /^[\x21-\x7e]{1,512}$/;

/** 環境変数から API キーを読む。ない・見出しに使えない文字があるときは Error（キーの値は文に入れない） */
export function geminiApiKeyFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const key = env[GEMINI_API_KEY_ENV];
  if (!key) throw new Error(`${GEMINI_API_KEY_ENV} is not set`);
  if (!API_KEY.test(key)) throw new Error(`${GEMINI_API_KEY_ENV} has characters not allowed in a header`);
  return key;
}

export type ThinkingLevel = "LOW" | "MEDIUM" | "HIGH";
/** generateContent の1件の中身。settings と messages から作り、ほかは足さない（ツールなし。EVENT_LOG §3.2） */
export interface GeminiRequest {
  systemInstruction?: { parts: [{ text: string }] };
  contents: { role: "user" | "model"; parts: [{ text: string }] }[];
  generationConfig: { maxOutputTokens: number; thinkingConfig?: { thinkingLevel: ThinkingLevel } };
}
/**
 * バッチの中の1件。送る中身は create が、渡された LlmModel とこの messages から toGeminiRequest で作る
 * （記録するモデル・設定と、実際に送るモデル・設定が食い違わないように、組み立て済みの中身は受け取らない）
 */
export interface GeminiBatchRequestItem {
  /** バッチの中の1件のID（metadata.key で送り、結果にも返る）。英数字・ハイフン・下線で1〜64文字 */
  customId: string;
  messages: readonly LlmMessage[];
}

export type GeminiBatchState = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
const TERMINAL: ReadonlySet<GeminiBatchState> = new Set(["succeeded", "failed", "cancelled", "expired"]);

/** バッチの情報。customId は入らない（提供元の応答にないため）。displayName は作成のときに付けた名前 */
export interface GeminiBatchStatus {
  /** batches/ のあとの部分 */
  id: string;
  state: GeminiBatchState;
  done: boolean;
  model: string;
  displayName: string;
  counts: { requests: number; succeeded: number; failed: number; pending: number };
  createdAt: number;
  updatedAt: number | null;
  endedAt: number | null;
  /** バッチ全体が失敗したときの google.rpc.Code（0〜16 のときだけ）。エラー文は持たない */
  errorCode?: number;
}

/** 作成の結果。成功でも失敗でも、送った本文を一緒に返す（監査と、課金が分からない失敗の突き合わせに使う） */
export type GeminiCreateResult = BatchCall<GeminiBatchStatus> & { sent: SentBody };

const CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BATCH_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DISPLAY_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
/** 先頭が 0 でない整数（9桁まで） */
const MAX_TOKENS = /^[1-9][0-9]{0,8}$/;
/** int64 を文字列で返す欄（"0" か、先頭が 0 でない15桁まで） */
const INT64_STR = /^(0|[1-9][0-9]{0,14})$/;
const THINKING: Readonly<Record<string, ThinkingLevel>> = Object.freeze({ low: "LOW", medium: "MEDIUM", high: "HIGH" });

/**
 * LlmModel と messages から、送る中身を作る。settings は max_tokens（必須。考えた過程を含む出力の上限）と
 * thinking_level（"low"・"medium"・"high"。Gemini 3.8 Flash は "minimal" を受け付けない）だけを許す。
 * temperature は Gemini 3.6 Flash 以降では黙って無視されるので、送らずに断る（記録と実際が食い違わないように）。
 * system は先頭の1件だけ許し、systemInstruction に移す。assistant は Gemini の名前の model にする。内容は変えない。
 * 決まりに合わなければ RangeError。
 * 注意：system の移動・役の名前の置き換え・数値の文字列から数への変換は、契約（LlmRequest.messages の
 * 「加工せずそのまま送る」）と食い違いうる。Anthropic の分と同じく lead の判断待ち（#179）。実際に送った本文とハッシュは create が返す。
 */
export function toGeminiRequest(model: LlmModel, messages: readonly LlmMessage[]): GeminiRequest {
  // 型をすり抜けた値（文字列でないモデル名・内容、知らない役）を送らない
  if (!isObj(model) || model.provider !== GEMINI_PROVIDER) throw new RangeError(`model.provider must be "${GEMINI_PROVIDER}"`);
  if (!isStr(model.modelId) || !MODEL_ID.test(model.modelId)) throw new RangeError("invalid model id");
  if (!isObj(model.settings)) throw new RangeError("model.settings must be an object");
  if (!Array.isArray(messages)) throw new RangeError("messages must be an array");
  for (const m of messages as unknown[]) {
    if (!isObj(m) || !isStr(m.content) || (m.role !== "system" && m.role !== "user" && m.role !== "assistant")) throw new RangeError("invalid message");
  }
  const unknown = Object.keys(model.settings).filter((k) => k !== "max_tokens" && k !== "thinking_level");
  if (unknown.length > 0) throw new RangeError(`unsupported settings: ${unknown.join(",")}`);
  const maxTokens = model.settings.max_tokens;
  if (maxTokens === undefined || !MAX_TOKENS.test(maxTokens)) throw new RangeError("settings.max_tokens must be an integer without a leading zero");
  const level = model.settings.thinking_level;
  if (level !== undefined && !Object.hasOwn(THINKING, level)) throw new RangeError('settings.thinking_level must be "low", "medium" or "high"');
  const [first, ...rest] = messages;
  const system = first?.role === "system" ? first.content : undefined;
  const body = system === undefined ? messages : rest;
  if (body.length === 0 || body[0]!.role !== "user") throw new RangeError("messages must start with a user message");
  const contents = body.map((m) => {
    if (m.role === "system") throw new RangeError("system message must be the first one");
    return { role: m.role === "assistant" ? ("model" as const) : ("user" as const), parts: [{ text: m.content }] as [{ text: string }] };
  });
  return {
    ...(system === undefined ? {} : { systemInstruction: { parts: [{ text: system }] as [{ text: string }] } }),
    contents,
    generationConfig: {
      maxOutputTokens: Number(maxTokens),
      ...(level === undefined ? {} : { thinkingConfig: { thinkingLevel: THINKING[level]! } }),
    },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string";
/** 応答の本文が空だったことの印（JSON の値と区別する） */
const EMPTY_BODY: unique symbol = Symbol("empty body");

/** 形が合わないとき。呼び出し元で provider_error（malformed）に直す */
class Malformed extends Error {}
const need = <T>(ok: boolean, v: T): T => {
  if (!ok) throw new Malformed();
  return v;
};
const time = (v: unknown): number => need(isStr(v) && Number.isFinite(Date.parse(v)), Date.parse(v as string));
const optTime = (v: unknown): number | null => (v === undefined || v === null ? null : time(v));
/** 数か int64 の文字列。ない欄は 0（提供元は 0 の欄を省く） */
const count = (v: unknown): number => {
  if (v === undefined || v === null) return 0;
  if (isCount(v)) return v;
  return need(isStr(v) && INT64_STR.test(v), Number(v));
};
/** google.rpc.Code（0〜16）のときだけ返す */
const rpcCode = (v: unknown): number | undefined => (isObj(v) && isCount(v.code) && v.code <= 16 ? v.code : undefined);

/**
 * 状態の名前。REST の資料は BATCH_STATE_*。資料の使い方の例（シェル）は JOB_STATE_* を見ているので、どちらも読む。
 * BATCH_STATE_UNSPECIFIED とそれ以外は形が合わないとする
 */
const STATES: Readonly<Record<string, GeminiBatchState>> = Object.freeze({
  BATCH_STATE_PENDING: "pending",
  BATCH_STATE_RUNNING: "running",
  BATCH_STATE_SUCCEEDED: "succeeded",
  BATCH_STATE_FAILED: "failed",
  BATCH_STATE_CANCELLED: "cancelled",
  BATCH_STATE_EXPIRED: "expired",
  JOB_STATE_PENDING: "pending",
  JOB_STATE_RUNNING: "running",
  JOB_STATE_SUCCEEDED: "succeeded",
  JOB_STATE_FAILED: "failed",
  JOB_STATE_CANCELLED: "cancelled",
  JOB_STATE_EXPIRED: "expired",
});

/** 長く続く処理（Operation）の形の応答から、バッチの情報を読む */
function parseStatus(json: unknown): GeminiBatchStatus {
  need(isObj(json) && isStr(json.name) && isObj(json.metadata), null);
  const op = json as Record<string, unknown>;
  const m = need(/^batches\/[A-Za-z0-9_-]{1,128}$/.test(op.name as string), op.metadata as Record<string, unknown>);
  const type = m["@type"];
  need(type === undefined || (isStr(type) && type.endsWith(".GenerateContentBatch")), null);
  need(isStr(m.state) && Object.hasOwn(STATES, m.state) && isStr(m.model) && isStr(m.displayName), null);
  need(op.done === undefined || typeof op.done === "boolean", null);
  const state = STATES[m.state as string]!;
  // done（長く続く処理が終わったか）と状態が食い違えば、どちらを信じるか決められない。done は false のとき省かれうる
  need((op.done === true) === TERMINAL.has(state), null);
  const stats = m.batchStats ?? {};
  need(isObj(stats), null);
  const s = stats as Record<string, unknown>;
  const errorCode = rpcCode(op.error);
  return {
    id: (op.name as string).slice("batches/".length),
    state,
    done: op.done === true,
    model: m.model as string,
    displayName: m.displayName as string,
    counts: { requests: count(s.requestCount), succeeded: count(s.successfulRequestCount), failed: count(s.failedRequestCount), pending: count(s.pendingRequestCount) },
    createdAt: time(m.createTime),
    updatedAt: optTime(m.updateTime),
    endedAt: optTime(m.endTime),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function failureOf(status: number): BatchFailure {
  // 503 は混雑のことが多いので、429 と同じく rate_limited（Anthropic の 529、OpenAI の 503 とそろえる）
  if (status === 429 || status === 503) return { ok: false, errorCode: "rate_limited", reason: "http", status };
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

/** https: だけ。認証情報・クエリ・断片（空の ? や # を含む）は断る。解析した origin と path から作り直す */
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

export interface GeminiBatchClientOptions {
  apiKey: string;
  /** 試験で差し替える。既定は Node の fetch（包んで呼ぶ） */
  fetch?: typeof fetch;
  /** https: だけ。末尾の / は取る。試験では baseUrl ではなく fetch を差し替える */
  baseUrl?: string;
  /** 1回の HTTP の呼び出し（本文を読み終えるまで）の待ち時間の上限（ミリ秒）。超えたら timeout */
  timeoutMs?: number;
  /**
   * 状態と結果の取り出し（retrieve・results）の待ち時間の上限。終わったバッチは状態の取得でも結果の全文が返り、
   * 大きくなりうるので、ほかより長い既定にする
   */
  resultsTimeoutMs?: number;
}

/** Gemini API のバッチの呼び出し。どれも reject せず BatchCall を返す（引数の誤りだけ RangeError で reject） */
export class GeminiBatchClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #resultsTimeoutMs: number;

  constructor(options: GeminiBatchClientOptions) {
    if (!options.apiKey) throw new RangeError("apiKey is empty");
    if (!API_KEY.test(options.apiKey)) throw new RangeError("apiKey has characters not allowed in a header");
    this.#apiKey = options.apiKey;
    // 既定の fetch は包んで呼ぶ（this を失った呼び出しにしない）
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#baseUrl = checkBaseUrl(options.baseUrl ?? GEMINI_BASE_URL);
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#resultsTimeoutMs = options.resultsTimeoutMs ?? 120_000;
  }

  /**
   * バッチを作る（依頼）。customId は重ならないこと。送った本文とそのハッシュを、結果と一緒に返す。
   * 送るモデルと設定は、渡された model（記録する LlmModel）だけから決める（provider は "google" に限る）。
   * 各1件の中身も model と messages から toGeminiRequest で作るので、記録と実際に送るものが食い違わない。
   * displayName は、この依頼だけの名前にする（例：依頼の本文のハッシュから作る）。作成は同じ依頼を2回送ると2つ作られる（資料）。
   * 失敗に billingUnknown が付いたら、作られたか分からない。自動で再試行せず、findGeminiBatchByDisplayName で突き合わせる
   * （作成を頼んだ時刻を残しておき、それを渡す。時間がたつまでは「ない」と決めない）。
   * 費用の換算に使う「作った時刻」は、提供元の status.createdAt。それがない（失敗した）ときは、
   * create を呼ぶ直前に呼び出し側が自分の時計で取った時刻を使う（gemini-pricing.ts の geminiBatchPrice）。
   */
  async create(model: LlmModel, displayName: string, items: readonly GeminiBatchRequestItem[]): Promise<GeminiCreateResult> {
    if (!isObj(model) || model.provider !== GEMINI_PROVIDER) throw new RangeError(`model.provider must be "${GEMINI_PROVIDER}"`);
    const modelId = model.modelId;
    if (!isStr(modelId) || !MODEL_ID.test(modelId)) throw new RangeError("invalid model id");
    if (!DISPLAY_NAME.test(displayName)) throw new RangeError("displayName must match ^[A-Za-z0-9_-]{1,128}$");
    if (items.length === 0) throw new RangeError("no requests");
    const ids = new Set<string>();
    for (const it of items) {
      if (!CUSTOM_ID.test(it.customId) || ids.has(it.customId)) throw new RangeError("customId must be unique and match ^[A-Za-z0-9_-]{1,64}$");
      ids.add(it.customId);
    }
    const requests = items.map((it) => ({ request: toGeminiRequest(model, it.messages), metadata: { key: it.customId } }));
    const body = JSON.stringify({ batch: { model: `models/${modelId}`, displayName, inputConfig: { requests: { requests } } } });
    const bytes = new TextEncoder().encode(body);
    if (bytes.length >= GEMINI_MAX_BODY_BYTES) throw new RangeError("request body is too large for an inline batch");
    const sent: SentBody = { body, sha256: await sha256Hex(bytes) };
    const r = await this.#call("POST", `/${GEMINI_API_VERSION}/models/${modelId}:batchGenerateContent`, body, parseStatus, this.#timeoutMs);
    if (!r.ok && uncertainOnCreate(r)) return { ...r, billingUnknown: true, sent };
    return { ...r, sent };
  }

  /** バッチの状態 */
  async retrieve(batchId: string): Promise<BatchCall<GeminiBatchStatus>> {
    checkBatchId(batchId);
    return this.#call("GET", `/${GEMINI_API_VERSION}/batches/${batchId}`, undefined, parseStatus, this.#resultsTimeoutMs);
  }

  /**
   * 取り消しを頼む。応答は空（本文なし、または {}）なので、状態は retrieve で確かめる（終わると cancelled）。
   * 取り消しの前に処理した分の結果は残りうる（results で受け取り、課金されたものとして扱う）
   */
  async cancel(batchId: string): Promise<BatchCall<null>> {
    checkBatchId(batchId);
    return this.#call("POST", `/${GEMINI_API_VERSION}/batches/${batchId}:cancel`, undefined, (json) => need(json === EMPTY_BODY || isObj(json), null), this.#timeoutMs);
  }

  async #call<T>(method: string, path: string, body: string | undefined, parse: (json: unknown) => T, timeoutMs: number): Promise<BatchCall<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number | undefined;
    try {
      const headers: Record<string, string> = { "x-goog-api-key": this.#apiKey };
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
        // 本文が空なら EMPTY_BODY を渡す（受け付けるかは parse が決める。取り消しだけが受け付ける）
        return { ok: true, value: parse(text === "" ? EMPTY_BODY : JSON.parse(text)) };
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
