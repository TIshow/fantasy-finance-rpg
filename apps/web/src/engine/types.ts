export type GuildId = string;
export type Side = "buy" | "sell";
export type AccountKind = "player" | "npc" | "mm";
export type GuildMap<T> = Record<GuildId, T>;

export interface Position {
  qty: number;
  /** 現在保有分の取得原価（D-021） */
  costBasis: number;
}

export interface Account {
  id: string;
  kind: AccountKind;
  cash: number;
  positions: GuildMap<Position>;
}

export interface Market {
  /** 表示順。端数の配分と同率の解決にも使う */
  guilds: readonly GuildId[];
  b: number;
  q: GuildMap<number>;
}

export interface OrderIntent {
  guildId: GuildId;
  side: Side;
  qty: number;
}

export interface RoundOrder extends OrderIntent {
  accountId: string;
  kind: "player" | "npc";
  /** 買いで確保した現金。売りは0 */
  reserveCash: number;
}

export type FillReason = "filled" | "partial_budget" | "unfilled_budget";

export interface Fill {
  accountId: string;
  kind: "player" | "npc";
  guildId: GuildId;
  side: Side;
  requested: number;
  filled: number;
  price: number;
  /** 買いは負、売りは正 */
  cashDelta: number;
  reason: FillReason;
}

export interface GuildFlowStats {
  npcBuyers: number;
  npcSellers: number;
  playerBuyers: number;
  playerSellers: number;
  /** 約定した口数の純量（買い−売り） */
  npcNet: number;
  playerNet: number;
}

export interface ClearingResult {
  algorithmVersion: string;
  pricesBefore: GuildMap<number>;
  prices: GuildMap<number>;
  qAfter: GuildMap<number>;
  fills: Fill[];
  mmCashDelta: number;
  stats: GuildMap<GuildFlowStats>;
  iterations: number;
  inputHash: string;
  outputHash: string;
}
