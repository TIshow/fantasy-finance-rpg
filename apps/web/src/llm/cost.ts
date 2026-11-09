// トークン数から費用（0.1円単位の整数。端数は切り上げ）への換算（#179）。
// 1ドルあたりの円は呼び出し側から受け取り、ここでは決め打ちしない（値は owner の決定待ち。#179）。
import type { Deciyen } from "../ledger/types";

/** バッチの料金。100万トークンあたりのセント（1ドル＝100セント）。整数で持ち、計算に小数を使わない */
export interface BatchPrice {
  inputCentsPerMTok: number;
  outputCentsPerMTok: number;
}

/**
 * Anthropic の Message Batches API の料金（標準の半額）。
 * 出典：https://platform.claude.com/docs/en/about-claude/pricing （2026-11-07 確認）。
 * Sonnet 5.5 は標準で入力2ドル・出力10ドル/100万トークン、バッチはその半額の1ドル・5ドル。
 * D-041 の試算にある3ドル・15ドルは、古い Sonnet 4.x の標準の料金。
 * 料金が変わったら、ここを PR で直す。ここにないモデルは費用を出せない（呼び出し側が maxCost を費用とする）。
 */
export const ANTHROPIC_BATCH_PRICES: Readonly<Record<string, Readonly<BatchPrice>>> = Object.freeze({
  "claude-sonnet-5-5": Object.freeze({ inputCentsPerMTok: 100, outputCentsPerMTok: 500 }),
});

export function anthropicBatchPrice(modelId: string): Readonly<BatchPrice> | undefined {
  return Object.hasOwn(ANTHROPIC_BATCH_PRICES, modelId) ? ANTHROPIC_BATCH_PRICES[modelId] : undefined;
}

/** 提供元が返したトークン数。キャッシュの欄は、使っていなければ 0 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** キャッシュへの書き込み。高いほうの単価（入力の2倍）で数える */
  cacheCreationInputTokens: number;
  /** キャッシュからの読み出し。安全側に、入力と同じ単価で数える */
  cacheReadInputTokens: number;
}

const isCount = (v: number) => Number.isSafeInteger(v) && v >= 0;

/**
 * 費用を 0.1円単位で出す。端数は切り上げる。
 * 費用（0.1円）＝ Σ(トークン数 × セント/100万トークン) × 円/ドル × 10 ÷ (100 × 100万)
 * キャッシュの単価は実際より高めに数える（上限を超えにくい側に倒す）。
 * トークン数・料金が 0 以上の安全な整数でない、yenPerUsd が 1 以上の安全な整数でないときは RangeError。
 * yenPerUsd は整数だけ受け付ける。換算の値が小数のとき（例：152.3円）は、呼び出し側で切り上げて渡す（153）。
 * 切り上げは費用を高めに数える側なので、上限を超えにくい。
 */
export function batchCostDeciyen(usage: TokenUsage, price: Readonly<BatchPrice>, yenPerUsd: number): Deciyen {
  const counts = [usage.inputTokens, usage.outputTokens, usage.cacheCreationInputTokens, usage.cacheReadInputTokens];
  if (!counts.every(isCount)) throw new RangeError("token counts must be non-negative safe integers");
  if (!Number.isSafeInteger(yenPerUsd) || yenPerUsd < 1) throw new RangeError("yenPerUsd must be a positive safe integer");
  if (!isCount(price.inputCentsPerMTok) || !isCount(price.outputCentsPerMTok)) throw new RangeError("prices must be non-negative safe integers");
  const B = BigInt;
  const input = B(price.inputCentsPerMTok);
  const centTokens =
    B(usage.inputTokens) * input +
    B(usage.cacheCreationInputTokens) * input * 2n +
    B(usage.cacheReadInputTokens) * input +
    B(usage.outputTokens) * B(price.outputCentsPerMTok);
  const numerator = centTokens * B(yenPerUsd) * 10n;
  const denominator = 100n * 1_000_000n;
  const cost = (numerator + denominator - 1n) / denominator;
  if (cost > B(Number.MAX_SAFE_INTEGER)) throw new RangeError("cost is too large");
  return Number(cost);
}
