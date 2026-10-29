import type { Account, GuildId } from "./types";

export type Favorite = { kind: "guild"; guildId: GuildId } | { kind: "split" } | { kind: "none" };

export interface Forecast {
  favorite: Favorite;
  /** 本命の取得原価 ÷（現金＋全保有分の取得原価）を百分率に丸めた値 */
  allocationPct: number;
}

/** 保有の取得原価から本命と資金配分率を導く（D-021）。時価は使わない。 */
export function deriveForecast(account: Account, guilds: readonly GuildId[]): Forecast {
  const costs = guilds.map((g) => ({ g, cost: account.positions[g]?.qty ? account.positions[g]!.costBasis : 0 }));
  const invested = costs.reduce((a, c) => a + c.cost, 0);
  if (invested === 0) return { favorite: { kind: "none" }, allocationPct: 0 };
  const top = Math.max(...costs.map((c) => c.cost));
  const leaders = costs.filter((c) => c.cost === top);
  const allocationPct = Math.round((100 * top) / (account.cash + invested));
  if (leaders.length > 1) return { favorite: { kind: "split" }, allocationPct };
  return { favorite: { kind: "guild", guildId: leaders[0]!.g }, allocationPct };
}
