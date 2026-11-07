// Anthropic の Message Batches API で、バッチの口（契約 LlmBatchPort）を作る（#179）。
// 送る形：system は先頭の1件だけ Messages API の system に移し、settings は max_tokens だけ（temperature は送らない）。
// 形への直し方は toAnthropicParams、本文は anthropicBatchBody で決まり、送った本文のハッシュを返す。
import type { LlmBatchPrice } from "../contracts";
import { AnthropicBatchClient, anthropicApiKeyFromEnv, anthropicBatchBody, reconcileResults, toAnthropicParams } from "./anthropic-batch";
import { BatchPort, type BatchDriver, type BatchPortOptions } from "./batch-port";
import { anthropicBatchPrice } from "./cost";

export const ANTHROPIC_PROVIDER = "anthropic";
/** 記録にないバッチを探すときに読む一覧のページ数の上限（1ページ100件）。超えたら決められない（unknown） */
const LOOKUP_MAX_PAGES = 20;

/** 予約の料金。料金表（cost.ts。100万トークンあたりのセント）を1,000万トークンあたりに直す。時刻では変わらない */
export function anthropicReservePrice(modelId: string): LlmBatchPrice | undefined {
  const p = anthropicBatchPrice(modelId);
  return p && { inputCentsPer10MTok: p.inputCentsPerMTok * 10, outputCentsPer10MTok: p.outputCentsPerMTok * 10 };
}

type Client = Pick<AnthropicBatchClient, "create" | "retrieve" | "results" | "cancel" | "list">;

export function anthropicBatchDriver(client: Client): BatchDriver {
  return {
    provider: ANTHROPIC_PROVIDER,
    settingKeys: ["max_tokens"],
    priceAt: (modelId) => anthropicReservePrice(modelId),
    prepare(r, customId) {
      const items = [{ customId, params: toAnthropicParams(r.model, r.messages) }];
      return {
        body: anthropicBatchBody(items),
        async send() {
          const c = await client.create(items);
          if (c.ok) return { ok: true, batchId: c.value.id, sentBodyHash: c.sent.sha256 };
          return { ok: false, errorCode: c.errorCode, ...(c.billingUnknown ? { billingUnknown: true as const } : {}) };
        },
      };
    },
    async outcome(t) {
      const s = await client.retrieve(t.batchId);
      if (!s.ok || s.value.processingStatus !== "ended") return "pending";
      const res = await client.results(t.batchId);
      if (!res.ok) return "pending";
      const it = reconcileResults([t.customId], res.value).matched.get(t.customId);
      // 結果がない・形が合わない・重なった：課金されたか分からない
      if (it === undefined) return { kind: "costUnknown", result: "failed", errorCode: "provider_error" };
      if (it.type === "succeeded") return { kind: "succeeded", output: it.output, respondedModel: it.respondedModel, usage: it.usage };
      // errored・canceled・expired は課金されない（https://platform.claude.com/docs/en/build-with-claude/batch-processing 。2026-11-07 確認）
      if (it.type === "expired") return { kind: "notBilled", result: "expired", errorCode: "timeout" };
      const limited = it.type === "errored" && (it.errorType === "rate_limit_error" || it.errorType === "overloaded_error");
      return { kind: "notBilled", result: "failed", errorCode: limited ? "rate_limited" : "provider_error" };
    },
    async cancel(batchId) {
      return (await client.cancel(batchId)).ok;
    },
    /**
     * Anthropic のバッチの情報には customId がないので、since より後に作られた、記録にないバッチをすべて見つかったとする
     * （Claude の AI は1体なので、ほかの AI のバッチと取り違えない。2体以上にするなら作り直す）
     */
    async lookup(q) {
      const found: string[] = [];
      let afterId: string | undefined;
      for (let page = 0; page < LOOKUP_MAX_PAGES; page += 1) {
        const r = await client.list({ limit: 100, ...(afterId === undefined ? {} : { afterId }) });
        if (!r.ok) return { kind: "unknown" };
        for (const b of r.value.data) if (b.createdAt >= q.since && !q.recordedBatchIds.has(b.id)) found.push(b.id);
        // 一覧は新しい順。いちばん古いものが since より前なら、その先は読まなくてよい
        const oldest = r.value.data.at(-1);
        if (!r.value.hasMore || r.value.lastId === null || (oldest !== undefined && oldest.createdAt < q.since)) {
          return found.length > 0 ? { kind: "found", batchIds: found } : { kind: "none" };
        }
        afterId = r.value.lastId;
      }
      return { kind: "unknown" };
    },
  };
}

/** API キーは環境変数（ANTHROPIC_API_KEY。GitHub の secrets）から読む */
export function anthropicBatchPort(options: BatchPortOptions & { client?: Client }): BatchPort {
  const client = options.client ?? new AnthropicBatchClient({ apiKey: anthropicApiKeyFromEnv() });
  return new BatchPort(anthropicBatchDriver(client), options);
}
