// Gemini API のバッチで、バッチの口（契約 LlmBatchPort）を作る（#179）。
// 送る形：system は先頭の1件だけ systemInstruction に移し、assistant は model と呼ぶ。settings は max_tokens（maxOutputTokens）と
// thinking_level だけ（temperature は送らない）。形への直し方は toGeminiRequest、本文は geminiBatchBody で決まる。
// バッチの名前（displayName）と中の1件のキーは、本文の中の1件のID（batchItemIdOf の前半）にする。
import type { LlmBatchPrice } from "../contracts";
import { BatchPort, batchItemIdOfCustomId, type BatchDriver, type BatchOutcome, type BatchPortOptions } from "./batch-port";
import { GEMINI_PROVIDER, GeminiBatchClient, geminiApiKeyFromEnv, geminiBatchBody, reconcileGeminiResults } from "./gemini-batch";
import { geminiBatchPrice } from "./gemini-pricing";

/**
 * 送る出力の上限（考えた過程を含む。#179 の lead の決定2）。maxOutputTokens に入れる。
 * 考えた過程が含まれることは、考えた過程の資料（https://ai.google.dev/gemini-api/docs/thinking#token-limits 。2026-11-08 確認）にあるが、
 * その節が指すのは Interactions API の max_output_tokens で、この口が使う generateContent の maxOutputTokens でも同じとは明記されていない。
 * 含まれなかったときは、実際の費用が予約を超え、閉じた記録の費用が maxCost を超える（記録の検査が上限の超過として見つける）
 */
export const GEMINI_MAX_OUTPUT_TOKENS = 8000;

/**
 * 予約の料金。依頼を決めた時刻（submittedAt）で一度だけ選ぶ（2027-01-01 からの値上げ。作ってから48時間のうちに切り替わるなら高いほう）。
 * 閉じたときも同じ時刻で選ぶので、値上げをまたいだバッチも予約と同じ料金になる
 */
export function geminiReservePrice(modelId: string, submittedAt: number): LlmBatchPrice | undefined {
  const p = geminiBatchPrice(modelId, submittedAt);
  return p && { inputCentsPer10MTok: p.inputCentsPer10MTok, outputCentsPer10MTok: p.outputCentsPer10MTok };
}

type Client = Pick<GeminiBatchClient, "createBody" | "results" | "cancel">;
const UNKNOWN: BatchOutcome = { kind: "costUnknown", result: "failed", errorCode: "provider_error" };

export function geminiBatchDriver(client: Client): BatchDriver {
  return {
    provider: GEMINI_PROVIDER,
    settingKeys: ["max_tokens", "thinking_level"],
    maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
    priceAt: geminiReservePrice,
    body: (r, itemId) => geminiBatchBody(r.model, itemId, [{ customId: itemId, messages: r.messages }]),
    async send(body, r, customId) {
      const c = await client.createBody(r.model, batchItemIdOfCustomId(customId), body);
      if (c.ok) return { ok: true, batchId: c.value.id };
      return c.billingUnknown ? { ok: false, errorCode: c.errorCode, billingUnknown: true } : { ok: false, errorCode: c.errorCode, notCreated: true };
    },
    /**
     * 表示名は本文の中にあるので、本文のハッシュを含む customId を名前にできない。また一覧からは送った本文のバイト列を取り出せない。
     * 契約の「customId の名前を持つ候補」を確かめられないので、not_found にする（予約した費用で閉じる）
     */
    find: async () => ({ status: "not_found" }),
    async outcome(t, itemId) {
      const res = await client.results(t.batchId);
      if (!res.ok) return "pending";
      const { status, items } = res.value;
      if (status.state === "pending" || status.state === "running") return "pending";
      if (status.state === "failed") return UNKNOWN;
      const it = reconcileGeminiResults([itemId], items).matched.get(itemId);
      // 結果がない（期限切れ・取り消しで処理されなかったものを含む）：課金されたか分からない
      if (it === undefined) return status.state === "expired" ? { kind: "costUnknown", result: "expired", errorCode: "timeout" } : UNKNOWN;
      // 失敗した1件の課金は資料に書かれていない
      if (it.type === "errored") return { kind: "costUnknown", result: "failed", errorCode: it.errorCode === 8 ? "rate_limited" : "provider_error" };
      // 答えたモデルの版がないときは、バッチのモデル（models/ を外したもの）
      const respondedModel = it.respondedModel ?? status.model.replace(/^models\//, "");
      return { kind: "succeeded", output: it.output, respondedModel, usage: it.usage, truncated: it.finishReason === "MAX_TOKENS" };
    },
    async cancel(batchId) {
      return (await client.cancel(batchId)).ok;
    },
  };
}

/** API キーは環境変数（GEMINI_API_KEY。GitHub の secrets）から読む */
export function geminiBatchPort(options: BatchPortOptions & { client?: Client }): BatchPort {
  const client = options.client ?? new GeminiBatchClient({ apiKey: geminiApiKeyFromEnv() });
  return new BatchPort(geminiBatchDriver(client), options);
}
