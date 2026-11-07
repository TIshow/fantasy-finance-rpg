// OpenAI の Batch API で、バッチの口（契約 LlmBatchPort）を作る（#179）。
// 送る形：messages は役割と本文をそのまま Responses API の input に入れ、settings は max_tokens（max_output_tokens）と
// reasoning_effort だけ（temperature は送らない）。形への直し方は toOpenAIParams、上げるファイルの中身は openaiBatchFileBody。
// 送った本文のハッシュは、上げたファイルの中身のハッシュ（契約）。
import type { LlmBatchPrice } from "../contracts";
import { BatchPort, type BatchDriver, type BatchOutcome, type BatchPortOptions } from "./batch-port";
import { OpenAIBatchClient, openaiApiKeyFromEnv, openaiBatchFileBody, reconcileResults, toOpenAIParams, type BatchItemResult } from "./openai-batch";
import { openaiBatchReservePrice } from "./openai-pricing";

export const OPENAI_PROVIDER = "openai";
/** 記録にないバッチを探すときに読む一覧のページ数の上限（1ページ100件）。超えたら決められない（unknown） */
const LOOKUP_MAX_PAGES = 20;

/**
 * 予約の料金。長い文脈の料金（入力が272,000トークンを超えるとき）を1,000万トークンあたりのセントに直す。時刻では変わらない。
 * 閉じたときも同じ料金で数える（実際は短い文脈の安い料金のことが多いが、多めに数えるので上限に対して安全側）
 */
export function openaiReservePrice(modelId: string): LlmBatchPrice | undefined {
  const p = openaiBatchReservePrice(modelId);
  return p && { inputCentsPer10MTok: p.inputCentsPerMTok * 10, outputCentsPer10MTok: p.outputCentsPerMTok * 10 };
}

type Client = Pick<OpenAIBatchClient, "upload" | "create" | "retrieve" | "results" | "cancel" | "list">;
const UNKNOWN: BatchOutcome = { kind: "costUnknown", result: "failed", errorCode: "provider_error" };

export function openaiBatchDriver(client: Client): BatchDriver {
  return {
    provider: OPENAI_PROVIDER,
    settingKeys: ["max_tokens", "reasoning_effort"],
    priceAt: (modelId) => openaiReservePrice(modelId),
    prepare(r, customId) {
      const items = [{ customId, params: toOpenAIParams(r.model, r.messages) }];
      return {
        body: openaiBatchFileBody(items),
        async send() {
          // ファイルの上げは課金されないので、失敗はバッチが作られていない
          const up = await client.upload(items);
          if (!up.ok) return { ok: false, errorCode: up.errorCode };
          const c = await client.create(up.value.id);
          if (c.ok) return { ok: true, batchId: c.value.id, sentBodyHash: up.sent.sha256 };
          return { ok: false, errorCode: c.errorCode, ...(c.billingUnknown ? { billingUnknown: true as const } : {}) };
        },
      };
    },
    async outcome(t) {
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
      const it = reconcileResults([t.customId], items).matched.get(t.customId);
      if (it === undefined) return UNKNOWN;
      if (it.type === "succeeded") return { kind: "succeeded", output: it.output, respondedModel: it.respondedModel, usage: it.usage };
      // 24時間以内に処理されなかったもの（課金されない）
      if (it.type === "expired") return { kind: "notBilled", result: "expired", errorCode: "timeout" };
      // 失敗した1件の課金は資料に書かれていない（トークン数も返らない）
      return { kind: "costUnknown", result: "failed", errorCode: it.errorType === "rate_limit_error" ? "rate_limited" : "provider_error" };
    },
    async cancel(batchId) {
      return (await client.cancel(batchId)).ok;
    },
    /**
     * since より後に作られた、記録にないバッチをすべて見つかったとする（OpenAI のバッチの情報には customId がない。
     * GPT の AI は1体なので、ほかの AI のバッチと取り違えない。2体以上にするなら作り直す）
     */
    async lookup(q) {
      const found: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < LOOKUP_MAX_PAGES; page += 1) {
        const r = await client.list({ limit: 100, ...(after === undefined ? {} : { after }) });
        if (!r.ok) return { kind: "unknown" };
        for (const b of r.value.data) if (b.createdAt >= q.since && !q.recordedBatchIds.has(b.id)) found.push(b.id);
        // 一覧は新しい順。いちばん古いものが since より前なら、その先は読まなくてよい
        const oldest = r.value.data.at(-1);
        if (!r.value.hasMore || r.value.lastId === null || (oldest !== undefined && oldest.createdAt < q.since)) {
          return found.length > 0 ? { kind: "found", batchIds: found } : { kind: "none" };
        }
        after = r.value.lastId;
      }
      return { kind: "unknown" };
    },
  };
}

/** API キーは環境変数（OPENAI_API_KEY。GitHub の secrets）から読む */
export function openaiBatchPort(options: BatchPortOptions & { client?: Client }): BatchPort {
  const client = options.client ?? new OpenAIBatchClient({ apiKey: openaiApiKeyFromEnv() });
  return new BatchPort(openaiBatchDriver(client), options);
}
