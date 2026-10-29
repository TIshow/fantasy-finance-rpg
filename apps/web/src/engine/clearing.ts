import { ALGORITHM_VERSION } from "./constants";
import { hashValue } from "./hash";
import { displayPrices } from "./lmsr";
import type { ClearingResult, Fill, GuildFlowStats, GuildMap, Market, RoundOrder } from "./types";

function compareOrders(a: RoundOrder, b: RoundOrder): number {
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
  return a.guildId < b.guildId ? -1 : a.guildId > b.guildId ? 1 : 0;
}

function emptyStats(): GuildFlowStats {
  return { npcBuyers: 0, npcSellers: 0, playerBuyers: 0, playerSellers: 0, npcNet: 0, playerNet: 0 };
}

/**
 * 締切でプレイヤーとNPCの注文をまとめ、新しい表示価格で全員を約定させる（D-025）。
 * 新価格で予約額を超える買いは、超えなくなるまで全員同時に1口ずつ減らす。
 * 処理順に依存しないよう、入力は並べ替えてから扱う。
 */
export function clearRound(input: { market: Market; orders: readonly RoundOrder[] }): ClearingResult {
  const { market } = input;
  const orders = [...input.orders].sort(compareOrders);
  for (const o of orders) {
    if (!market.guilds.includes(o.guildId)) throw new Error(`unknown guild: ${o.guildId}`);
    if (!Number.isInteger(o.qty) || o.qty < 1) throw new Error(`invalid qty: ${o.accountId}`);
  }
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

  const stats: GuildMap<GuildFlowStats> = Object.fromEntries(market.guilds.map((g) => [g, emptyStats()]));
  const fills: Fill[] = orders.map((o, i) => {
    const filled = fill[i]!;
    const price = prices[o.guildId]!;
    const sign = o.side === "buy" ? 1 : -1;
    const s = stats[o.guildId]!;
    if (o.kind === "npc") {
      if (o.side === "buy") s.npcBuyers += 1;
      else s.npcSellers += 1;
      s.npcNet += sign * filled;
    } else {
      if (o.side === "buy") s.playerBuyers += 1;
      else s.playerSellers += 1;
      s.playerNet += sign * filled;
    }
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
    stats,
    iterations,
    inputHash,
    outputHash,
  };
}
