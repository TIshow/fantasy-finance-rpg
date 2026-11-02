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

/**
 * 反映した内容。反映前の口座とこの並びだけで反映後の口座をたどり直せる（docs/EVENT_LOG.md §3.3）：
 * 配当は現金に amount を足す。分割は株数を qtyAfter にし（0なら保有を消す）、取得原価から costOut を引き、現金に cashInLieu を足す
 */
export type CorporateEvent =
  | { kind: "dividend"; symbol: string; perShare: Deciyen; qty: number; amount: Deciyen }
  | {
      kind: "split";
      symbol: string;
      from: number;
      to: number;
      qtyBefore: number;
      qtyAfter: number;
      /** 端数を現金にした額 */
      cashInLieu: Deciyen;
      /** 端数の分だけ減らした取得原価 */
      costOut: Deciyen;
      /** 端数の換金に使った前営業日の終値。端数がなければ null */
      close: Deciyen | null;
    };

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
    events.push({ kind: "dividend", symbol: d.symbol, perShare: d.perShare, qty: h.qty, amount });
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
    let costOut = 0;
    let close: Deciyen | null = null;
    if (rem > 0) {
      // Object.prototype と同名の銘柄（toString など）を拾わないよう、自分の項目だけを読む。終値は記録に残るので、正の整数でなければ止める
      const c: unknown = Object.hasOwn(closes, s.symbol) ? closes[s.symbol] : undefined;
      if (c === undefined || c === null) throw new Error(`missing close for ${s.symbol}`);
      if (typeof c !== "number" || !Number.isSafeInteger(c) || c <= 0) throw new Error(`invalid close for ${s.symbol}: ${String(c)}`);
      close = c;
      cashInLieu = Math.round((close * rem) / s.to);
      costOut = qtyAfter === 0 ? h.cost : Math.round((h.cost * rem) / (h.qty * s.to));
      h.cost -= costOut;
      cash += cashInLieu;
    }
    events.push({ kind: "split", symbol: s.symbol, from: s.from, to: s.to, qtyBefore: h.qty, qtyAfter, cashInLieu, costOut, close });
    if (qtyAfter === 0) delete holdings[s.symbol];
    else h.qty = qtyAfter;
  }

  return { account: { cash, holdings }, events };
}

/** 分割の権利落ち日の前営業日の終値を、分割後の株数に合わせた価格にする（a株→b株なら a/b 倍、0.1円未満は四捨五入） */
export function splitAdjustedPrice(price: Deciyen, split: Pick<Split, "from" | "to">): Deciyen {
  return Math.round((price * split.from) / split.to);
}
