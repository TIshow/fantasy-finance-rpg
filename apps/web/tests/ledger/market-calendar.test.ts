// 架空の市場の取引日（D-047）：2026-11-09 からは土日・祝日・年末年始も毎日が取引日。それより前は東証の営業日のまま。
// 判断の受け付けの始まりは、前の取引日の引け（16:30。#228 の lead の決定）。
import { describe, expect, it } from "vitest";
import { holidaysFor } from "../../src/holidays/index";
import {
  cutoffOf,
  decisionOpensAt,
  EVERY_DAY_FROM,
  isBusinessDay,
  isTradingDay,
  marketClosedDays,
  nextBusinessDay,
  nextTradingDay,
  previousBusinessDay,
  previousTradingDay,
  tradingDateFor,
  upcomingTradingDay,
} from "../../src/ledger/ledger";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
/** 実在の祝日の一覧（2020〜2027年）。架空の市場の休みには marketClosedDays で変える */
const real = holidaysFor("2020-01-01", "2027-12-31");
const market = marketClosedDays(real);
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

describe("架空の市場の取引日", () => {
  it("切り替えの日は 2026-11-09（月）", () => {
    expect(EVERY_DAY_FROM).toBe("2026-11-09");
  });

  it("切り替えより後の土日・祝日は取引日。前の土日は取引日でない", () => {
    expect(isTradingDay("2026-11-07", market)).toBe(false); // 土
    expect(isTradingDay("2026-11-08", market)).toBe(false); // 日
    expect(isTradingDay("2026-11-09", market)).toBe(true);
    expect(isTradingDay("2026-11-14", market)).toBe(true); // 土
    expect(isTradingDay("2026-11-15", market)).toBe(true); // 日
    expect(isTradingDay("2026-11-23", market)).toBe(true); // 勤労感謝の日
    expect(isTradingDay("2026-11-03", market)).toBe(false); // 切り替えより前の文化の日
    expect(() => isTradingDay("2026-11-31", market)).toThrow("invalid trading date");
  });

  it("切り替えより後の年末年始（12/31〜1/3）も取引日で、次・前の取引日は暦の翌日・前日", () => {
    for (const d of ["2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]) expect(isTradingDay(d, market)).toBe(true);
    expect(nextTradingDay("2026-12-30", market)).toBe("2026-12-31");
    expect(previousTradingDay("2027-01-04", market)).toBe("2027-01-03");
    expect(upcomingTradingDay(jst("2026-12-31", 8, 30), market)).toBe("2027-01-01");
  });

  it("臨時休場の日は、切り替えの前も後も取引日でない", () => {
    const closed = marketClosedDays(real, new Set(["2026-11-14", "2026-11-06"]));
    expect(isTradingDay("2026-11-14", closed)).toBe(false);
    expect(nextTradingDay("2026-11-13", closed)).toBe("2026-11-15");
    expect(previousTradingDay("2026-11-09", closed)).toBe("2026-11-05");
  });

  it("切り替えより後の日は祝日の一覧を引かないので、一覧の範囲の外の年でも判定できる", () => {
    expect(isTradingDay("2030-05-03", market)).toBe(true);
    expect(() => isTradingDay("2019-12-02", market)).toThrow();
  });

  it("前の取引日の境：11/10 の前は 11/9、11/9 の前は 11/6（金）。11/9 は金曜の夕方からの次の取引日", () => {
    expect(previousTradingDay("2026-11-10", market)).toBe("2026-11-09");
    expect(previousTradingDay("2026-11-09", market)).toBe("2026-11-06");
    expect(nextTradingDay("2026-11-06", market)).toBe("2026-11-09");
    expect(upcomingTradingDay(jst("2026-11-06", 16, 35), market)).toBe("2026-11-09");
    expect(upcomingTradingDay(jst("2026-11-13", 16, 35), market)).toBe("2026-11-14");
    expect(upcomingTradingDay(jst("2026-11-14", 8, 29), market)).toBe("2026-11-14");
    expect(upcomingTradingDay(jst("2026-11-14", 8, 30), market)).toBe("2026-11-15");
  });

  it("切り替えより前の判定は、東証の営業日の関数とすべて同じ（2026年の毎日と、締めの前後の時刻）", () => {
    for (const d of days("2025-12-01", "2026-11-08")) {
      expect(isTradingDay(d, market)).toBe(isBusinessDay(d, real));
      expect(nextTradingDay(d, market)).toBe(nextBusinessDay(d, real)); // 11/6〜11/8 の次は、どちらも 11/9
      expect(previousTradingDay(d, market)).toBe(previousBusinessDay(d, real));
      for (const at of [jst(d, 0), cutoffOf(d) - 1, cutoffOf(d), jst(d, 16, 35), jst(d, 23, 59)]) expect(upcomingTradingDay(at, market)).toBe(tradingDateFor(at, real));
    }
    // 切り替えの日も、締めの前後でまだ同じ
    expect(upcomingTradingDay(jst("2026-11-09", 23), market)).toBe(tradingDateFor(jst("2026-11-09", 23), real));
  });
});

describe("判断の受け付けの始まり（decisionOpensAt）", () => {
  it("前の取引日の引け（16:30）。境の日、週末、祝日、臨時休場をまたぐ", () => {
    expect(decisionOpensAt("2026-11-10", market)).toBe(jst("2026-11-09", 16, 30));
    expect(decisionOpensAt("2026-11-09", market)).toBe(jst("2026-11-06", 16, 30));
    expect(decisionOpensAt("2026-11-15", market)).toBe(jst("2026-11-14", 16, 30)); // 日曜の判断は土曜の引けから
    expect(decisionOpensAt("2026-11-04", market)).toBe(jst("2026-11-02", 16, 30)); // 切り替えより前の祝日（11/3）をまたぐ
    expect(decisionOpensAt("2026-11-15", marketClosedDays(real, new Set(["2026-11-14"])))).toBe(jst("2026-11-13", 16, 30));
    expect(decisionOpensAt("2026-11-10", market)).toBe(cutoffOf("2026-11-09") + 8 * 3_600_000);
  });
});
