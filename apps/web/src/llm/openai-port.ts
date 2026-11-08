// OpenAI の Batch API で、バッチの口（契約 LlmBatchPort）を作る（#179）。
// 送る形：messages は役割と本文をそのまま Responses API の input に入れ、settings は max_tokens（max_output_tokens）と
// reasoning_effort だけ（temperature は送らない）。形への直し方は toOpenAIParams、上げるファイルの中身は openaiBatchFileBody。
// 送った本文のハッシュは、上げたファイルの中身のハッシュ（契約）。名前（customId）はバッチの metadata の custom_id に付け、find で探す。
import type { LlmBatchPrice } from "../contracts";
import { sha256Hex } from "../events/hash";
import { BATCH_MAX_INPUT_TOKENS, BatchPort, type BatchDriver, type BatchOutcome, type BatchPortOptions } from "./batch-port";
import { OpenAIBatchClient, openaiApiKeyFromEnv, openaiBatchFileBody, reconcileResults, toOpenAIParams, type BatchItemResult, type BatchStatus } from "./openai-batch";
import { openaiBatchPrice } from "./openai-pricing";

export const OPENAI_PROVIDER = "openai";
/** find が読む一覧のページ数の上限（1ページ100件）。超えたら決められない（unknown） */
const LOOKUP_MAX_PAGES = 20;
/** 送る出力の上限（推論のトークンを含む。#179 の lead の決定2：考える分も出力として数えるので多めにする） */
export const OPENAI_MAX_OUTPUT_TOKENS = 16_000;
/**
 * 入力の1トークンに掛かる倍率の最大。キャッシュへの書き込み（請求は最大で入力の2.5倍）を、入力の欄（1倍）と書き込みの欄（2倍）の
 * 両方に入れて3倍で数える（openai-batch.ts の toTokenUsage）。予約は入力をこの倍率で数える（入力の上限×3×入力の単価＋出力の上限×出力の単価。
 * #179 の lead の答え）。送る本文の上限は、ほかの2社と同じ BATCH_MAX_INPUT_TOKENS バイト
 */
export const OPENAI_INPUT_COST_FACTOR = 3;

/**
 * 予約の料金。入力が上限（BATCH_MAX_INPUT_TOKENS）のときの料金を、1,000万トークンあたりのセントに直す。時刻では変わらない。
 * 入力は 20,000 トークンを超えないので、長い文脈の料金（入力が272,000トークンを超えるとき）にはならず、短い文脈の料金になる。
 * 閉じたときも同じ料金で数え、実際の請求の単価と同じになる
 */
export function openaiReservePrice(modelId: string): LlmBatchPrice | undefined {
  const p = openaiBatchPrice(modelId, { inputTokens: BATCH_MAX_INPUT_TOKENS });
  return p && { inputCentsPer10MTok: p.inputCentsPerMTok * 10, outputCentsPer10MTok: p.outputCentsPerMTok * 10 };
}

type Client = Pick<OpenAIBatchClient, "uploadBody" | "create" | "retrieve" | "results" | "cancel" | "list" | "fileContent">;
const UNKNOWN: BatchOutcome = { kind: "costUnknown", result: "failed", errorCode: "provider_error" };

export function openaiBatchDriver(client: Client): BatchDriver {
  return {
    provider: OPENAI_PROVIDER,
    settingKeys: ["max_tokens", "reasoning_effort"],
    maxOutputTokens: OPENAI_MAX_OUTPUT_TOKENS,
    inputCostFactor: OPENAI_INPUT_COST_FACTOR,
    priceAt: (modelId) => openaiReservePrice(modelId),
    body: (r, itemId) => openaiBatchFileBody([{ customId: itemId, params: toOpenAIParams(r.model, r.messages) }]),
    async send(body, _r, customId) {
      // ファイルの上げは課金されず、上げに失敗したらバッチを作る依頼を出さないので、バッチは作られていない
      const up = await client.uploadBody(body);
      if (!up.ok) return { ok: false, errorCode: up.errorCode, notCreated: true };
      // 名前（customId）をバッチの metadata に付ける（find で探す）
      const c = await client.create(up.value.id, customId);
      if (c.ok) return { ok: true, batchId: c.value.id };
      return c.billingUnknown ? { ok: false, errorCode: c.errorCode, billingUnknown: true } : { ok: false, errorCode: c.errorCode, notCreated: true };
    },
    /**
     * 一覧（新しい順）から、作成時刻が from〜to で名前（metadata の custom_id）が customId のバッチを探す。ちょうど1つなら、上げたファイルの
     * 中身を取り出してハッシュを比べ、同じなら found。2つ以上・違うハッシュ・ファイルを取り出せない（4xx）なら not_found。
     * 一覧かファイルが読めない（通信の失敗・5xx など）なら unknown。作った時刻（created_at）は秒なので、from は秒に切り下げて比べる
     */
    async find({ reservation: r, from, to }) {
      const since = Math.floor(from / 1000) * 1000;
      const hits: BatchStatus[] = [];
      let after: string | undefined;
      for (let page = 0; page < LOOKUP_MAX_PAGES; page += 1) {
        const l = await client.list({ limit: 100, ...(after === undefined ? {} : { after }) });
        if (!l.ok) return { status: "unknown" };
        hits.push(...l.value.data.filter((b) => b.createdAt >= since && b.createdAt <= to && b.customId === r.customId));
        const oldest = l.value.data.at(-1);
        if (!l.value.hasMore || l.value.lastId === null || (oldest !== undefined && oldest.createdAt < since)) {
          if (hits.length !== 1) return { status: "not_found" };
          const f = await client.fileContent(hits[0]!.inputFileId);
          if (!f.ok) return f.status !== undefined && f.status >= 400 && f.status < 500 ? { status: "not_found" } : { status: "unknown" };
          return (await sha256Hex(new TextEncoder().encode(f.value))) === r.sentBodyHash ? { status: "found", batchId: hits[0]!.id } : { status: "not_found" };
        }
        after = l.value.lastId;
      }
      return { status: "unknown" };
    },
    async outcome(t, itemId) {
      const s = await client.retrieve(t.batchId);
      if (!s.ok) return "pending";
      const b = s.value;
      if (b.status === "validating" || b.status === "in_progress" || b.status === "finalizing" || b.status === "cancelling") return "pending";
      // failed は依頼のファイルの検証で断られたもの。課金されないはずだが、資料に明記がないので分からないとする
      if (b.status === "failed") return UNKNOWN;
      const items: BatchItemResult[] = [];
      for (const fileId of [b.outputFileId, b.errorFileId]) {
        if (fileId === null) continue;
        const res = await client.results(fileId);
        if (!res.ok) return "pending";
        items.push(...res.value);
      }
      const it = reconcileResults([itemId], items).matched.get(itemId);
      if (it === undefined) return UNKNOWN;
      if (it.type === "succeeded") return { kind: "succeeded", output: it.output, respondedModel: it.respondedModel, usage: it.usage, truncated: it.incompleteReason === "max_output_tokens" };
      // 24時間以内に処理されなかったもの。課金されないが、送ったバッチは答えを受け取らなければ費用0で閉じられない（契約）
      if (it.type === "expired") return { kind: "costUnknown", result: "expired", errorCode: "timeout" };
      // 失敗した1件の課金は資料に書かれていない（トークン数も返らない）
      return { kind: "costUnknown", result: "failed", errorCode: it.errorType === "rate_limit_error" ? "rate_limited" : "provider_error" };
    },
    async cancel(batchId) {
      return (await client.cancel(batchId)).ok;
    },
  };
}

/** API キーは環境変数（OPENAI_API_KEY。GitHub の secrets）から読む */
export function openaiBatchPort(options: BatchPortOptions & { client?: Client }): BatchPort {
  const client = options.client ?? new OpenAIBatchClient({ apiKey: openaiApiKeyFromEnv() });
  return new BatchPort(openaiBatchDriver(client), options);
}
