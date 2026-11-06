import { describe, expect, it } from "vitest";
import { type LiquidityOrder, MAKER_PARAMS, NOISE_PARAMS, makerOrders, noiseOrders } from "../../../src/runner/world/liquidity";

// 価格は0.1円単位（1000円 = 10000）
const band = { lower: 8000, upper: 12000 };
const base = { symbol: "VRN1", fair: 10000, band, held: 1000, target: 1000, cash: 100_000_000 };
const buys = (os: LiquidityOrder[]) => os.filter((o) => o.side === "buy");
const sells = (os: LiquidityOrder[]) => os.filter((o) => o.side === "sell");
// 関数の決まりは、決まった数字で確かめる（既定の数字は値がつく日数に合わせて変えることがあるので、別の項目で確かめる）。
// 段の幅1%・3段・持ち株100株ごとに0.2%・上限3%。段の株数は数えやすいように100株
const LOGIC_MAKER = { spreadBp: 100, levels: 3, qtyPerLevel: 100, skewPerLotBp: 20, maxSkewBp: 300 };
const LOGIC_NOISE = { chance: 0.6, maxQty: 300, marketShare: 0.3, maxOffsetBp: 300, tilt: 1, minBuyChance: 0.1 };
const maker = (input: Parameters<typeof makerOrders>[0], params = LOGIC_MAKER) => makerOrders(input, params);
const noise = (input: Parameters<typeof noiseOrders>[0], params = LOGIC_NOISE) => noiseOrders(input, params);

describe("売買役の既定の数字（#139 で、値段がつく日を増やすために変えた）", () => {
  it("マーケットメイカーは0.5%ずつ3段・1段300株・中心をずらす上限は段の幅×段の数。ばらばらの参加者は毎日・95%が成行・持ち株と現金のずれで片寄る", () => {
    expect(MAKER_PARAMS).toEqual({ spreadBp: 50, levels: 3, qtyPerLevel: 300, skewPerLotBp: 20, maxSkewBp: 150 });
    expect(MAKER_PARAMS.maxSkewBp).toBe(MAKER_PARAMS.spreadBp * MAKER_PARAMS.levels);
    expect(NOISE_PARAMS).toEqual({ chance: 1, maxQty: 300, marketShare: 0.95, maxOffsetBp: 300, tilt: 1, minBuyChance: 0.1 });
  });

  it("既定の数字でも、買いの最高値は売りの最安値より低く（値幅の外では片側だけ）、ばらばらの参加者は毎日すべての銘柄に注文を出す", () => {
    for (const fair of [5000, 8100, 9000, 10000, 11900, 15000]) {
      const os = makerOrders({ symbol: "VRN1", fair, band: { lower: 8000, upper: 12000 }, held: 5000, target: 5000, cash: 500_000_000 });
      const b = os.filter((o) => o.side === "buy").map((o) => o.limit!);
      const a = os.filter((o) => o.side === "sell").map((o) => o.limit!);
      if (fair < 8000 || fair > 12000) expect([b.length, a.length].sort()).toEqual([0, 1]);
      else expect(Math.max(...b)).toBeLessThan(Math.min(...a));
    }
    const markets = ["VRN1", "ORS1", "MRH1"].map((symbol) => ({ symbol, prevPrice: 10000, band: { lower: 8000, upper: 12000 } }));
    const os = noiseOrders({ seed: 1, tradingDate: "2026-11-09", markets, holdings: { VRN1: 1000, ORS1: 1000, MRH1: 1000 }, cash: 100_000_000 });
    expect(os.map((o) => o.symbol).sort()).toEqual(["MRH1", "ORS1", "VRN1"]);
  });
});

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
  });

  it("値はすべて1円の刻みで、値幅の内側。買いの最高値は売りの最安値より必ず低い。中心が値幅の外なら、端の値段で片側だけ（自己約定しない）", () => {
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
        // どの場合も、自分の買いが自分の売りに届かない。中心（持ち株でずらしたあと。makerOrders と同じ計算）が値幅の外なら、
        // 目安に向かう側だけを端の値段に出す（上の外なら上限で売りだけ、下の外なら下限で買いだけ）
        const skew = Math.max(-LOGIC_MAKER.maxSkewBp, Math.min(LOGIC_MAKER.maxSkewBp, Math.trunc((held - base.target) / 100) * LOGIC_MAKER.skewPerLotBp));
        const center = Math.round((fair * (10_000 - skew)) / 10_000);
        const hi = Math.max(...buys(os).map((o) => o.limit!));
        const lo = Math.min(...sells(os).map((o) => o.limit!));
        if (buys(os).length > 0 && sells(os).length > 0) expect(hi, `fair ${fair} held ${held}`).toBeLessThan(lo);
        if (center > band.upper) expect(os, `fair ${fair} held ${held}`).toEqual(held > 0 ? [{ symbol: "VRN1", side: "sell", qty: 300, limit: band.upper }] : []);
        else if (center < band.lower) expect(os, `fair ${fair} held ${held}`).toEqual([{ symbol: "VRN1", side: "buy", qty: 300, limit: band.lower }]);
        else expect([buys(os).length > 0, sells(os).length > 0 || held === 0], `fair ${fair} held ${held}`).toEqual([true, true]);
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

  it("目安の価格が値幅より上なら上限の値段で売りだけ、下なら下限の値段で買いだけ（目安に向かう側だけ。自己約定しない。押しつけられた段はまとめる）", () => {
    expect(maker({ ...base, fair: 20000 })).toEqual([{ symbol: "VRN1", side: "sell", qty: 300, limit: 12000 }]);
    expect(maker({ ...base, fair: 5000 })).toEqual([{ symbol: "VRN1", side: "buy", qty: 300, limit: 8000 }]);
    // 売る株がなければ、上の外では何も出さない（反対の側は出さない）。現金がなければ、下の外では何も出さない
    expect(maker({ ...base, fair: 20000, held: 0 })).toEqual([]);
    expect(maker({ ...base, fair: 5000, cash: 0 })).toEqual([]);
  });

  it("売りは持っている株数まで、買いは指値 × 株数の合計が現金を超えない分まで", () => {
    expect(sells(maker({ ...base, held: 200, target: 200 })).map((o) => o.qty)).toEqual([100, 100]);
    expect(sells(maker({ ...base, held: 0, target: 0 }))).toEqual([]);
    // 目安が値幅の下限より下でも、売る株がなければ買いを外さない（値幅の下限で買う）
    expect(maker({ ...base, fair: 5000, held: 0, target: 0 })).toEqual([{ symbol: "VRN1", side: "buy", qty: 300, limit: 8000 }]);
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
    expect(noise(input)).toEqual(noise(input));
    expect(noise({ ...input, markets: [...markets].reverse() })).toEqual(noise(input));
    const days = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"].map((tradingDate) => JSON.stringify(noise({ ...input, tradingDate })));
    expect(new Set(days).size).toBe(days.length);
    expect(noise({ ...input, seed: 8 })).not.toEqual(noise(input));
  });

  it("株数は100株単位で上限まで、指値は前日の価格 ±3% の1円刻みで値幅の内側、成行も指値もある", () => {
    const all = Array.from({ length: 60 }, (_, i) => noise({ ...input, tradingDate: `2026-12-${String((i % 28) + 1).padStart(2, "0")}`, seed: i })).flat();
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
      expect(sells(noise({ ...input, seed, holdings: {} }))).toEqual([]);
      const cash = 2_500_000;
      const os = noise({ ...input, seed, cash });
      expect(buys(os).reduce((a, o) => a + (o.limit ?? band.upper) * o.qty, 0)).toBeLessThanOrEqual(cash);
    }
    expect(buys(noise({ ...input, cash: 0 }))).toEqual([]);
  });

  it("最初の持ち株と現金からのずれで、売りと買いを片寄らせる（株が減れば買い、現金が減れば売りが多い）。乱数の部分は残る", () => {
    const baseline = { shares: Object.fromEntries(markets.map((m) => [m.symbol, 1000])), cash: 100_000_000 };
    const share = (h: number, cash: number, base: typeof baseline | null = baseline) => {
      let b = 0;
      let n = 0;
      for (let seed = 0; seed < 200; seed++)
        for (const o of noise({ ...input, seed, holdings: Object.fromEntries(markets.map((m) => [m.symbol, h])), cash, ...(base ? { baseline: base } : {}) }, { ...LOGIC_NOISE, chance: 1 })) {
          n++;
          if (o.side === "buy") b++;
        }
      return b / n;
    };
    const even = share(1000, 100_000_000);
    expect(even).toBeGreaterThan(0.4);
    expect(even).toBeLessThan(0.6);
    // 株が半分に減った：買いの確率は 0.5 + 0.5 = 1 → 上限の 0.9
    expect(share(500, 100_000_000)).toBeGreaterThan(0.85);
    // 現金が4割減った：買いの確率は 0.5 − 0.4 = 0.1（下限）。売りが多い（買いは乱数で少し残る）
    const poor = share(1000, 60_000_000);
    expect(poor).toBeLessThan(0.15);
    expect(poor).toBeGreaterThan(0);
    // 基準を渡さなければ片寄らせない（半々）
    // 最初の持ち株がない銘柄（あとから上場した企業など）は、株の減り方を0とみなす（持ち株0でも買いに張り付かない）
    const notAllotted = share(500, 100_000_000, { shares: {}, cash: 100_000_000 });
    expect(notAllotted).toBeGreaterThan(0.4);
    expect(notAllotted).toBeLessThan(0.6);
    const none = share(500, 100_000_000, null);
    expect(none).toBeGreaterThan(0.4);
    expect(none).toBeLessThan(0.6);
  });

  it("銘柄を外しても、ほかの銘柄の注文は変わらない（乱数の列は銘柄ごと）", () => {
    for (let seed = 0; seed < 10; seed++) {
      const all = noise({ ...input, seed });
      for (const gone of markets.map((m) => m.symbol)) {
        const without = noise({ ...input, seed, markets: markets.filter((m) => m.symbol !== gone) });
        expect(without).toEqual(all.filter((o) => o.symbol !== gone));
      }
    }
  });

  it("おかしな入力は受け付けない（重複した銘柄、刻みに合わない値幅、100株単位でない上限）", () => {
    expect(() => noise({ ...input, markets: [...markets, markets[0]!] })).toThrow("duplicate");
    expect(() => noise({ ...input, markets: [{ ...markets[0]!, band: { lower: 8005, upper: 12000 } }] })).toThrow("band");
    expect(() => noiseOrders(input, { chance: 1, maxQty: 250, marketShare: 0, maxOffsetBp: 0, tilt: 0, minBuyChance: 0 })).toThrow("maxQty");
  });
});
