// 値幅の端の日が長く続くとき（#153 のレビューの M1）：目安の価格が前日の価格から大きく離れたまま何日も続くと、値段のつかない日が
// 何日続くかを測る。マーケットメイカー1つとばらばらの参加者1人だけで、1銘柄の板寄せを、純関数（makerOrders・noiseOrders・
// runAuction）だけで毎日回す（AI投資家はいない。決算の発表もない＝目安の価格は変わらない）。
import { describe, expect, it } from "vitest";
import { priceBand, runAuction, type AuctionOrder } from "../../../src/ledger/auction";
import { type LiquidityOrder, makerOrders, noiseOrders } from "../../../src/runner/world/liquidity";

const SYMBOL = "VRN1";
const START = 10_000; // 1,000円（0.1円単位）

/** 目安の価格を fair に固定して days 日回し、日ごとの価格（つかなければ null）と最後の持ち株・現金を返す */
function simulate(fair: number, days: number, seed = 20261106) {
  let prev = START;
  const maker = { held: 5000, cash: 500_000_000 };
  const noise = { held: 1000, cash: 300_000_000 };
  const prices: (number | null)[] = [];
  for (let d = 0; d < days; d++) {
    const band = priceBand(prev);
    const edge = fair > band.upper ? ("upper" as const) : fair < band.lower ? ("lower" as const) : undefined;
    const mOs = makerOrders({ symbol: SYMBOL, fair, band, held: maker.held, target: 5000, cash: maker.cash });
    const tradingDate = new Date(Date.UTC(2027, 0, 1) + d * 86_400_000).toISOString().slice(0, 10);
    const nOs = noiseOrders({ seed, tradingDate, markets: [{ symbol: SYMBOL, prevPrice: prev, band, ...(edge ? { edge } : {}) }], holdings: { [SYMBOL]: noise.held }, cash: noise.cash, baseline: { shares: { [SYMBOL]: 1000 }, cash: 300_000_000 } });
    const orders: AuctionOrder[] = [];
    const owner: (typeof maker)[] = [];
    const add = (os: LiquidityOrder[], who: typeof maker, sheetSeq: number) =>
      os.forEach((o, index) => {
        orders.push({ sheetSeq, index, committedAt: sheetSeq, side: o.side, qty: o.qty, limit: o.limit });
        owner.push(who);
      });
    add(mOs, maker, 1);
    add(nOs, noise, 2);
    const r = runAuction({ symbol: SYMBOL, prevPrice: prev, orders });
    r.fills.forEach((f, i) => {
      if (f.qty === 0) return;
      const who = owner[i]!;
      who.held += f.side === "buy" ? f.qty : -f.qty;
      who.cash += (f.side === "buy" ? -1 : 1) * f.qty * r.price!;
    });
    prices.push(r.price);
    if (r.price !== null) prev = r.price;
  }
  let longest = 0;
  let gap = 0;
  for (const p of prices) {
    gap = p === null ? gap + 1 : 0;
    longest = Math.max(longest, gap);
  }
  return { prices, longest, maker, noise, last: prev };
}

describe("目安の価格が値幅から大きく離れたまま続く（#153 のレビューの M1。#139 で lead の判断待ち）", () => {
  // 目安の価格が前日の価格の3割：ばらばらの参加者は端の日に9割の確率で売り、数日で持ち株が尽きる。マーケットメイカーは
  // 下限の値段で買いだけを出すので、売る人がいなくなり、値段がつかず、値幅の基準が動かないまま止まる
  it.fails("目安が前日の3割のまま20日：値段のつかない日が続くのは3日まで（いまは止まる。#139 で lead の判断待ち）", () => {
    const r = simulate(3_000, 20);
    console.log(`fair 30%: longest ${r.longest}, last ${r.last}, prices ${JSON.stringify(r.prices)}, noise held ${r.noise.held}`);
    expect(r.longest).toBeLessThanOrEqual(3);
  });

  it("目安が前日の3倍のまま20日：値段のつかない日が続くのは3日まで（ばらばらの参加者の現金は尽きない）", () => {
    const r = simulate(30_000, 20);
    console.log(`fair 300%: longest ${r.longest}, last ${r.last}, prices ${JSON.stringify(r.prices)}, noise cash ${r.noise.cash}`);
    expect(r.longest).toBeLessThanOrEqual(3);
  });
});
