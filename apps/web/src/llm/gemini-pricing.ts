// Gemini API のバッチの料金と、トークン数から費用（0.1円単位の整数。端数は切り上げ）への換算（#179）。
// 換算そのものは cost.ts の batchCostDeciyen を使い、cost.ts は変えない（OpenAI の分と並べて作っているため）。
// cost.ts の形（100万トークンあたりの整数のセント）では、次の2つをそのまま表せないので、ここで包む：
// 1. 単価が半セント（0.375ドル＝37.5セント）。→ 1,000万トークンあたりのセントで持ち、cost.ts で出た値を10で割って切り上げる
// 2. 単価が日付で変わる（2027-01-01 から倍）。→ バッチを作った時刻から、どちらの単価かを選ぶ
import type { Deciyen } from "../ledger/types";
import { batchCostDeciyen, type BatchPrice, type TokenUsage } from "./cost";

/** バッチの料金の1つの期間。from（UTC のミリ秒）から次の期間の from の前まで。単価は1,000万トークンあたりのセント（整数） */
export interface GeminiPricePeriod {
  from: number;
  inputCentsPer10MTok: number;
  outputCentsPer10MTok: number;
}

/**
 * 料金の切り替わり：「2026-12-31 まで」「2027-01-01 から」。どの時間帯の日付かは資料に書かれていないので、
 * 世界でいちばん早く 2027-01-01 になる時刻（UTC+14 の 0時＝2026-12-31T10:00Z）で切り替える（高い単価を早めに使う側）。
 */
export const GEMINI_PRICE_SWITCH_AT = Date.parse("2026-12-31T10:00:00Z");

/**
 * バッチは作ってから最長48時間で期限切れになる（https://ai.google.dev/gemini-api/docs/batch-mode 。2026-11-07 確認）。
 * いつ処理されて課金されるかは分からないので、作った時刻にこの長さを足した時刻が切り替わりを過ぎるなら、高い単価で数える。
 */
export const GEMINI_BATCH_MAX_LIFETIME_MS = 48 * 60 * 60 * 1000;

/**
 * Gemini 3.8 Flash の出力の上限（考えた過程を含む）。予約の出力のトークン数は、これ以上にする（gemini-port.ts の minReservedOutputTokens）。
 * 根拠（どちらも 2026-11-08 確認）：https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.8 に「64k max output tokens」、
 * https://ai.google.dev/gemini-api/docs/thinking#token-limits に「出力の上限は考えた過程のトークンを含む」。
 * 考えた過程の量を決める設定は thinking_level だけで（thinking_budget は 3.8 では使えない）、トークン数の上限にはならない。
 * 「64k」は、大きいほうの 65,536 と読む
 */
export const GEMINI_MAX_OUTPUT_TOKENS = 65_536;

/**
 * Gemini API（Developer API。API キーで使う口）のバッチの料金。有料の枠だけ（無料の枠ではバッチを使えない）。
 * 出典：https://ai.google.dev/gemini-api/docs/pricing （2026-11-07 確認）。
 * Gemini 3.8 Flash のバッチ：入力 0.375ドル・出力 1.875ドル／100万トークン（2026-12-31 まで）、
 * 2027-01-01 から入力 0.75ドル・出力 3.75ドル。出力には考えた過程のトークン（thinking）を含む。
 * この口が使う generateContent の maxOutputTokens が考えた過程を含むかは、資料に明記されていない
 * （https://ai.google.dev/api/generate-content は「1つの候補に含めるトークン数の上限」。2026-11-08 確認）。
 * そこで予約は max_tokens ではなく、モデルの出力の上限（GEMINI_MAX_OUTPUT_TOKENS）で見込む。
 * キャッシュの単価（入力の1割）は使わず、キャッシュに当たった分も入力の単価で数える（高めに数える側）。
 * 料金が変わったら、ここを PR で直す。ここにないモデルは費用を出せない（呼び出し側が maxCost を費用とする）。
 */
export const GEMINI_BATCH_PRICES: Readonly<Record<string, readonly Readonly<GeminiPricePeriod>[]>> = Object.freeze({
  "gemini-3.8-flash": Object.freeze([
    Object.freeze({ from: Number.NEGATIVE_INFINITY, inputCentsPer10MTok: 375, outputCentsPer10MTok: 1875 }),
    Object.freeze({ from: GEMINI_PRICE_SWITCH_AT, inputCentsPer10MTok: 750, outputCentsPer10MTok: 3750 }),
  ]),
});

/**
 * バッチを作った時刻（UTC のミリ秒）から、そのバッチに使う単価を選ぶ。作った時刻＋48時間の時点の単価にする。
 * 「作った時刻」は、提供元が返したバッチの作成時刻（GeminiBatchStatus.createdAt）を使う。それがない
 * （作成が失敗して状態が返らなかった）ときは、作成を頼む直前に自分の時計で取った時刻を使う。
 * ここにないモデルは undefined。時刻が有限の数でなければ RangeError。
 */
export function geminiBatchPrice(modelId: string, batchCreatedAt: number): Readonly<GeminiPricePeriod> | undefined {
  if (!Number.isFinite(batchCreatedAt)) throw new RangeError("batchCreatedAt must be a finite number");
  if (!Object.hasOwn(GEMINI_BATCH_PRICES, modelId)) return undefined;
  const latest = batchCreatedAt + GEMINI_BATCH_MAX_LIFETIME_MS;
  let chosen: Readonly<GeminiPricePeriod> | undefined;
  for (const p of GEMINI_BATCH_PRICES[modelId]!) if (p.from <= latest) chosen = p;
  return chosen;
}

/**
 * Gemini から返ったトークン数を、cost.ts の TokenUsage に移す。
 * - 入力：promptTokenCount（キャッシュに当たった分を含む）＋ toolUsePromptTokenCount
 * - 出力：candidatesTokenCount ＋ thoughtsTokenCount（考えた過程も出力の単価で課金される）。
 *   gemini-batch.ts は、totalTokenCount がこれらの足し算より大きいとき、その差を candidatesTokens に足して渡す。
 *   ツールもキャッシュも使わないので、入力の外のトークンはすべてモデルが生成したもので、合わせて GEMINI_MAX_OUTPUT_TOKENS 以下
 * - キャッシュの欄は 0（キャッシュに当たった分も入力の単価で数える）
 */
export function geminiTokenUsage(u: { promptTokens: number; toolUsePromptTokens: number; candidatesTokens: number; thoughtsTokens: number }): TokenUsage {
  return {
    inputTokens: u.promptTokens + u.toolUsePromptTokens,
    outputTokens: u.candidatesTokens + u.thoughtsTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

/**
 * 費用を 0.1円単位で出す（端数は切り上げ）。モデルが料金表にないときは undefined。
 * 単価を1,000万トークンあたりのセントにして cost.ts に渡すと、cost.ts は「本当の費用×10」を切り上げた整数 n を返す。
 * それを10で割って切り上げると、本当の費用 x を切り上げた値になる（ceil(ceil(10x)/10) = ceil(x)。x ≥ 0）。
 * トークン数・yenPerUsd の検査は cost.ts と同じ（外れたら RangeError）。
 */
export function geminiBatchCostDeciyen(usage: TokenUsage, modelId: string, batchCreatedAt: number, yenPerUsd: number): Deciyen | undefined {
  const period = geminiBatchPrice(modelId, batchCreatedAt);
  if (period === undefined) return undefined;
  const per10M: BatchPrice = { inputCentsPerMTok: period.inputCentsPer10MTok, outputCentsPerMTok: period.outputCentsPer10MTok };
  const tenTimes = batchCostDeciyen(usage, per10M, yenPerUsd);
  // 整数のまま10で割って切り上げる（小数の割り算の誤差を入れない）
  const rest = tenTimes % 10;
  return (tenTimes - rest) / 10 + (rest > 0 ? 1 : 0);
}
