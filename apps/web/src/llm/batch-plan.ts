// 3社のバッチの予約の見積もりと、その日の合計の確かめ（#179 の lead の決定2）。
// 予約 ＝ 入力の上限 × 入力の倍率 × 入力の単価 ＋ 出力の上限 × 出力の単価（1ドル160円。0.1円未満は切り上げ。batch-port.ts の batchReserveCost）。
// 入力の倍率は、GPT だけ3（キャッシュへの書き込みを3倍で数えるため。#179 の lead の答え）。送る本文の上限は3社とも2万バイト。
// 毎日の実行は、依頼を始める前に checkDailyBatchReservations を呼び、合計が目標（80円）を超える設定なら始めない。
import type { LlmBatchPrice } from "../contracts";
import type { Deciyen } from "../ledger/types";
import { ANTHROPIC_MAX_OUTPUT_TOKENS, ANTHROPIC_PROVIDER, anthropicReservePrice } from "./anthropic-port";
import { BATCH_MAX_INPUT_TOKENS, YEN_PER_USD, batchReserveCost } from "./batch-port";
import { GEMINI_PROVIDER } from "./gemini-batch";
import { GEMINI_MAX_OUTPUT_TOKENS, geminiReservePrice } from "./gemini-port";
import { OPENAI_INPUT_COST_FACTOR, OPENAI_MAX_OUTPUT_TOKENS, OPENAI_PROVIDER, openaiReservePrice } from "./openai-port";

/** 1日の予約の合計の目標（80円。1日の上限100円との差は、思いがけない費用の余裕） */
export const BATCH_DAILY_RESERVE_TARGET: Deciyen = 800;

/** 提供元ごとの上限。inputCostFactor は、入力の1トークンを費用の式で何倍に数えうるか（予約で入力に掛ける。送る口の driver と同じ値） */
const LIMITS: Readonly<Record<string, { maxOutputTokens: number; inputCostFactor: number; price: (modelId: string, at: number) => LlmBatchPrice | undefined }>> = Object.freeze({
  [ANTHROPIC_PROVIDER]: { maxOutputTokens: ANTHROPIC_MAX_OUTPUT_TOKENS, inputCostFactor: 1, price: (m: string) => anthropicReservePrice(m) },
  [OPENAI_PROVIDER]: { maxOutputTokens: OPENAI_MAX_OUTPUT_TOKENS, inputCostFactor: OPENAI_INPUT_COST_FACTOR, price: (m: string) => openaiReservePrice(m) },
  [GEMINI_PROVIDER]: { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS, inputCostFactor: 1, price: geminiReservePrice },
});

/** 1件の依頼の予約。LlmBatchRequest の reservePrice・maxInputTokens・maxOutputTokens・maxCost と、settings.max_tokens にそのまま使う */
export interface BatchReservation {
  reservePrice: LlmBatchPrice & { yenPerUsd: number };
  maxInputTokens: number;
  maxOutputTokens: number;
  /** 送ってよい本文（提供元に渡す JSON）の UTF-8 のバイト数の上限。これ以下なら入力は maxInputTokens に必ず収まる */
  maxBodyBytes: number;
  maxCost: Deciyen;
}

/** submittedAt の時点の料金での予約。知らない提供元・料金表にないモデルは RangeError */
export function batchReservationOf(model: { provider: string; modelId: string }, submittedAt: number, yenPerUsd: number = YEN_PER_USD): BatchReservation {
  const l = Object.hasOwn(LIMITS, model.provider) ? LIMITS[model.provider] : undefined;
  const p = l?.price(model.modelId, submittedAt);
  if (l === undefined || p === undefined) throw new RangeError(`no batch price for ${model.provider}/${model.modelId}`);
  if (!Number.isSafeInteger(yenPerUsd) || yenPerUsd < 1) throw new RangeError("yenPerUsd must be a positive safe integer");
  const reservePrice = { yenPerUsd, inputCentsPer10MTok: p.inputCentsPer10MTok, outputCentsPer10MTok: p.outputCentsPer10MTok };
  const maxCost = batchReserveCost(BATCH_MAX_INPUT_TOKENS, l.maxOutputTokens, l.inputCostFactor, reservePrice);
  if (maxCost === null) throw new RangeError("the reservation does not fit in a safe integer");
  return { reservePrice, maxInputTokens: BATCH_MAX_INPUT_TOKENS, maxOutputTokens: l.maxOutputTokens, maxBodyBytes: BATCH_MAX_INPUT_TOKENS, maxCost };
}

/**
 * その日に依頼する AI のモデル（1体1件）の予約の合計。目標（既定は BATCH_DAILY_RESERVE_TARGET）を超えるなら RangeError。
 * 毎日の実行が、依頼を始める前に呼ぶ（その日はどの AI も依頼しない）。yenPerUsd は、送る口（BatchPortOptions.yenPerUsd）と同じ値を渡す
 */
export function checkDailyBatchReservations(
  models: readonly { provider: string; modelId: string }[],
  submittedAt: number,
  { target = BATCH_DAILY_RESERVE_TARGET, yenPerUsd = YEN_PER_USD }: { target?: Deciyen; yenPerUsd?: number } = {},
): Deciyen {
  const total = models.reduce((sum, m) => sum + batchReservationOf(m, submittedAt, yenPerUsd).maxCost, 0);
  if (total > target) throw new RangeError(`the daily reservations (${total}) exceed the target (${target})`);
  return total;
}
