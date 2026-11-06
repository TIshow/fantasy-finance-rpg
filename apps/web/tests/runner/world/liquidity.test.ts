import { describe, expect, it } from "vitest";
import { type LiquidityOrder, MAKER_PARAMS, makerOrders, noiseOrders } from "../../../src/runner/world/liquidity";

// 価格は0.1円単位（1000円 = 10000）
const band = { lower: 8000, upper: 12000 };
const base = { symbol: "VRN1", fair: 10000, band, held: 1000, target: 1000, cash: 100_000_000 };
const buys = (os: LiquidityOrder[]) => os.filter((o) => o.side === "buy");
const sells = (os: LiquidityOrder[]) => os.filter((o) => o.side === "sell");
// 段の株数は既定の300株（#113 の lead の決定）。ここでは数えやすいように100株で確かめる
const maker = (input: Parameters<typeof makerOrders>[0], params = { ...MAKER_PARAMS, qtyPerLevel: 100 }) => makerOrders(input, params);

describe("マーケットメイカーの注文", () => {
  it("目安の価格のまわりに、1%ずつ離した買いと売りの指値を3段ずつ出す（買いは切り下げ、売りは切り上げ）", () => {
    expect(maker({ ...base, fair: 10005 })).toEqual([
      { symbol: "VRN1", side: "sell", qty: 100, limit: 10110 },
      { symbol: "VRN1", side: "sell", qty: 100, limit: 10210 },
      { symbol: "VRN1", side: "sell", qty: 100, limit: 10310 },
      { symbol: "VRN1", side: "buy", qty: 100, limit: 9900 },
      { symbol: "VRN1", side: "buy", qty: 100, limit: 9800 },
      { symbol: "VRN1", side: "buy", qty: 100, limit: 9700 },
    ]);
  });

  it("持ち株が目標より多ければ値段を下げ、少なければ上げる。ずらす幅には上限がある", () => {
    const mid = (os: LiquidityOrder[]) => (buys(os)[0]!.limit! + sells(os)[0]!.limit!) / 2;
    const even = mid(maker(base));
    expect(mid(maker({ ...base, held: 2000 }))).toBeLessThan(even);
    expect(mid(maker({ ...base, held: 500 }))).toBeGreaterThan(even);
    // 上限：中心は目安から 3% まで（多すぎても少なすぎても）
    expect(buys(maker({ ...base, held: 100_000 }))[0]!.limit).toBe(9600);
    expect(sells(maker({ ...base, held: 0, target: 100_000, cash: 1e12 }))).toEqual([]);
    expect(buys(maker({ ...base, held: 0, target: 100_000 }))[0]!.limit).toBe(10190); // 中心 10300 の 1% 下を切り下げ
    expect(MAKER_PARAMS.maxSkewBp).toBe(MAKER_PARAMS.spreadBp * MAKER_PARAMS.levels);
    expect(MAKER_PARAMS.qtyPerLevel).toBe(300);
  });

  it("値はすべて1円の刻みで、値幅の内側。買いの最高値は売りの最安値より低い（自分どうしで約定しない）", () => {
    for (const fair of [5000, 7990, 8000, 9000, 10000, 11900, 12000, 15000]) {
      for (const held of [0, 300, 1000, 5000]) {
        const os = maker({ ...base, fair, held });
        for (const o of os) {
          expect(o.limit! % 10).toBe(0);
          expect(o.limit!).toBeGreaterThanOrEqual(band.lower);
          expect(o.limit!).toBeLessThanOrEqual(band.upper);
          expect(o.qty % 100).toBe(0);
          expect(o.qty).toBeGreaterThan(0);
        }
        const hi = Math.max(...buys(os).map((o) => o.limit!));
        const lo = Math.min(...sells(os).map((o) => o.limit!));
        expect(hi).toBeLessThan(lo);
      }
    }
  });

  it("低い価格で値幅が狭くても、買いと売りは重ならない。刻みは整数で計算する（丸めの誤差で1刻み広がらない）", () => {
    expect(maker({ ...base, fair: 15, band: { lower: 10, upper: 20 } })).toEqual([
      { symbol: "VRN1", side: "sell", qty: 300, limit: 20 },
      { symbol: "VRN1", side: "buy", qty: 300, limit: 10 },
    ]);
    // 中心 × (1 ± 段の幅) がちょうど刻みに乗るときは、その値段（浮動小数で計算すると、切り上げで1刻みずれることがあった）
    const os = maker({ ...base, fair: 25000, band: { lower: 20000, upper: 30000 } });
    expect(os.map((o) => o.limit)).toEqual([25250, 25500, 25750, 24750, 24500, 24250]);
    expect(() => maker({ ...base, fair: Number.NaN })).toThrow();
    expect(() => maker({ ...base, band: { lower: 12000, upper: 8000 } })).toThrow("band");
  });

  it("目安の価格が値幅より上なら、上限で買うだけ。下なら、下限で売るだけ（押しつけられた段はまとめる）", () => {
    expect(maker({ ...base, fair: 20000 })).toEqual([{ symbol: "VRN1", side: "buy", qty: 300, limit: 12000 }]);
    expect(maker({ ...base, fair: 5000 })).toEqual([{ symbol: "VRN1", side: "sell", qty: 300, limit: 8000 }]);
  });

  it("売りは持っている株数まで、買いは指値 × 株数の合計が現金を超えない分まで", () => {
    expect(sells(maker({ ...base, held: 200, target: 200 })).map((o) => o.qty)).toEqual([100, 100]);
    expect(sells(maker({ ...base, held: 0, target: 0 }))).toEqual([]);
    const poor = maker({ ...base, cash: 9900 * 100 + 9800 * 100 + 5 });
    expect(buys(poor).map((o) => [o.limit, o.qty])).toEqual([[9900, 100], [9800, 100]]);
    expect(buys(maker({ ...base, cash: 0 }))).toEqual([]);
  });
});

describe("ばらばらに売買する参加者の注文", () => {
  const markets = ["VRN1", "ORS1", "MRH1", "SLN1", "QON1", "LPO1"].map((symbol) => ({ symbol, prevPrice: 10000, band }));
  const holdings = Object.fromEntries(markets.map((m) => [m.symbol, 1000]));
  const input = { seed: 7, tradingDate: "2026-11-09", markets, holdings, cash: 100_000_000 };

  it("同じシードと日なら同じ注文、日やシードが違えば違う注文。銘柄の並べ方では変わらない", () => {
    expect(noiseOrders(input)).toEqual(noiseOrders(input));
    expect(noiseOrders({ ...input, markets: [...markets].reverse() })).toEqual(noiseOrders(input));
    const days = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"].map((tradingDate) => JSON.stringify(noiseOrders({ ...input, tradingDate })));
    expect(new Set(days).size).toBe(days.length);
    expect(noiseOrders({ ...input, seed: 8 })).not.toEqual(noiseOrders(input));
  });

  it("株数は100株単位で上限まで、指値は前日の価格 ±3% の1円刻みで値幅の内側、成行も指値もある", () => {
    const all = Array.from({ length: 60 }, (_, i) => noiseOrders({ ...input, tradingDate: `2026-12-${String((i % 28) + 1).padStart(2, "0")}`, seed: i })).flat();
    expect(all.length).toBeGreaterThan(100);
    for (const o of all) {
      expect(o.qty % 100).toBe(0);
      expect(o.qty).toBeGreaterThan(0);
      expect(o.qty).toBeLessThanOrEqual(300);
      if (o.limit !== null) {
        expect(o.limit % 10).toBe(0);
        expect(Math.abs(o.limit - 10000)).toBeLessThanOrEqual(300);
      }
    }
    const market = all.filter((o) => o.limit === null).length / all.length;
    expect(market).toBeGreaterThan(0.15);
    expect(market).toBeLessThan(0.45);
    expect(buys(all).length).toBeGreaterThan(all.length * 0.3);
    expect(sells(all).length).toBeGreaterThan(all.length * 0.3);
  });

  it("持っていない銘柄は売らない。買いは指値（成行は値幅の上限）× 株数の合計が現金を超えない", () => {
    for (let seed = 0; seed < 40; seed++) {
      expect(sells(noiseOrders({ ...input, seed, holdings: {} }))).toEqual([]);
      const cash = 2_500_000;
      const os = noiseOrders({ ...input, seed, cash });
      expect(buys(os).reduce((a, o) => a + (o.limit ?? band.upper) * o.qty, 0)).toBeLessThanOrEqual(cash);
    }
    expect(buys(noiseOrders({ ...input, cash: 0 }))).toEqual([]);
  });

  it("銘柄を外しても、ほかの銘柄の注文は変わらない（乱数の列は銘柄ごと）", () => {
    for (let seed = 0; seed < 10; seed++) {
      const all = noiseOrders({ ...input, seed });
      for (const gone of markets.map((m) => m.symbol)) {
        const without = noiseOrders({ ...input, seed, markets: markets.filter((m) => m.symbol !== gone) });
        expect(without).toEqual(all.filter((o) => o.symbol !== gone));
      }
    }
  });

  it("おかしな入力は受け付けない（重複した銘柄、刻みに合わない値幅、100株単位でない上限）", () => {
    expect(() => noiseOrders({ ...input, markets: [...markets, markets[0]!] })).toThrow("duplicate");
    expect(() => noiseOrders({ ...input, markets: [{ ...markets[0]!, band: { lower: 8005, upper: 12000 } }] })).toThrow("band");
    expect(() => noiseOrders(input, { chance: 1, maxQty: 250, marketShare: 0, maxOffsetBp: 0 })).toThrow("maxQty");
  });
});
