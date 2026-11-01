// 株式分割・配当（docs/PAPER_TRADING_RULES.md §5）。権利落ち日の前営業日の評価のあとに反映する。
import type { Account, Deciyen } from "./types";

/** from株を to株にする（1株→3株なら from 1, to 3。併合なら from > to） */
export interface Split {
  symbol: string;
  exDate: string;
  from: number;
  to: number;
}

/** 分割の比率の上限（株数×比率が安全な整数に収まるように） */
const MAX_RATIO = 10_000;

export interface Dividend {
  symbol: string;
  exDate: string;
  /** 分割を反映する前の1株あたりの配当。同じ日に複数行（普通配当と記念配当など）あれば、それぞれ加える */
  perShare: Deciyen;
}

export type CorporateEvent =
  | { kind: "dividend"; symbol: string; qty: number; amount: Deciyen }
  | { kind: "split"; symbol: string; qtyBefore: number; qtyAfter: number; cashInLieu: Deciyen };

/**
 * exDate が権利落ち日の配当と分割を反映する。配当を先に（分割前の株数で）、分割を後に処理する。
 * closes は権利落ち日の前営業日の終値で、1株未満の端数を現金にするときだけ使う。
 */
export function applyCorporateActions(
  account: Account,
  exDate: string,
  actions: { splits: readonly Split[]; dividends: readonly Dividend[] },
  closes: Readonly<Record<string, Deciyen>>,
): { account: Account; events: CorporateEvent[] } {
  let cash = account.cash;
  const holdings = Object.fromEntries(Object.entries(account.holdings).map(([k, h]) => [k, { ...h }]));
  const events: CorporateEvent[] = [];

  for (const d of actions.dividends) {
    if (d.exDate !== exDate) continue;
    if (!Number.isSafeInteger(d.perShare) || d.perShare < 0) throw new Error(`invalid dividend for ${d.symbol}: ${d.perShare}`);
    const h = holdings[d.symbol];
    if (!h) continue;
    const amount = h.qty * d.perShare;
    cash += amount;
    events.push({ kind: "dividend", symbol: d.symbol, qty: h.qty, amount });
  }

  const seen = new Set<string>();
  for (const s of actions.splits) {
    if (s.exDate !== exDate) continue;
    if (!Number.isSafeInteger(s.from) || !Number.isSafeInteger(s.to) || s.from <= 0 || s.to <= 0 || s.from > MAX_RATIO || s.to > MAX_RATIO) throw new Error(`invalid split for ${s.symbol}: ${s.from}:${s.to}`);
    if (seen.has(s.symbol)) throw new Error(`duplicate split for ${s.symbol} on ${exDate}`);
    seen.add(s.symbol);
    const h = holdings[s.symbol];
    if (!h) continue;
    const qtyAfter = Math.floor((h.qty * s.to) / s.from);
    // 1株未満の端数（分割後の株数で rem / from 株）を、前営業日の終値で現金にする
    const rem = h.qty * s.to - qtyAfter * s.from;
    let cashInLieu = 0;
    if (rem > 0) {
      const close = closes[s.symbol];
      if (close === undefined) throw new Error(`missing close for ${s.symbol}`);
      cashInLieu = Math.round((close * rem) / s.to);
      const costOut = qtyAfter === 0 ? h.cost : Math.round((h.cost * rem) / (h.qty * s.to));
      h.cost -= costOut;
      cash += cashInLieu;
    }
    events.push({ kind: "split", symbol: s.symbol, qtyBefore: h.qty, qtyAfter, cashInLieu });
    if (qtyAfter === 0) delete holdings[s.symbol];
    else h.qty = qtyAfter;
  }

  return { account: { cash, holdings }, events };
}

/** 分割の権利落ち日の前営業日の終値を、分割後の株数に合わせた価格にする（a株→b株なら a/b 倍、0.1円未満は四捨五入） */
export function splitAdjustedPrice(price: Deciyen, split: Pick<Split, "from" | "to">): Deciyen {
  return Math.round((price * split.from) / split.to);
}
