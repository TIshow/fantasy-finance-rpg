import { PRICE_TOTAL } from "./constants";
import type { GuildMap, Market } from "./types";

function scaled(market: Market): number[] {
  return market.guilds.map((g) => (market.q[g] ?? 0) / market.b);
}

/** 100G × softmax(q / b)。丸める前の価格。 */
export function rawPrices(market: Market): number[] {
  const xs = scaled(market);
  const m = Math.max(...xs);
  const es = xs.map((x) => Math.exp(x - m));
  const total = es.reduce((a, c) => a + c, 0);
  return es.map((e) => (PRICE_TOTAL * e) / total);
}

/**
 * 表示価格。最大剰余法で整数にして合計100Gにする。端数が同じときはギルドの表示順。
 * 1G未満のギルドは1Gにし、その分を最も高いギルドから引く。
 */
export function displayPrices(market: Market): GuildMap<number> {
  const raw = rawPrices(market);
  const ints = raw.map((r) => Math.floor(r));
  const rest = PRICE_TOTAL - ints.reduce((a, c) => a + c, 0);
  const order = raw
    .map((r, i) => ({ i, f: r - Math.floor(r) }))
    .sort((a, b) => b.f - a.f || a.i - b.i);
  for (let j = 0; j < rest; j++) {
    ints[order[j]!.i]! += 1;
  }
  for (let i = 0; i < ints.length; i++) {
    while (ints[i]! < 1) {
      let max = 0;
      for (let j = 1; j < ints.length; j++) {
        if (ints[j]! > ints[max]!) max = j;
      }
      ints[max]! -= 1;
      ints[i]! += 1;
    }
  }
  return Object.fromEntries(market.guilds.map((g, i) => [g, ints[i]!]));
}

/** LMSRのコスト関数 C(q) = 100 × b × ln Σ e^(q/b)（G単位） */
export function lmsrCost(market: Market): number {
  const xs = scaled(market);
  const m = Math.max(...xs);
  const total = xs.reduce((a, x) => a + Math.exp(x - m), 0);
  return PRICE_TOTAL * market.b * (m + Math.log(total));
}
