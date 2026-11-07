// Gemini API のバッチで、バッチの口（契約 LlmBatchPort）を作る（#179）。
// 送る形：system は先頭の1件だけ systemInstruction に移し、assistant は model と呼ぶ。settings は max_tokens（maxOutputTokens）と
// thinking_level だけ（temperature は送らない）。形への直し方は toGeminiRequest、本文は geminiBatchBody で決まる。
// バッチの名前（displayName）は customId にし、作られたか分からないときは名前で一覧を探す。
import type { LlmBatchPrice } from "../contracts";
import { BatchPort, type BatchDriver, type BatchOutcome, type BatchPortOptions } from "./batch-port";
import { GEMINI_PROVIDER, GeminiBatchClient, findGeminiBatchByDisplayName, geminiApiKeyFromEnv, geminiBatchBody, reconcileGeminiResults } from "./gemini-batch";
import { geminiBatchPrice } from "./gemini-pricing";

/**
 * 予約の料金。依頼を決めた時刻（submittedAt）で一度だけ選ぶ（2027-01-01 からの値上げ。作ってから48時間のうちに切り替わるなら高いほう）。
 * 閉じたときも同じ時刻で選ぶので、値上げをまたいだバッチも予約と同じ料金になる
 */
export function geminiReservePrice(modelId: string, submittedAt: number): LlmBatchPrice | undefined {
  const p = geminiBatchPrice(modelId, submittedAt);
  return p && { inputCentsPer10MTok: p.inputCentsPer10MTok, outputCentsPer10MTok: p.outputCentsPer10MTok };
}

type Client = Pick<GeminiBatchClient, "create" | "results" | "cancel" | "list">;
const UNKNOWN: BatchOutcome = { kind: "costUnknown", result: "failed", errorCode: "provider_error" };

export function geminiBatchDriver(client: Client): BatchDriver {
  return {
    provider: GEMINI_PROVIDER,
    settingKeys: ["max_tokens", "thinking_level"],
    priceAt: geminiReservePrice,
    prepare(r, customId) {
      const items = [{ customId, messages: r.messages }];
      return {
        body: geminiBatchBody(r.model, customId, items),
        async send() {
          const c = await client.create(r.model, customId, items);
          if (c.ok) return { ok: true, batchId: c.value.id, sentBodyHash: c.sent.sha256 };
          return { ok: false, errorCode: c.errorCode, ...(c.billingUnknown ? { billingUnknown: true as const } : {}) };
        },
      };
    },
    async outcome(t) {
      const res = await client.results(t.batchId);
      if (!res.ok) return "pending";
      const { status, items } = res.value;
      if (status.state === "pending" || status.state === "running") return "pending";
      if (status.state === "failed") return UNKNOWN;
      const it = reconcileGeminiResults([t.customId], items).matched.get(t.customId);
      // 結果がない（期限切れ・取り消しで処理されなかったものを含む）：課金されたか分からない
      if (it === undefined) return status.state === "expired" ? { kind: "costUnknown", result: "expired", errorCode: "timeout" } : UNKNOWN;
      // 失敗した1件の課金は資料に書かれていない
      if (it.type === "errored") return { kind: "costUnknown", result: "failed", errorCode: it.errorCode === 8 ? "rate_limited" : "provider_error" };
      // 答えたモデルの版がないときは、バッチのモデル（models/ を外したもの）
      const respondedModel = it.respondedModel ?? status.model.replace(/^models\//, "");
      return { kind: "succeeded", output: it.output, respondedModel, usage: it.usage };
    },
    async cancel(batchId) {
      return (await client.cancel(batchId)).ok;
    },
    /**
     * customId の名前のバッチを、一覧の全ページから探す（findGeminiBatchByDisplayName）。since を作成を頼んだ時刻として渡すので、
     * since から1時間たつまでは、見つからなくても unknown。
     * 名前の読めない項目（AI Studio で付けた空白入りの名前など）が一覧に残っていると、いつも unknown になる。
     * そのときは運用者が AI Studio でその項目を確かめ、要らなければ消す（自動ではやり直さない）
     */
    async lookup(q) {
      const r = await findGeminiBatchByDisplayName(client, q.customId, { requestedAt: q.since, now: q.now });
      switch (r.kind) {
        case "notFound":
          return { kind: "none" };
        case "found":
          if (!q.recordedBatchIds.has(r.batch.id)) return { kind: "found", batchIds: [r.batch.id] };
          return r.maybeDuplicated ? { kind: "unknown" } : { kind: "none" };
        case "foundUnreadable":
          if (r.id === undefined) return { kind: "unknown" };
          if (!q.recordedBatchIds.has(r.id)) return { kind: "found", batchIds: [r.id] };
          return r.maybeDuplicated ? { kind: "unknown" } : { kind: "none" };
        case "duplicated": {
          const ids = r.ids.filter((id) => !q.recordedBatchIds.has(id));
          return ids.length > 0 ? { kind: "found", batchIds: ids } : { kind: "unknown" };
        }
        default:
          return { kind: "unknown" };
      }
    },
  };
}

/** API キーは環境変数（GEMINI_API_KEY。GitHub の secrets）から読む */
export function geminiBatchPort(options: BatchPortOptions & { client?: Client }): BatchPort {
  const client = options.client ?? new GeminiBatchClient({ apiKey: geminiApiKeyFromEnv() });
  return new BatchPort(geminiBatchDriver(client), options);
}
