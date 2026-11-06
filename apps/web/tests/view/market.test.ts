import { describe, expect, it } from "vitest";
import type { LogEvent } from "../../src/events/types";
import { buildView } from "../../src/view/build";
import { formatPeriod, formatPlainYen } from "../../src/view/format";
import { buildMarket, NO_PRICE_TEXT } from "../../src/view/market";

let n = 0;
const ev = (type: LogEvent["type"], payload: object, at: number): LogEvent => ({ seq: ++n, schema: 1, type, recordedAt: at, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" });
const T = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const listed = (symbol: string, name: string, price: number, at = T("2026-11-06", 12)) => ev("company.listed", { symbol, name, sector: "機械", sharesOutstanding: 1_000_000, price }, at);
const cleared = (symbol: string, date: string, price: number | null, volume: number) => ev("auction.cleared", { symbol, date, price, volume, refSeq: 1, sheetSeqs: [] }, T(date, 9));

describe("書式", () => {
  it("円の整数と四半期", () => {
    expect(formatPlainYen(1_234_567)).toBe("¥1,234,567");
    expect(formatPlainYen(-9_000)).toBe("-¥9,000");
    expect(formatPlainYen(0)).toBe("¥0");
    expect(() => formatPlainYen(0.5)).toThrow();
    expect(formatPeriod("2026-Q4")).toBe("2026年 第4四半期");
    expect(formatPeriod("変な値")).toBe("変な値");
  });
});

describe("buildMarket（手で組んだ小さな記録）", () => {
  n = 0;
  const events = [
    listed("NEO2", "ネオ精機", 20_000), // 1
    listed("NEO1", "アーク工業", 12_500), // 2（銘柄コード順に並ぶ）
    cleared("NEO1", "2026-11-09", 12_900, 1_200), // 3
    cleared("NEO1", "2026-11-10", null, 0), // 4 値つかず
    cleared("NEO1", "2026-11-11", null, 0), // 5 2日続けて値つかず
    cleared("NEO1", "2026-11-12", 12_000, 300), // 6
    ev("company.disclosed", { symbol: "NEO1", period: "2026-Q3", revenue: 1_200_000_000, netIncome: -30_000_000, eps: -30, dividendPerShare: 0 }, T("2026-11-09", 15, 30)), // 7
    ev("company.disclosed", { symbol: "NEO1", period: "2026-Q4", revenue: 1_500_000_000, netIncome: 80_000_000, eps: 800, dividendPerShare: 50 }, T("2026-11-12", 15, 30)), // 8
    ev("company.disclosed", { symbol: "NEO2", period: "2026-Q4", revenue: 1, netIncome: 1, eps: 1, dividendPerShare: 0 }, T("2026-11-12", 15, 30)), // 9
  ];
  const market = buildMarket([...events].reverse()); // 入力の順序に依らず seq 順
  const neo1 = market.companies.find((c) => c.listing.symbol === "NEO1")!;

  it("銘柄は銘柄コード順。上場の記録をそのまま写す", () => {
    expect(market.companies.map((c) => c.listing.symbol)).toEqual(["NEO1", "NEO2"]);
    expect(neo1.listing).toMatchObject({ name: "アーク工業", sector: "機械", sharesText: "1,000,000株", listedPrice: 12_500, listedPriceText: "¥1,250", listedOn: "11/06" });
  });

  it("板寄せの日ごとに、価格・出来高。価格がつかなかった日は『値つかず』で、直近の価格を添える", () => {
    expect(neo1.days.map((d) => [d.dateText, d.priceText, d.volumeText, d.carriedText])).toEqual([
      ["11/09", "¥1,290", "1,200株", null],
      ["11/10", NO_PRICE_TEXT, "0株", "¥1,290"],
      ["11/11", NO_PRICE_TEXT, "0株", "¥1,290"], // 前の日も値つかず。記録にある直近の価格
      ["11/12", "¥1,200", "300株", null],
    ]);
    expect(neo1.days.map((d) => d.price)).toEqual([12_900, null, null, 12_000]);
  });

  it("上場の直後に値つかずなら、上場の価格を添える。板寄せのない銘柄は空", () => {
    n = 0;
    const m = buildMarket([listed("NEO1", "あ", 5_000), cleared("NEO1", "2026-11-09", null, 0), listed("NEO3", "い", 100)]);
    expect(m.companies[0]!.days[0]).toMatchObject({ priceText: NO_PRICE_TEXT, carriedText: "¥500" });
    expect(m.companies[1]!.days).toEqual([]);
  });

  it("決算は最新が上。売上・純利益は円、1株利益と配当は0.1円単位の値を写す", () => {
    expect(neo1.disclosures.map((d) => [d.periodText, d.revenueText, d.netIncomeText, d.epsText, d.dividendText, d.atText])).toEqual([
      ["2026年 第4四半期", "¥1,500,000,000", "¥80,000,000", "¥80", "¥5", "11/12 15:30"],
      ["2026年 第3四半期", "¥1,200,000,000", "-¥30,000,000", "-¥3", "¥0", "11/09 15:30"],
    ]);
  });

  it("上場していない銘柄の板寄せ・決算は無視し、記録がなければ空", () => {
    n = 0;
    expect(buildMarket([cleared("X", "2026-11-09", 1000, 1), ev("company.disclosed", { symbol: "X", period: "2026-Q1", revenue: 1, netIncome: 1, eps: 1, dividendPerShare: 0 }, 0)]).companies).toEqual([]);
    expect(buildMarket([]).companies).toEqual([]);
  });
});

describe("buildView：市場の記録と参加者の種類", () => {
  it("市場の記録を持ち、参加者の種類を写す（種類のない登録はAI投資家）", () => {
    n = 0;
    const reg = (id: string, kind?: string) => ev("agent.registered", { agentId: id, displayName: id, startDate: "2026-11-09", initialCash: 1000, ...(kind ? { kind } : {}) }, 0);
    const v = buildView([listed("NEO1", "あ", 5_000), reg("ai-b"), reg("mm-1", "market_maker"), reg("noise", "noise"), reg("ai-a", "investor")], () => undefined);
    expect(v.market.companies).toHaveLength(1);
    expect(v.participants).toEqual([{ agentId: "ai-a", kind: "investor" }, { agentId: "ai-b", kind: "investor" }, { agentId: "mm-1", kind: "market_maker" }, { agentId: "noise", kind: "noise" }]);
  });
});
