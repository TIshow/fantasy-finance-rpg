import { MAX_RESERVE_UNIT } from "./constants";
import type { Account, GuildId, GuildMap, OrderIntent, RoundOrder } from "./types";

/** 買い予約の単価 = min(99, ceil(表示価格 × 1.5)) */
export function reserveUnitPrice(displayPrice: number): number {
  return Math.min(MAX_RESERVE_UNIT, Math.ceil((displayPrice * 3) / 2));
}

export function reserveFor(intent: OrderIntent, prices: GuildMap<number>): number {
  if (intent.side === "sell") return 0;
  return intent.qty * reserveUnitPrice(prices[intent.guildId] ?? MAX_RESERVE_UNIT);
}

export type OrderRejection = "unknown_guild" | "invalid_side" | "invalid_qty" | "insufficient_cash" | "insufficient_holdings";

export type OrderValidation =
  | { ok: true; order: RoundOrder }
  | { ok: false; reason: OrderRejection };

/**
 * 1ギルドにつき1枠。同じギルドの予約は置き換える。
 * 使える現金 = 現金 − 他の枠の予約額。売れる口数 = 保有口数。
 */
export function validateOrder(args: {
  account: Account;
  openOrders: readonly RoundOrder[];
  intent: OrderIntent;
  prices: GuildMap<number>;
  guilds: readonly GuildId[];
  orderCap: number;
}): OrderValidation {
  const { account, openOrders, intent, prices, guilds, orderCap } = args;
  if (!guilds.includes(intent.guildId)) return { ok: false, reason: "unknown_guild" };
  if (intent.side !== "buy" && intent.side !== "sell") return { ok: false, reason: "invalid_side" };
  if (!Number.isInteger(intent.qty) || intent.qty < 1 || intent.qty > orderCap) {
    return { ok: false, reason: "invalid_qty" };
  }
  const others = openOrders.filter((o) => o.accountId === account.id && o.guildId !== intent.guildId);
  const reserveCash = reserveFor(intent, prices);
  if (intent.side === "buy") {
    const freeCash = account.cash - others.reduce((a, o) => a + o.reserveCash, 0);
    if (reserveCash > freeCash) return { ok: false, reason: "insufficient_cash" };
  } else {
    const held = account.positions[intent.guildId]?.qty ?? 0;
    if (intent.qty > held) return { ok: false, reason: "insufficient_holdings" };
  }
  // 受け取った intent を展開せず、必要な項目だけを詰め直す（余計な項目を注文に持ち込まない）
  const { guildId, side, qty } = intent;
  return {
    ok: true,
    order: { accountId: account.id, kind: account.kind === "npc" ? "npc" : "player", guildId, side, qty, reserveCash },
  };
}
