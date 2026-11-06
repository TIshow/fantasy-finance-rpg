// 板寄せ（docs/MARKET_DESIGN.md §3、#110）。手で数えた小さな板と、乱数で作った板の性質。
import { describe, expect, it } from "vitest";
import { priceBand, runAuction, TICK, type AuctionOrder, type AuctionResult } from "../../src/ledger/auction";
import { mulberry32, pick, randInt } from "../fixtures/prng";

/** 円を 0.1円単位にする */
const yen = (n: number) => n * 10;
let nextSeq = 1;
/** 注文票1枚に1つの注文。t は確定時刻（小さいほど早い） */
const order = (side: "buy" | "sell", qty: number, limitYen: number | null, t = 0): AuctionOrder => ({ sheetSeq: nextSeq++, index: 0, committedAt: 1_000 + t, side, qty, limit: limitYen === null ? null : yen(limitYen) });
const run = (prevYen: number, orders: AuctionOrder[]) => runAuction({ symbol: "NEO1", prevPrice: yen(prevYen), orders });
/** 各注文の [約定量, 理由] */
const summary = (r: AuctionResult) => r.fills.map((f) => [f.qty, f.reason ?? null]);

describe("値幅", () => {
  it("前日の価格の ±20% と ±1円の広いほうを、呼値（1円）に合わせて内側に丸める。下限は1円", () => {
    expect(priceBand(yen(1000))).toEqual({ lower: yen(800), upper: yen(1200) });
    expect(priceBand(yen(7))).toEqual({ lower: yen(6), upper: yen(8) });
    expect(priceBand(10005)).toEqual({ lower: yen(801), upper: yen(1200) });
    expect(() => priceBand(0)).toThrow();
    expect(() => priceBand(100_000_000 * 10 + 1)).toThrow();
    // 安い価格では ±1円のほうが広い（#110 の lead の決定）。5円は ±20% と ±1円が同じ
    expect(priceBand(yen(5))).toEqual({ lower: yen(4), upper: yen(6) });
    expect(priceBand(yen(4))).toEqual({ lower: yen(3), upper: yen(5) });
    expect(priceBand(yen(3))).toEqual({ lower: yen(2), upper: yen(4) });
    // 1円より下がらない
    expect(priceBand(yen(1))).toEqual({ lower: yen(1), upper: yen(2) });
    expect(priceBand(8)).toEqual({ lower: yen(1), upper: yen(1) });
    expect(priceBand(15)).toEqual({ lower: yen(1), upper: yen(2) });
    expect(priceBand(45)).toEqual({ lower: yen(4), upper: yen(5) });
  });
});

describe("手で数えた板", () => {
  it("約定量が最大の価格のうち、前日に近いものを選び、余った買いは成行 → 指値の順に回す", () => {
    // 1000〜1010円で 買い500・売り400 → 約定量400（最大）。前日の1000円に最も近い1000円
    const r = run(1000, [order("buy", 300, 1010, 1), order("buy", 200, null, 2), order("sell", 200, 990, 1), order("sell", 200, 1000, 2), order("sell", 300, 1020, 3)]);
    expect(r.price).toBe(yen(1000));
    expect(r.volume).toBe(400);
    expect(summary(r)).toEqual([[200, "outmatched"], [200, null], [200, null], [200, null], [0, "limit_not_reached"]]);
    expect(r.fills.map((f) => f.status)).toEqual(["reduced", "filled", "filled", "filled", "expired"]);
  });

  it("約定量が並べば、前日に近いことより、余りが小さいことを先に見る", () => {
    // 990〜1010円はどこも約定量200。1000円以下は買いが100余り、1001円以上は余りなし → 1001円
    const r = run(1000, [order("buy", 200, 1010), order("sell", 200, 990), order("buy", 100, 1000)]);
    expect(r.price).toBe(yen(1001));
    expect(summary(r)).toEqual([[200, null], [200, null], [0, "limit_not_reached"]]);
  });

  it("余りも並べば前日に近い価格、それも並べば低い価格", () => {
    expect(run(1000, [order("buy", 100, 1010), order("sell", 100, 1002)]).price).toBe(yen(1002));
    expect(run(1000, [order("buy", 100, 1010), order("sell", 100, 990)]).price).toBe(yen(1000));
    // 前日 1000.5円：1000円と1001円が同じ近さ → 低い1000円
    expect(runAuction({ symbol: "NEO1", prevPrice: 10005, orders: [order("buy", 100, 1010), order("sell", 100, 990)] }).price).toBe(yen(1000));
  });

  it("成行どうしは前日の価格で約定する", () => {
    const r = run(1000, [order("buy", 300, null), order("sell", 200, null)]);
    expect(r.price).toBe(yen(1000));
    expect(summary(r)).toEqual([[200, "outmatched"], [200, null]]);
  });

  it("約定量が0なら価格はつかず、注文はすべて失効する", () => {
    const r = run(1000, [order("buy", 100, 950), order("sell", 100, 1050)]);
    expect(r).toMatchObject({ price: null, volume: 0 });
    expect(summary(r)).toEqual([[0, "no_price"], [0, "no_price"]]);
    expect(run(1000, []).price).toBeNull();
  });

  it("値幅の外では約定しない", () => {
    expect(run(1000, [order("buy", 100, null), order("sell", 100, 1250)]).price).toBeNull();
    expect(run(1000, [order("buy", 100, 750), order("sell", 100, null)]).price).toBeNull();
    // 値幅の上限を超える買い指値は、上限以下のどの価格でも約定できる
    expect(run(1000, [order("buy", 100, 1300), order("sell", 100, 1150)]).price).toBe(yen(1150));
  });

  it("同じ価格の指値は、確定時刻の早い順。最後の1件は100株単位で一部約定", () => {
    const r = run(1000, [order("buy", 200, 1000, 5), order("buy", 200, 1000, 1), order("buy", 200, 1005, 9), order("sell", 500, 1000, 0)]);
    expect(r.price).toBe(yen(1000));
    // 有利な指値（1005円）→ 時刻1 → 時刻5
    expect(summary(r)).toEqual([[100, "outmatched"], [200, null], [200, null], [500, null]]);
  });

  it("確定時刻が同じなら注文票の seq、同じ注文票なら中の順", () => {
    const at = (sheetSeq: number, index: number): AuctionOrder => ({ sheetSeq, index, committedAt: 7, side: "sell", qty: 100, limit: yen(1000) });
    const r = run(1000, [at(9, 0), at(4, 1), at(4, 0), order("buy", 200, null)]);
    expect(summary(r)).toEqual([[0, "outmatched"], [100, null], [100, null], [200, null]]);
  });

  it("形の崩れた注文は例外（確定の検査を通ったものだけを渡す）", () => {
    expect(() => run(1000, [order("buy", 150, null)])).toThrow("invalid qty");
    expect(() => run(1000, [{ ...order("buy", 100, null), limit: 10005 }])).toThrow("invalid limit");
    const o = order("buy", 100, null);
    expect(() => run(1000, [o, { ...o }])).toThrow("duplicate order");
    expect(() => run(1000, [{ ...o, sheetSeq: -1 }])).toThrow("invalid order identity");
  });
});

/** 乱数の板。前日の価格のまわりに、成行と指値を混ぜる */
function randomBook(seed: number): { prevPrice: number; orders: AuctionOrder[] } {
  const rand = mulberry32(seed);
  // 0.1円単位（呼値に合わないことがある）で、0.1円から3000円まで
  const prevPrice = randInt(rand, 0, 3) === 0 ? randInt(rand, 1, 500) : randInt(rand, 500, 30_000);
  const { lower, upper } = priceBand(prevPrice);
  const orders: AuctionOrder[] = [];
  const sheets = randInt(rand, 0, 12);
  for (let s = 1; s <= sheets; s++) {
    const n = randInt(rand, 1, 3);
    const committedAt = randInt(rand, 0, 5);
    for (let i = 0; i < n; i++) {
      const limit = rand() < 0.25 ? null : Math.round(randInt(rand, lower - 20 * TICK, upper + 20 * TICK) / TICK) * TICK;
      orders.push({ sheetSeq: s, index: i, committedAt, side: pick(rand, ["buy", "sell"] as const), qty: randInt(rand, 1, 10) * 100, limit: limit !== null && limit <= 0 ? TICK : limit });
    }
  }
  return { prevPrice, orders };
}

const canTrade = (o: AuctionOrder, p: number) => o.limit === null || (o.side === "buy" ? o.limit >= p : o.limit <= p);

describe("乱数の板の性質（200通り）", () => {
  for (let seed = 1; seed <= 200; seed++) {
    it(`シード ${seed}`, () => {
      const { prevPrice, orders } = randomBook(seed);
      const r = runAuction({ symbol: "NEO1", prevPrice, orders });
      const { lower, upper } = priceBand(prevPrice);
      // 値幅は1円以上で、前日より高い価格を必ず含み、前日より低い価格も（1円で止まるのでなければ）含む
      expect(lower).toBeGreaterThanOrEqual(TICK);
      expect(upper).toBeGreaterThan(prevPrice);
      expect(lower < prevPrice || lower === TICK).toBe(true);
      const sum = (side: string) => r.fills.filter((f) => f.side === side).reduce((a, f) => a + f.qty, 0);
      // 買いと売りの約定量が一致し、100株単位、注文の株数以下
      expect(sum("buy")).toBe(r.volume);
      expect(sum("sell")).toBe(r.volume);
      for (const f of r.fills) {
        expect(f.qty % 100).toBe(0);
        expect(f.qty).toBeLessThanOrEqual(f.requestedQty);
      }
      // 同じ入力（並べ替えても）で同じ出力
      const key = (f: { sheetSeq: number; index: number }) => `${f.sheetSeq}:${f.index}`;
      const again = runAuction({ symbol: "NEO1", prevPrice, orders: [...orders].reverse() });
      expect(again.price).toBe(r.price);
      expect(new Map(again.fills.map((f) => [key(f), f]))).toEqual(new Map(r.fills.map((f) => [key(f), f])));

      // 全候補の価格を別に数え、選んだ価格が §3 の2の順で最良であること
      const stats = [];
      for (let p = lower; p <= upper; p += TICK) {
        const b = orders.filter((o) => o.side === "buy" && canTrade(o, p)).reduce((a, o) => a + o.qty, 0);
        const s = orders.filter((o) => o.side === "sell" && canTrade(o, p)).reduce((a, o) => a + o.qty, 0);
        stats.push({ p, v: Math.min(b, s), surplus: Math.abs(b - s), d: Math.abs(p - prevPrice) });
      }
      stats.sort((x, y) => y.v - x.v || x.surplus - y.surplus || x.d - y.d || x.p - y.p);
      if (r.price === null) {
        expect(stats[0]!.v).toBe(0);
        expect(r.fills.every((f) => f.qty === 0 && f.reason === "no_price")).toBe(true);
        return;
      }
      expect(r.price).toBe(stats[0]!.p);
      expect(r.volume).toBe(stats[0]!.v);
      // 値幅の内側で、指値より不利な価格で約定しない
      expect(r.price).toBeGreaterThanOrEqual(lower);
      expect(r.price).toBeLessThanOrEqual(upper);
      for (const [i, f] of r.fills.entries()) if (f.qty > 0) expect(canTrade(orders[i]!, r.price)).toBe(true);
      // 約定できる注文のうち、少ない側は全部約定する
      const sideFull = (side: string) => r.fills.every((f, i) => f.side !== side || !canTrade(orders[i]!, r.price!) || f.qty === f.requestedQty);
      expect(sideFull("buy") || sideFull("sell")).toBe(true);
      // 約定が回った注文より優先の高い（成行 → 有利な指値 → 確定時刻 → seq → 注文票の中の順）同じ側の注文は、すべて約定している
      const rank = (o: AuctionOrder) => [o.limit === null ? 0 : 1, o.limit === null ? 0 : o.side === "buy" ? -o.limit : o.limit, o.committedAt, o.sheetSeq, o.index];
      const before = (a: number[], b: number[]) => {
        const k = a.findIndex((x, n) => x !== b[n]);
        return k >= 0 && a[k]! < b[k]!;
      };
      for (const [i, f] of r.fills.entries()) {
        if (f.reason === "outmatched") expect(f.qty).toBeLessThan(f.requestedQty);
        if (f.qty === 0) continue;
        const o = orders[i]!;
        for (const [j, g] of r.fills.entries()) {
          const q = orders[j]!;
          if (q.side === o.side && j !== i && canTrade(q, r.price) && before(rank(q), rank(o))) expect(g.qty).toBe(g.requestedQty);
        }
      }
    });
  }
});
