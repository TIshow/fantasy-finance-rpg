import { describe, expect, it } from "vitest";
import { type LiquidityOrder, MAKER_PARAMS, NOISE_PARAMS, dayFair, makerOrders, noiseOrders } from "../../../src/runner/world/liquidity";

// 価格は0.1円単位（1000円 = 10000）
const band = { lower: 8000, upper: 12000 };
const base = { symbol: "VRN1", fair: 10000, band, held: 1000, target: 1000, cash: 100_000_000 };
const buys = (os: LiquidityOrder[]) => os.filter((o) => o.side === "buy");
const sells = (os: LiquidityOrder[]) => os.filter((o) => o.side === "sell");
// 関数の決まりは、決まった数字で確かめる（既定の数字は値がつく日数に合わせて変えることがあるので、別の項目で確かめる）。
// 段の幅1%・3段・持ち株100株ごとに0.2%・上限3%。段の株数は数えやすいように100株
const LOGIC_MAKER = { spreadBp: 100, levels: 3, qtyPerLevel: 100, skewPerLotBp: 20, maxSkewBp: 300 };
const LOGIC_NOISE = { chance: 0.6, maxQty: 300, marketShare: 0.3, maxOffsetBp: 300, tilt: 1, minBuyChance: 0.1, edgeBuyChance: 0.9 };
const maker = (input: Parameters<typeof makerOrders>[0], params = LOGIC_MAKER) => makerOrders(input, params);
const noise = (input: Parameters<typeof noiseOrders>[0], params = LOGIC_NOISE) => noiseOrders(input, params);

describe("売買役の既定の数字（#139 で、値段がつく日を増やすために変えた）", () => {
  it("マーケットメイカーは0.5%ずつ3段・1段300株・中心をずらす上限は段の幅×段の数。ばらばらの参加者は毎日・95%が成行・持ち株と現金のずれで片寄る", () => {
    expect(MAKER_PARAMS).toEqual({ spreadBp: 50, levels: 3, qtyPerLevel: 300, skewPerLotBp: 20, maxSkewBp: 150 });
    expect(MAKER_PARAMS.maxSkewBp).toBe(MAKER_PARAMS.spreadBp * MAKER_PARAMS.levels);
    expect(NOISE_PARAMS).toEqual({ chance: 1, maxQty: 300, marketShare: 0.95, maxOffsetBp: 300, tilt: 1, minBuyChance: 0.1, edgeBuyChance: 0.9 });
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

  it("値はすべて1円の刻みで、値幅の内側。買いの最高値は売りの最安値より必ず低い。目安が値幅の外なら、端の値段で片側だけ（自己約定しない）", () => {
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
        // どの場合も、自分の買いが自分の売りに届かない。目安の価格が値幅の外（端の日）なら、目安に向かう側だけを端の値段に出す
        // （上の外なら上限で売りだけ、下の外なら下限で買いだけ）。端の日でなければ、売りと買いの両方を出す（売る株がなければ買いだけ）
        const hi = Math.max(...buys(os).map((o) => o.limit!));
        const lo = Math.min(...sells(os).map((o) => o.limit!));
        if (buys(os).length > 0 && sells(os).length > 0) expect(hi, `fair ${fair} held ${held}`).toBeLessThan(lo);
        if (fair > band.upper) expect(os, `fair ${fair} held ${held}`).toEqual(held > 0 ? [{ symbol: "VRN1", side: "sell", qty: 300, limit: band.upper }] : []);
        else if (fair < band.lower) expect(os, `fair ${fair} held ${held}`).toEqual([{ symbol: "VRN1", side: "buy", qty: 300, limit: band.lower }]);
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

  it("目安の価格が値幅の内側なら、持ち株でずらした中心が値幅の外に出ても、中心を値幅の内側に収めて売りと買いの両方を出す（端の日ではない）", () => {
    // 目安 11900（上限 12000 の内側）。持ち株が目標より 1,500株少ない → 中心は 3% 上の 12257（上限の外）
    const up = maker({ ...base, fair: 11900, held: 0, target: 1500, cash: 1e12 }, { ...LOGIC_MAKER, qtyPerLevel: 100 });
    expect(sells(up)).toEqual([]); // 売る株がない
    expect(buys(up).length).toBeGreaterThan(0);
    const up2 = maker({ ...base, fair: 11900, held: 300, target: 1800 });
    expect(sells(up2).map((o) => o.limit)).toEqual([12000]);
    expect(buys(up2).length).toBeGreaterThan(0);
    expect(Math.max(...buys(up2).map((o) => o.limit!))).toBeLessThan(12000);
    // 目安 8100（下限 8000 の内側）。持ち株が目標より多い → 中心は 3% 下の 7857（下限の外）
    const down = maker({ ...base, fair: 8100, held: 5000, target: 1000 });
    expect(buys(down).map((o) => o.limit)).toEqual([8000]);
    expect(sells(down).length).toBeGreaterThan(0);
    expect(Math.min(...sells(down).map((o) => o.limit!))).toBeGreaterThan(8000);
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

describe("ふだんの日の注文は、#139 の端の日の変更の前と同じ（変更の前のコード milestone/139-market-daily 7e297e4 の出力で確かめた値）", () => {
  const b = { lower: 8000, upper: 12000 };
  it("マーケットメイカー（既定の数字）", () => {
    const m = (fair: number, held: number) => makerOrders({ symbol: "VRN1", fair, band: b, held, target: 5000, cash: 500_000_000 });
    const o = (side: "buy" | "sell", limit: number) => ({ symbol: "VRN1", side, qty: 300, limit });
    expect(m(10005, 5200)).toEqual([o("sell", 10020), o("sell", 10070), o("sell", 10120), o("buy", 9910), o("buy", 9860), o("buy", 9810)]);
    expect(m(9000, 4800)).toEqual([o("sell", 9090), o("sell", 9130), o("sell", 9180), o("buy", 8990), o("buy", 8940), o("buy", 8900)]);
    expect(m(11800, 5000)).toEqual([o("sell", 11860), o("sell", 11920), o("sell", 11980), o("buy", 11740), o("buy", 11680), o("buy", 11620)]);
  });
  it("ばらばらの参加者（既定の数字、端の日なし）", () => {
    const markets = ["VRN1", "ORS1", "MRH1"].map((symbol) => ({ symbol, prevPrice: 10000, band: b }));
    const baseline = { shares: { VRN1: 1000, ORS1: 1000, MRH1: 1000 }, cash: 300_000_000 };
    expect(noiseOrders({ seed: 20261106, tradingDate: "2026-11-09", markets, holdings: { VRN1: 1000, ORS1: 800, MRH1: 1300 }, cash: 290_000_000, baseline })).toEqual([
      { symbol: "MRH1", side: "sell", qty: 200, limit: null },
      { symbol: "ORS1", side: "buy", qty: 100, limit: null },
      { symbol: "VRN1", side: "sell", qty: 200, limit: null },
    ]);
    expect(noiseOrders({ seed: 7, tradingDate: "2026-12-01", markets, holdings: { VRN1: 500, ORS1: 1000, MRH1: 1000 }, cash: 310_000_000, baseline })).toEqual([
      { symbol: "MRH1", side: "buy", qty: 100, limit: null },
      { symbol: "ORS1", side: "buy", qty: 300, limit: null },
      { symbol: "VRN1", side: "sell", qty: 300, limit: null },
    ]);
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

  describe("値幅の端の日（#139 の lead の決定、案1）", () => {
    const baseline = { shares: Object.fromEntries(markets.map((m) => [m.symbol, 1000])), cash: 100_000_000 };
    /** 全銘柄を同じ端の日にして、200通りの種で注文を集める */
    const collect = (edge: "upper" | "lower" | undefined, over: Partial<typeof input> = {}) =>
      Array.from({ length: 200 }, (_, seed) => noise({ ...input, seed, baseline, markets: markets.map((m) => ({ ...m, ...(edge ? { edge } : {}) })), ...over }, { ...LOGIC_NOISE, chance: 1 })).flat();
    const buyShare = (os: LiquidityOrder[]) => buys(os).length / os.length;

    it("上限の外の日は買いを多く、下限の外の日は売りを多く出す。持ち株と現金のずれ（tilt）より優先する", () => {
      // 持ち株が最初より4割多く、現金が4割少ない：ふだんの日なら買いの確率は下限の0.1
      const heavy = { holdings: Object.fromEntries(markets.map((m) => [m.symbol, 1400])), cash: 60_000_000 };
      expect(buyShare(collect(undefined, heavy))).toBeLessThan(0.15);
      expect(buyShare(collect("upper", heavy))).toBeGreaterThan(0.85);
      // 持ち株が最初より少なく、現金が多い：ふだんの日なら買いが多いが、下限の外の日は売りが多い
      const light = { holdings: Object.fromEntries(markets.map((m) => [m.symbol, 600])), cash: 100_000_000 };
      expect(buyShare(collect(undefined, light))).toBeGreaterThan(0.85);
      expect(buyShare(collect("lower", light))).toBeLessThan(0.15);
    });

    it("端の日でも、持っていない株は売らず、現金を超えて買わない", () => {
      expect(sells(collect("lower", { holdings: {} }))).toEqual([]);
      expect(buys(collect("upper", { cash: 0 }))).toEqual([]);
      for (let seed = 0; seed < 40; seed++) {
        const cash = 2_500_000;
        const os = noise({ ...input, seed, cash, baseline, markets: markets.map((m) => ({ ...m, edge: "upper" as const })) });
        expect(buys(os).reduce((a, o) => a + (o.limit ?? band.upper) * o.qty, 0)).toBeLessThanOrEqual(cash);
      }
    });

    it("端の日の銘柄より銘柄コードの順で前の銘柄の注文は、変わらない（現金は銘柄コードの順に使うので、後の銘柄は変わりうる）", () => {
      for (let seed = 0; seed < 20; seed++) {
        const normal = noise({ ...input, seed, baseline });
        // VRN1 は銘柄コードの順で最後
        const oneEdge = noise({ ...input, seed, baseline, markets: markets.map((m) => (m.symbol === "VRN1" ? { ...m, edge: "upper" as const } : m)) });
        expect(oneEdge.filter((o) => o.symbol !== "VRN1")).toEqual(normal.filter((o) => o.symbol !== "VRN1"));
      }
    });
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
    expect(() => noiseOrders(input, { chance: 1, maxQty: 250, marketShare: 0, maxOffsetBp: 0, tilt: 0, minBuyChance: 0, edgeBuyChance: 0.5 })).toThrow("maxQty");
  });
});

describe("dayFair（前の営業日に値段がつかなかった銘柄では、目安の価格を値幅の中まで寄せる。#139 の lead の決定）", () => {
  it("前の営業日に値段がつかず、目安が値幅の外なら、いちばん近い値幅の端まで寄せ、寄せる前の価格を返す", () => {
    expect(dayFair(3000, band, true)).toEqual({ fair: 8000, pulledFrom: 3000 });
    expect(dayFair(30000, band, true)).toEqual({ fair: 12000, pulledFrom: 30000 });
  });

  it("前の営業日に値段がついていれば、目安が値幅の外でも寄せない（業績から出した価格のまま）", () => {
    expect(dayFair(3000, band, false)).toEqual({ fair: 3000, pulledFrom: null });
    expect(dayFair(30000, band, false)).toEqual({ fair: 30000, pulledFrom: null });
  });

  it("目安が値幅の中（端を含む）なら、前の営業日に値段がつかなくても寄せない", () => {
    for (const fair of [8000, 10005, 12000]) expect(dayFair(fair, band, true)).toEqual({ fair, pulledFrom: null });
  });

  it("寄せた価格は値幅の中で、値幅の端の日にならないので、マーケットメイカーは売りと買いの両方を出し、自分どうしで約定しない", () => {
    for (const [base, held] of [[3000, 5000], [3000, 6500], [30000, 5000], [30000, 3500]] as const) {
      const { fair } = dayFair(base, band, true);
      expect(fair).toBeGreaterThanOrEqual(band.lower);
      expect(fair).toBeLessThanOrEqual(band.upper);
      const os = makerOrders({ symbol: "VRN1", fair, band, held, target: 5000, cash: 500_000_000 });
      expect(buys(os).length).toBeGreaterThan(0);
      expect(sells(os).length).toBeGreaterThan(0);
      expect(Math.max(...buys(os).map((o) => o.limit!))).toBeLessThan(Math.min(...sells(os).map((o) => o.limit!)));
    }
  });

  it("入力の検査（値幅が刻みに合わない・目安が負）", () => {
    expect(() => dayFair(3000, { lower: 8005, upper: 12000 }, true)).toThrow("band");
    expect(() => dayFair(-1, band, true)).toThrow("fair");
  });
});
