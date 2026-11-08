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
import type { BatchCall, BatchFailure, SentBody } from "./batch-types";
import type { TokenUsage } from "./cost";
import { geminiTokenUsage } from "./gemini-pricing";

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

/**
 * 1件の結果。succeeded は応答が返ったもの（トークン数があり、課金される）。
 * errored は、その1件の失敗（google.rpc.Code が 0〜16 のときだけ errorCode を持つ。エラー文は持たない）。
 * 失敗した1件が課金されるかは資料に書かれていないので、呼び出し側は maxCost を費用として残す。
 * malformed は、その1件の形が合わなかったもの（index は結果の並びの何番目か。1から）。customId は決まりに合うときだけ持つ。
 */
export type GeminiItemResult =
  | {
      customId: string;
      type: "succeeded";
      output: string;
      respondedModel: string | null;
      finishReason: string | null;
      blockReason: string | null;
      usage: TokenUsage;
    }
  | { customId: string; type: "errored"; errorCode?: number }
  | { type: "malformed"; index: number; customId?: string };

export interface GeminiResults {
  status: GeminiBatchStatus;
  /** 終わる前（pending・running）は空 */
  items: GeminiItemResult[];
}

export interface GeminiListOptions {
  /** 1〜1000 の整数。なければ提供元の既定 */
  pageSize?: number;
  pageToken?: string;
}
/** 一覧の中の、読めなかった項目（埋め込みのバッチ、知らない状態の名前、createTime がない、など）から取り出せた名前だけ */
export interface GeminiUnreadableBatch {
  /** batches/ のあとの部分。決まりに合うときだけ */
  id?: string;
  /** metadata.displayName。決まり（^[A-Za-z0-9_-]{1,128}$）に合うときだけ */
  displayName?: string;
}
/**
 * 一覧の1ページ。
 * 注意：unreadable が空でない、unreachable が 0 でない、または nextPageToken が残っている間は、ある displayName のバッチが
 * 「作られていない」とは決められない（読めない項目や、提供元が読めなかった場所や、まだ読んでいないページに、そのバッチがあるかもしれない）。
 * 作成が billingUnknown で終わったあとの突き合わせには、全ページを読む findGeminiBatchByDisplayName を使う。
 */
export interface GeminiList {
  batches: GeminiBatchStatus[];
  /** 読めなかった項目。ほかの項目は batches に返す */
  unreadable: GeminiUnreadableBatch[];
  /** 提供元が「読めなかった場所」として返した数（応答の unreachable の件数。中身の文は持たない）。0 でなければ、一覧は欠けている */
  unreachable: number;
  nextPageToken: string | null;
}

const CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BATCH_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DISPLAY_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const PAGE_TOKEN = /^[\x21-\x7e]{1,2048}$/;
/** 先頭が 0 でない整数（9桁まで） */
const MAX_TOKENS = /^[1-9][0-9]{0,8}$/;
/** 提供元の列挙の値（大文字と下線だけ）。自由な文は入れない */
const ENUM = /^[A-Z][A-Z_]{0,63}$/;
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
const optEnum = (v: unknown): string | null => (v === undefined || v === null ? null : need(isStr(v) && ENUM.test(v), v as string));
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

/** 1件の結果を読む。形が合わなければ Malformed を投げる */
function parseItem(json: unknown): GeminiItemResult {
  need(isObj(json) && isObj(json.metadata) && isStr(json.metadata.key) && CUSTOM_ID.test(json.metadata.key), null);
  const j = json as Record<string, unknown>;
  const customId = (j.metadata as Record<string, unknown>).key as string;
  if (j.error !== undefined) {
    need(isObj(j.error) && j.response === undefined, null);
    // コード 0 は「成功」の意味なので、失敗の1件としては形が合わない
    need((j.error as Record<string, unknown>).code !== 0, null);
    const errorCode = rpcCode(j.error);
    return errorCode === undefined ? { customId, type: "errored" } : { customId, type: "errored", errorCode };
  }
  need(isObj(j.response), null);
  const r = j.response as Record<string, unknown>;
  const candidates = r.candidates ?? [];
  // 候補は1つまで（候補の数は指定しないので、既定の1つ）
  need(Array.isArray(candidates) && candidates.length <= 1 && isObj(r.usageMetadata), null);
  const u = r.usageMetadata as Record<string, unknown>;
  need(isCount(u.promptTokenCount), null);
  const c = (candidates as unknown[])[0];
  let output = "";
  let finishReason: string | null = null;
  if (c !== undefined) {
    need(isObj(c), null);
    const cand = c as Record<string, unknown>;
    finishReason = optEnum(cand.finishReason);
    const parts = isObj(cand.content) ? cand.content.parts : undefined;
    need(parts === undefined || Array.isArray(parts), null);
    // 出力は text の部分だけをつなぐ（考えた過程の要約（thought: true）などは入れない）
    output = ((parts as unknown[] | undefined) ?? [])
      .filter((p) => isObj(p) && p.thought !== true && p.text !== undefined)
      .map((p) => need(isStr((p as Record<string, unknown>).text), (p as Record<string, unknown>).text as string))
      .join("");
  }
  const feedback = r.promptFeedback;
  need(feedback === undefined || isObj(feedback), null);
  const respondedModel = r.modelVersion === undefined ? null : need(isStr(r.modelVersion), r.modelVersion as string);
  const promptTokens = u.promptTokenCount as number;
  const toolUsePromptTokens = count(u.toolUsePromptTokenCount);
  const candidatesTokens = count(u.candidatesTokenCount);
  const thoughtsTokens = count(u.thoughtsTokenCount);
  // 合計（totalTokenCount）が、入力・候補・考えた過程の足し算より大きいときは、差を出力に足す
  // （資料にない種類のトークンも、高いほうの出力の単価で数える側）
  const total = count(u.totalTokenCount);
  const extra = Math.max(0, total - (promptTokens + toolUsePromptTokens + candidatesTokens + thoughtsTokens));
  return {
    customId,
    type: "succeeded",
    output,
    respondedModel,
    finishReason,
    blockReason: isObj(feedback) ? optEnum(feedback.blockReason) : null,
    usage: geminiTokenUsage({ promptTokens, toolUsePromptTokens, candidatesTokens: candidatesTokens + extra, thoughtsTokens }),
  };
}

/**
 * 結果の並び（inlinedResponses）を探す。資料の中で置き場所の書き方が3通りある：
 * metadata.output（バッチの資料の欄）、response.output（作成の応答の例）、response（使い方の例）。3つとも読む。
 * 2か所以上にあって中身（件数を含む）が食い違えば、どれを信じるか決められないので Malformed（黙って結果を失わない）。
 * どこにもなければ undefined。見つかったのに形が合わなければ Malformed。
 * TODO：本物の API で応答の形を確かめたら、置き場所を1か所に絞る（#179）。
 */
function findInlined(op: Record<string, unknown>): unknown[] | undefined {
  const m = op.metadata as Record<string, unknown>;
  const r = isObj(op.response) ? op.response : undefined;
  const places = [isObj(m.output) ? m.output : undefined, r !== undefined && isObj(r.output) ? r.output : undefined, r];
  const found: unknown[][] = [];
  for (const p of places) {
    if (p === undefined || p.inlinedResponses === undefined) continue;
    const box = p.inlinedResponses;
    need(isObj(box) && (box.inlinedResponses === undefined || Array.isArray(box.inlinedResponses)), null);
    found.push(((box as Record<string, unknown>).inlinedResponses as unknown[] | undefined) ?? []);
  }
  if (found.length === 0) return undefined;
  const first = JSON.stringify(found[0]);
  need(found.every((f) => JSON.stringify(f) === first), null);
  return found[0];
}

function parseResults(json: unknown): GeminiResults {
  const status = parseStatus(json);
  if (!TERMINAL.has(status.state)) return { status, items: [] };
  const list = findInlined(json as Record<string, unknown>);
  // 成功で終わったのに結果がない（ファイルで返った場合を含む。この口はファイルの結果を読まない）
  if (list === undefined) return need(status.state !== "succeeded" || status.counts.requests === 0, { status, items: [] });
  // 成功で終わったなら、結果の件数は依頼の件数と同じはず。違えば黙って結果を失わないよう、形が合わないとする
  // （requestCount が省かれて 0 と読んだときも、結果があれば合わないので形が合わないとする。本物の API で確かめる）
  need(status.state !== "succeeded" || list.length === status.counts.requests, null);
  const items = list.map((it, i): GeminiItemResult => {
    try {
      return parseItem(it);
    } catch {
      const key = isObj(it) && isObj(it.metadata) ? it.metadata.key : undefined;
      return isStr(key) && CUSTOM_ID.test(key) ? { type: "malformed", index: i + 1, customId: key } : { type: "malformed", index: i + 1 };
    }
  });
  return { status, items };
}

/** 読めない項目から、決まりに合う name と metadata.displayName だけを取り出す */
function unreadableOf(op: unknown): GeminiUnreadableBatch {
  if (!isObj(op)) return {};
  const name = op.name;
  const displayName = isObj(op.metadata) ? op.metadata.displayName : undefined;
  return {
    ...(isStr(name) && /^batches\/[A-Za-z0-9_-]{1,128}$/.test(name) ? { id: name.slice("batches/".length) } : {}),
    ...(isStr(displayName) && DISPLAY_NAME.test(displayName) ? { displayName } : {}),
  };
}

/** 一覧の応答の一番上に許す欄（長く続く処理の一覧の形）。ほかの欄があれば、知らない形なので一覧の失敗にする */
const LIST_KEYS: ReadonlySet<string> = new Set(["operations", "nextPageToken", "unreachable"]);

/**
 * 一覧の1ページを読む。operations がなければ項目なし（空の {} を含む）。
 * 一番上に知らない欄がある、unreachable が並びでない、nextPageToken がこちらから送り返せない形（PAGE_TOKEN に合わない）なら、
 * 形が合わないとする（一覧の失敗。「項目なし」と読み違えて、作られていないと決めないように）
 */
function parseList(json: unknown): GeminiList {
  need(isObj(json) && Object.keys(json).every((k) => LIST_KEYS.has(k)), null);
  const j = json as Record<string, unknown>;
  need(j.operations === undefined || j.operations === null || Array.isArray(j.operations), null);
  need(j.unreachable === undefined || j.unreachable === null || Array.isArray(j.unreachable), null);
  const token = j.nextPageToken;
  need(token === undefined || token === null || token === "" || (isStr(token) && PAGE_TOKEN.test(token)), null);
  const batches: GeminiBatchStatus[] = [];
  const unreadable: GeminiUnreadableBatch[] = [];
  for (const op of (j.operations as unknown[] | undefined) ?? []) {
    try {
      batches.push(parseStatus(op));
    } catch {
      unreadable.push(unreadableOf(op));
    }
  }
  const unreachable = ((j.unreachable as unknown[] | undefined | null) ?? []).length;
  return { batches, unreadable, unreachable, nextPageToken: isStr(token) && token !== "" ? token : null };
}

export interface ReconciledGeminiResults {
  /** 依頼した customId ごとの結果（1回だけ出て、形が合ったもの） */
  matched: Map<string, Exclude<GeminiItemResult, { type: "malformed" }>>;
  /** 依頼したのに結果がない customId（形が合わない1件だけのものを含む） */
  missing: string[];
  /** 結果に2回以上出た customId（形が合わない1件も数える）。どれを信じるか決められないので matched に入れない */
  duplicated: string[];
  /** 依頼にない customId の結果の数 */
  unexpected: number;
  /** 形が合わなかった1件の数 */
  malformed: number;
}

/**
 * 依頼した customId と結果を突き合わせる。資料では結果は依頼の順だが、並びは信じず customId で突き合わせる。
 * 重なり・依頼にない ID・形が合わない1件は、信じずに数だけ返す（呼び出し側は missing と duplicated を maxCost のまま残す）。
 */
export function reconcileGeminiResults(requested: readonly string[], items: readonly GeminiItemResult[]): ReconciledGeminiResults {
  const wanted = new Set(requested);
  if (wanted.size !== requested.length) throw new RangeError("requested customIds must be unique");
  const seen = new Map<string, GeminiItemResult[]>();
  let unexpected = 0;
  let malformed = 0;
  for (const it of items) {
    if (it.type === "malformed") malformed += 1;
    const id = it.customId;
    if (id === undefined) continue;
    if (!wanted.has(id)) {
      if (it.type !== "malformed") unexpected += 1;
      continue;
    }
    seen.set(id, [...(seen.get(id) ?? []), it]);
  }
  const matched = new Map<string, Exclude<GeminiItemResult, { type: "malformed" }>>();
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

/**
 * 作成で送る本文。1件ごとの中身は model と messages から toGeminiRequest で作る。create はこれと同じ文字列を送る
 * （ハッシュを先に出すために公開する）。決まりに合わなければ RangeError
 */
export function geminiBatchBody(model: LlmModel, displayName: string, items: readonly GeminiBatchRequestItem[]): string {
  if (!isObj(model) || model.provider !== GEMINI_PROVIDER) throw new RangeError(`model.provider must be "${GEMINI_PROVIDER}"`);
  const modelId = model.modelId;
  if (!isStr(modelId) || !MODEL_ID.test(modelId)) throw new RangeError("invalid model id");
  if (!isStr(displayName) || !DISPLAY_NAME.test(displayName)) throw new RangeError("displayName must match ^[A-Za-z0-9_-]{1,128}$");
  if (!Array.isArray(items) || items.length === 0) throw new RangeError("no requests");
  const ids = new Set<string>();
  for (const it of items) {
    if (!isObj(it) || !isStr(it.customId) || !CUSTOM_ID.test(it.customId) || ids.has(it.customId)) throw new RangeError("customId must be unique and match ^[A-Za-z0-9_-]{1,64}$");
    ids.add(it.customId);
  }
  const requests = items.map((it) => ({ request: toGeminiRequest(model, it.messages), metadata: { key: it.customId } }));
  const body = JSON.stringify({ batch: { model: `models/${modelId}`, displayName, inputConfig: { requests: { requests } } } });
  if (new TextEncoder().encode(body).length >= GEMINI_MAX_BODY_BYTES) throw new RangeError("request body is too large for an inline batch");
  return body;
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
    const body = geminiBatchBody(model, displayName, items);
    const sent: SentBody = { body, sha256: await sha256Hex(new TextEncoder().encode(body)) };
    // 応答のモデルと名前が送ったものと違えば、何かが作られたが頼んだものか分からないので、形が合わない（billingUnknown）とする
    const r = await this.#call("POST", `/${GEMINI_API_VERSION}/models/${model.modelId}:batchGenerateContent`, body, (json) => {
      const s = parseStatus(json);
      return need(s.model === `models/${model.modelId}` && s.displayName === displayName, s);
    }, this.#timeoutMs);
    if (!r.ok && uncertainOnCreate(r)) return { ...r, billingUnknown: true, sent };
    return { ...r, sent };
  }

  /** バッチの一覧。作成の失敗に billingUnknown が付いたときの突き合わせ（displayName）に使う */
  async list(options: GeminiListOptions = {}): Promise<BatchCall<GeminiList>> {
    const q = new URLSearchParams();
    if (options.pageSize !== undefined) {
      if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1000) throw new RangeError("pageSize must be an integer from 1 to 1000");
      q.set("pageSize", String(options.pageSize));
    }
    if (options.pageToken !== undefined) {
      if (!PAGE_TOKEN.test(options.pageToken)) throw new RangeError("invalid pageToken");
      q.set("pageToken", options.pageToken);
    }
    const qs = q.toString();
    return this.#call("GET", `/${GEMINI_API_VERSION}/batches${qs === "" ? "" : `?${qs}`}`, undefined, parseList, this.#timeoutMs);
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

  /**
   * 状態と結果（作成のときの inline の依頼の結果）。終わる前は items が空。
   * 1件の形が合わないときは、その1件だけ malformed にして、ほかの1件は返す。reconcileGeminiResults で突き合わせる。
   */
  async results(batchId: string): Promise<BatchCall<GeminiResults>> {
    checkBatchId(batchId);
    return this.#call("GET", `/${GEMINI_API_VERSION}/batches/${batchId}`, undefined, parseResults, this.#resultsTimeoutMs);
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

/**
 * 作成が billingUnknown で終わったあとの突き合わせの結果。
 * - found：その displayName のバッチが1つだけあり、読めた
 * - foundUnreadable：その displayName の項目が1つだけあるが、形が読めない（id は読めたときだけ）。作られたものとして扱う
 *   どちらも、displayName の読めない項目があれば maybeDuplicated が true（同じ名前の2つ目かもしれない）
 * - duplicated：その displayName の項目が2つ以上ある（二重に作られた）。ids は読めたものだけ
 * - notFound：作成を頼んでから GEMINI_CREATE_SETTLE_MS より長くたっていて、全ページを読み、
 *   提供元が読めなかった場所もなく、読めない項目もすべて別の displayName だった。このときだけ、作られていないと決めてよい
 * - unknown：作られていないと決められない。理由は次のどれか
 *   list_failed（一覧の失敗。形が合わない応答や、送り返せないページの印を含む）、unreadable（displayName の読めない項目がある）、
 *   unreachable（提供元が一部を読めなかった）、too_many_pages（ページが多すぎる・同じページが繰り返された）、
 *   too_soon（作成を頼んでから GEMINI_CREATE_SETTLE_MS がたっていない。あとで作られるかもしれないので、時間をおいて探し直す）
 */
export type GeminiBatchLookup =
  | { kind: "found"; batch: GeminiBatchStatus; maybeDuplicated: boolean }
  | { kind: "foundUnreadable"; id?: string; maybeDuplicated: boolean }
  | { kind: "duplicated"; ids: string[] }
  | { kind: "notFound" }
  | { kind: "unknown"; reason: "list_failed" | "unreadable" | "unreachable" | "too_many_pages" | "too_soon" };

/** 一覧の最大ページ数（1ページ 1,000 件）。超えたら unknown */
export const GEMINI_LOOKUP_MAX_PAGES = 100;

/**
 * 作成を頼んでから、「その名前のバッチはない」と決めてよくなるまでの時間（1時間）。
 * 作成がこちらの待ち時間切れや通信断で終わっても、提供元では処理が続き、あとからバッチが作られることがある。
 * その前に一覧を読むと「ない」に見えるので、この時間がたつまでは notFound を返さない。
 * 根拠：資料（https://ai.google.dev/api/batch-mode 、2026-11-07 確認）には、作成の処理が提供元でどれだけ続きうるかの上限が書かれていない。
 * そこで、この口の作成の待ち時間の既定（30秒）より百倍以上長く、一覧への反映の遅れ（これも資料にない）も含めて余裕のある値にした。
 * 待つ側の損は「作り直しが遅れる」だけで、二重課金よりずっと小さい。本物の API で確かめるまでは、短くしない。
 * 呼び出し側が create の timeoutMs をこの値に近い長さにするなら、この値も長くすること。
 */
export const GEMINI_CREATE_SETTLE_MS = 60 * 60 * 1000;

/** 突き合わせに渡す時刻（どちらも UNIX ミリ秒） */
export interface GeminiLookupTiming {
  /** 作成を頼んだ時刻（create を呼ぶ直前に、呼び出し側が自分の時計で取ったもの） */
  requestedAt: number;
  /** 今の時刻（呼び出し側の時計） */
  now: number;
}

/**
 * displayName で、作られたバッチを探す。一覧を全ページ読む（途中で止めない）。
 * 読めない項目は、displayName が読めて別の名前なら無関係として外し、displayName が読めなければ unknown にする
 * （その項目が探しているバッチかもしれないので、「作られていない」と決めない。二重課金を避ける）。
 * 作成を頼んでから GEMINI_CREATE_SETTLE_MS がたっていなければ、見つからなくても notFound ではなく unknown（too_soon）を返す
 * （時計が戻って now が requestedAt より前のときも同じ）。見つかったときは、時間に関係なくそのまま返す。
 */
export async function findGeminiBatchByDisplayName(
  client: Pick<GeminiBatchClient, "list">,
  displayName: string,
  timing: GeminiLookupTiming,
  maxPages: number = GEMINI_LOOKUP_MAX_PAGES,
): Promise<GeminiBatchLookup> {
  if (!DISPLAY_NAME.test(displayName)) throw new RangeError("displayName must match ^[A-Za-z0-9_-]{1,128}$");
  if (!isObj(timing) || !Number.isFinite(timing.requestedAt) || !Number.isFinite(timing.now)) throw new RangeError("timing.requestedAt and timing.now must be finite numbers");
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new RangeError("maxPages must be a positive integer");
  const readable: GeminiBatchStatus[] = [];
  const unreadable: GeminiUnreadableBatch[] = [];
  let nameless = false;
  const tokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= maxPages) return { kind: "unknown", reason: "too_many_pages" };
    const r = await client.list({ pageSize: 1000, ...(pageToken === undefined ? {} : { pageToken }) });
    if (!r.ok) return { kind: "unknown", reason: "list_failed" };
    // 提供元が一部を読めなかったなら、そこに探しているバッチがあるかもしれない
    if (r.value.unreachable !== 0) return { kind: "unknown", reason: "unreachable" };
    readable.push(...r.value.batches.filter((b) => b.displayName === displayName));
    for (const u of r.value.unreadable) {
      if (u.displayName === undefined) nameless = true;
      else if (u.displayName === displayName) unreadable.push(u);
    }
    const next = r.value.nextPageToken;
    if (next === null) break;
    if (tokens.has(next)) return { kind: "unknown", reason: "too_many_pages" };
    tokens.add(next);
    pageToken = next;
  }
  const total = readable.length + unreadable.length;
  if (total > 1) return { kind: "duplicated", ids: [...readable.map((b) => b.id), ...unreadable.flatMap((u) => (u.id === undefined ? [] : [u.id]))] };
  if (readable.length === 1) return { kind: "found", batch: readable[0]!, maybeDuplicated: nameless };
  if (unreadable.length === 1) return { kind: "foundUnreadable", ...(unreadable[0]!.id === undefined ? {} : { id: unreadable[0]!.id }), maybeDuplicated: nameless };
  if (nameless) return { kind: "unknown", reason: "unreadable" };
  // 時計が戻ったとき（差が負）も、待ち時間がたっていないとみなす
  if (!(timing.now - timing.requestedAt > GEMINI_CREATE_SETTLE_MS)) return { kind: "unknown", reason: "too_soon" };
  return { kind: "notFound" };
}

