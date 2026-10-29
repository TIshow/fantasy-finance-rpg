import { ALGORITHM_VERSION } from "./constants";
import { hashValue } from "./hash";
import { displayPrices } from "./lmsr";
import type { ClearingResult, Fill, GuildFlowStats, GuildMap, Market, RoundOrder } from "./types";

function compareOrders(a: RoundOrder, b: RoundOrder): number {
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
  return a.guildId < b.guildId ? -1 : a.guildId > b.guildId ? 1 : 0;
}

/**
 * 清算の前提を確かめる。1口座1ギルド1注文にしておかないと、同じ組の並び順で結果のハッシュが変わる。
 * 予約額が負だと減らす処理が終わらないので、ここで止める。
 */
function assertValidOrders(market: Market, orders: readonly RoundOrder[]): void {
  const slots = new Set<string>();
  for (const o of orders) {
    if (!market.guilds.includes(o.guildId)) throw new Error(`unknown guild: ${o.guildId}`);
    if (o.side !== "buy" && o.side !== "sell") throw new Error(`invalid side: ${o.accountId}`);
    if (!Number.isInteger(o.qty) || o.qty < 1) throw new Error(`invalid qty: ${o.accountId}`);
    if (!Number.isFinite(o.reserveCash) || o.reserveCash < 0) throw new Error(`invalid reserve: ${o.accountId}`);
    const slot = `${o.accountId}\u0000${o.guildId}`;
    if (slots.has(slot)) throw new Error(`duplicate order: ${o.accountId} ${o.guildId}`);
    slots.add(slot);
  }
}

/** ギルドごとに、注文した人数と約定した純量をNPCとプレイヤーに分けて数える。 */
function tallyStats(guilds: readonly string[], fills: readonly Fill[]): GuildMap<GuildFlowStats> {
  const stats: GuildMap<GuildFlowStats> = Object.fromEntries(
    guilds.map((g) => [g, { npcBuyers: 0, npcSellers: 0, playerBuyers: 0, playerSellers: 0, npcNet: 0, playerNet: 0 }]),
  );
  for (const f of fills) {
    const s = stats[f.guildId]!;
    const net = (f.side === "buy" ? 1 : -1) * f.filled;
    if (f.kind === "npc") {
      if (f.side === "buy") s.npcBuyers += 1;
      else s.npcSellers += 1;
      s.npcNet += net;
    } else {
      if (f.side === "buy") s.playerBuyers += 1;
      else s.playerSellers += 1;
      s.playerNet += net;
    }
  }
  return stats;
}

/**
 * 締切でプレイヤーとNPCの注文をまとめ、新しい表示価格で全員を約定させる（D-025）。
 * 新価格で予約額を超える買いは、超えなくなるまで全員同時に1口ずつ減らす。
 * 処理順に依存しないよう、入力は並べ替えてから扱う。
 */
export function clearRound(input: { market: Market; orders: readonly RoundOrder[] }): ClearingResult {
  const { market } = input;
  const orders = [...input.orders].sort(compareOrders);
  assertValidOrders(market, orders);
  const inputHash = hashValue({
    algorithmVersion: ALGORITHM_VERSION,
    b: market.b,
    guilds: market.guilds,
    q: market.q,
    orders,
  });

  const pricesBefore = displayPrices(market);
  const fill = orders.map((o) => o.qty);
  let qAfter: GuildMap<number> = {};
  let prices: GuildMap<number> = {};
  let iterations = 0;

  for (;;) {
    iterations += 1;
    qAfter = Object.fromEntries(market.guilds.map((g) => [g, market.q[g] ?? 0]));
    orders.forEach((o, i) => {
      qAfter[o.guildId]! += (o.side === "buy" ? 1 : -1) * fill[i]!;
    });
    prices = displayPrices({ ...market, q: qAfter });
    const over = orders
      .map((o, i) => (o.side === "buy" && fill[i]! * prices[o.guildId]! > o.reserveCash ? i : -1))
      .filter((i) => i >= 0);
    if (over.length === 0) break;
    for (const i of over) fill[i]! -= 1;
  }

  const fills: Fill[] = orders.map((o, i) => {
    const filled = fill[i]!;
    const price = prices[o.guildId]!;
    const sign = o.side === "buy" ? 1 : -1;
    return {
      accountId: o.accountId,
      kind: o.kind,
      guildId: o.guildId,
      side: o.side,
      requested: o.qty,
      filled,
      price,
      cashDelta: filled === 0 ? 0 : -sign * filled * price,
      reason: filled === o.qty ? "filled" : filled === 0 ? "unfilled_budget" : "partial_budget",
    };
  });
  const mmCashDelta = -fills.reduce((a, f) => a + f.cashDelta, 0);
  const outputHash = hashValue({ prices, qAfter, fills, mmCashDelta });

  return {
    algorithmVersion: ALGORITHM_VERSION,
    pricesBefore,
    prices,
    qAfter,
    fills,
    mmCashDelta,
    stats: tallyStats(market.guilds, fills),
    iterations,
    inputHash,
    outputHash,
  };
}
