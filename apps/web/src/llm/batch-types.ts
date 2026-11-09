// 3社のバッチの API を呼ぶ部分（anthropic-batch.ts・openai-batch.ts・gemini-batch.ts）に共通する型（#179）。
import type { LlmErrorCode } from "../contracts";

export type BatchErrorCode = Extract<LlmErrorCode, "timeout" | "rate_limited" | "provider_error">;
/**
 * 失敗の理由（秘密を含まない決まった印）。
 * http：応答が 2xx でない。timeout：待ち時間切れ（本文を読む途中を含む）。network：通信の失敗（fetch の TypeError）。
 * malformed：応答の形が合わない。unexpected：それ以外の例外（文は捨てる）
 */
export type BatchFailureReason = "http" | "timeout" | "network" | "malformed" | "unexpected";
/**
 * 失敗。提供元のエラー文は持たない。status は HTTP の状態コード（応答がなかったときはない）。
 * billingUnknown：作成で、バッチが作られた（＝課金されうる）かどうか分からない失敗の印。
 * この印の付いた失敗は自動で再試行しない（2回作ると2回課金されうる）。
 * errorCode が rate_limited（429・503・529）でも、billingUnknown が付いていれば、こちらを先に見る（再試行しない）。
 */
export type BatchFailure = { ok: false; errorCode: BatchErrorCode; reason: BatchFailureReason; status?: number; billingUnknown?: true };
export type BatchCall<T> = { ok: true; value: T } | BatchFailure;

/** 作成で実際に送った本文の文字列と、その SHA-256（16進）。API キーは見出しにだけあり、ここには入らない */
export interface SentBody {
  body: string;
  sha256: string;
}
