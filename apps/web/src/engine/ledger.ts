import { MM_ACCOUNT_ID, PAYOUT_PER_SHARE } from "./constants";
import type { Account, Fill, GuildId } from "./types";

export type Accounts = Record<string, Account>;

function cloneAccount(a: Account): Account {
  return {
    ...a,
    positions: Object.fromEntries(Object.entries(a.positions).map(([g, p]) => [g, { ...p }])),
  };
}

function position(a: Account, guildId: GuildId) {
  return (a.positions[guildId] ??= { qty: 0, costBasis: 0 });
}

/**
 * 約定を台帳に反映する。相手はすべて市場係。
 * 売却時は、売却口数に対応する平均取得原価を減らす（D-021）。
 */
export function applyFills(accounts: Accounts, fills: readonly Fill[]): Accounts {
  const next: Accounts = Object.fromEntries(Object.entries(accounts).map(([id, a]) => [id, cloneAccount(a)]));
  const mm = next[MM_ACCOUNT_ID];
  if (!mm) throw new Error("market maker account is missing");
  for (const f of fills) {
    if (f.filled === 0) continue;
    const acct = next[f.accountId];
    if (!acct) throw new Error(`unknown account: ${f.accountId}`);
    const p = position(acct, f.guildId);
    const mmp = position(mm, f.guildId);
    acct.cash += f.cashDelta;
    mm.cash -= f.cashDelta;
    if (f.side === "buy") {
      p.costBasis += -f.cashDelta;
      p.qty += f.filled;
      mmp.qty -= f.filled;
    } else {
      p.costBasis -= Math.round((p.costBasis * f.filled) / p.qty);
      p.qty -= f.filled;
      mmp.qty += f.filled;
      if (p.qty === 0) p.costBasis = 0;
    }
  }
  return next;
}

/** 優勝ギルドの成功証を1口100Gで精算し、すべての保有を0にする。払うのは市場係。 */
export function settle(accounts: Accounts, winner: GuildId): { accounts: Accounts; payouts: Record<string, number> } {
  const next: Accounts = Object.fromEntries(Object.entries(accounts).map(([id, a]) => [id, cloneAccount(a)]));
  const mm = next[MM_ACCOUNT_ID];
  if (!mm) throw new Error("market maker account is missing");
  const payouts: Record<string, number> = {};
  for (const acct of Object.values(next)) {
    if (acct.kind !== "mm") {
      const pay = (acct.positions[winner]?.qty ?? 0) * PAYOUT_PER_SHARE;
      payouts[acct.id] = pay;
      acct.cash += pay;
      mm.cash -= pay;
    }
  }
  for (const acct of Object.values(next)) {
    for (const p of Object.values(acct.positions)) {
      p.qty = 0;
      p.costBasis = 0;
    }
  }
  return { accounts: next, payouts };
}
