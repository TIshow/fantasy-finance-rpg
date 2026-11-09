// Anthropic の Message Batches API で、バッチの口（契約 LlmBatchPort）を作る（#179）。
// 送る形：system は先頭の1件だけ Messages API の system に移し、settings は max_tokens だけ（temperature は送らない）。
// 形への直し方は toAnthropicParams、本文は anthropicBatchBody で決まる。本文の中の1件のID（custom_id）は batchItemIdOf の前半。
import type { LlmBatchPrice } from "../contracts";
import { AnthropicBatchClient, anthropicApiKeyFromEnv, anthropicBatchBody, reconcileResults, toAnthropicParams } from "./anthropic-batch";
import { BatchPort, type BatchDriver, type BatchPortOptions } from "./batch-port";
import { anthropicBatchPrice } from "./cost";

export const ANTHROPIC_PROVIDER = "anthropic";
/** 送る出力の上限（#179 の lead の決定2：投稿400字と注文10件なら十分） */
export const ANTHROPIC_MAX_OUTPUT_TOKENS = 4000;

/** 予約の料金。料金表（cost.ts。100万トークンあたりのセント）を1,000万トークンあたりに直す。時刻では変わらない */
export function anthropicReservePrice(modelId: string): LlmBatchPrice | undefined {
  const p = anthropicBatchPrice(modelId);
  return p && { inputCentsPer10MTok: p.inputCentsPerMTok * 10, outputCentsPer10MTok: p.outputCentsPerMTok * 10 };
}

type Client = Pick<AnthropicBatchClient, "createBody" | "retrieve" | "results" | "cancel">;

export function anthropicBatchDriver(client: Client): BatchDriver {
  return {
    provider: ANTHROPIC_PROVIDER,
    settingKeys: ["max_tokens"],
    maxOutputTokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
    priceAt: (modelId) => anthropicReservePrice(modelId),
    body: (r, itemId) => anthropicBatchBody([{ customId: itemId, params: toAnthropicParams(r.model, r.messages) }]),
    async send(body) {
      const c = await client.createBody(body);
      if (c.ok) return { ok: true, batchId: c.value.id };
      // 作られたか分からない失敗（応答なし・408・5xx・形が合わない）は billingUnknown。ほかの 4xx は作らずに断ったもの
      return c.billingUnknown ? { ok: false, errorCode: c.errorCode, billingUnknown: true } : { ok: false, errorCode: c.errorCode, notCreated: true };
    },
    /** Anthropic のバッチの情報には名前（customId）がなく、処理中は本文も見えないので、契約のとおり確かめられない（not_found） */
    find: async () => ({ status: "not_found" }),
    async outcome(t, itemId) {
      const s = await client.retrieve(t.batchId);
      if (!s.ok || s.value.processingStatus !== "ended") return "pending";
      const res = await client.results(t.batchId);
      if (!res.ok) return "pending";
      const it = reconcileResults([itemId], res.value).matched.get(itemId);
      if (it !== undefined && it.type === "succeeded") {
        // 入力の倍率1は、キャッシュへの書き込み（入力の2倍）が起きない前提（cache_control を送らない）。起きていたら予約で見込めないので、予約した費用で閉じる
        const unknown = it.usage.cacheCreationInputTokens > 0 ? { costUnknown: true as const } : {};
        return { kind: "succeeded", output: it.output, respondedModel: it.respondedModel, usage: it.usage, truncated: it.stopReason === "max_tokens", ...unknown };
      }
      // errored・canceled・expired は資料では課金されない（https://platform.claude.com/docs/en/build-with-claude/batch-processing 。2026-11-07 確認）が、
      // 送ったバッチは答えを受け取らなければ費用0で閉じられない（契約）ので、予約した費用で数える。結果がない・形が合わないときも同じ
      if (it?.type === "expired") return { kind: "costUnknown", result: "expired", errorCode: "timeout" };
      const limited = it?.type === "errored" && (it.errorType === "rate_limit_error" || it.errorType === "overloaded_error");
      return { kind: "costUnknown", result: "failed", errorCode: limited ? "rate_limited" : "provider_error" };
    },
    async cancel(batchId) {
      return (await client.cancel(batchId)).ok;
    },
  };
}

/** API キーは環境変数（ANTHROPIC_API_KEY。GitHub の secrets）から読む */
export function anthropicBatchPort(options: BatchPortOptions & { client?: Client }): BatchPort {
  const client = options.client ?? new AnthropicBatchClient({ apiKey: anthropicApiKeyFromEnv() });
  return new BatchPort(anthropicBatchDriver(client), options);
}
