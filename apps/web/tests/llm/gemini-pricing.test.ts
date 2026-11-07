// Gemini のバッチの料金と費用の換算の試験。cost.ts の換算を包む部分（半セントの単価・日付で変わる単価）を確かめる。
import { describe, expect, it } from "vitest";
import {
  GEMINI_BATCH_MAX_LIFETIME_MS,
  GEMINI_PRICE_SWITCH_AT,
  geminiBatchCostDeciyen,
  geminiBatchPrice,
  geminiTokenUsage,
} from "../../src/llm/gemini-pricing";

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
const BEFORE = Date.parse("2026-11-09T07:35:00Z");
const LAST_OLD = GEMINI_PRICE_SWITCH_AT - GEMINI_BATCH_MAX_LIFETIME_MS - 1;

describe("Gemini のバッチの料金", () => {
  it("切り替わりは 2026-12-31T10:00Z（UTC+14 で 2027-01-01 の 0時）", () => {
    expect(new Date(GEMINI_PRICE_SWITCH_AT).toISOString()).toBe("2026-12-31T10:00:00.000Z");
  });

  it("作った時刻＋48時間が切り替わりの前なら古い単価、届くなら新しい単価", () => {
    expect(geminiBatchPrice("gemini-3.8-flash", BEFORE)).toMatchObject({ inputCentsPer10MTok: 375, outputCentsPer10MTok: 1875 });
    expect(geminiBatchPrice("gemini-3.8-flash", LAST_OLD)).toMatchObject({ inputCentsPer10MTok: 375 });
    expect(geminiBatchPrice("gemini-3.8-flash", LAST_OLD + 1)).toMatchObject({ inputCentsPer10MTok: 750, outputCentsPer10MTok: 3750 });
    expect(geminiBatchPrice("gemini-3.8-flash", Date.parse("2027-03-01T00:00:00Z"))).toMatchObject({ inputCentsPer10MTok: 750 });
  });

  it("料金表にないモデルは undefined。時刻が有限の数でなければ RangeError", () => {
    expect(geminiBatchPrice("gemini-3.1-pro-preview", BEFORE)).toBeUndefined();
    expect(geminiBatchPrice("toString", BEFORE)).toBeUndefined();
    expect(geminiBatchCostDeciyen(usage(1, 1), "gemini-3.1-pro-preview", BEFORE, 160)).toBeUndefined();
    expect(() => geminiBatchPrice("gemini-3.8-flash", Number.NaN)).toThrow(RangeError);
  });
});

describe("Gemini のバッチの費用（0.1円単位、切り上げ）", () => {
  it("入力2万・出力（考えた過程を含む）4,500 で、1ドル160円なら 25.5 → 26。切り替わりのあとは倍の 51", () => {
    expect(geminiBatchCostDeciyen(usage(20000, 4500), "gemini-3.8-flash", BEFORE, 160)).toBe(26);
    expect(geminiBatchCostDeciyen(usage(20000, 4500), "gemini-3.8-flash", LAST_OLD + 1, 160)).toBe(51);
    expect(geminiBatchCostDeciyen(usage(0, 0), "gemini-3.8-flash", BEFORE, 160)).toBe(0);
    expect(geminiBatchCostDeciyen(usage(1, 0), "gemini-3.8-flash", BEFORE, 160)).toBe(1);
  });

  it("2回の切り上げは、本当の費用を1回だけ切り上げた値と同じ（整数だけの計算と比べる）", () => {
    // 本当の費用（0.1円）＝ (入力×375 ＋ 出力×1875) × 円/ドル ÷ 1億（単価は1,000万トークンあたりのセント）
    const exact = (i: number, o: number, yen: number) => {
      const n = (BigInt(i) * 375n + BigInt(o) * 1875n) * BigInt(yen);
      return Number((n + 99_999_999n) / 100_000_000n);
    };
    let seed = 12345;
    const next = (max: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % max;
    };
    for (let k = 0; k < 2000; k += 1) {
      const i = next(3_000_000);
      const o = next(300_000);
      const yen = 1 + next(400);
      expect(geminiBatchCostDeciyen(usage(i, o), "gemini-3.8-flash", BEFORE, yen), `${i} ${o} ${yen}`).toBe(exact(i, o, yen));
    }
  });

  it("トークン数・換算の値の検査は cost.ts と同じ（外れたら RangeError）", () => {
    expect(() => geminiBatchCostDeciyen(usage(-1, 0), "gemini-3.8-flash", BEFORE, 160)).toThrow(RangeError);
    expect(() => geminiBatchCostDeciyen(usage(1, 0), "gemini-3.8-flash", BEFORE, 152.3)).toThrow(RangeError);
  });
});

describe("トークン数の移し替え（geminiTokenUsage）", () => {
  it("入力は prompt ＋ ツールの prompt、出力は候補 ＋ 考えた過程。キャッシュの欄は 0", () => {
    expect(geminiTokenUsage({ promptTokens: 100, toolUsePromptTokens: 5, candidatesTokens: 20, thoughtsTokens: 30 })).toEqual({
      inputTokens: 105,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });
});
