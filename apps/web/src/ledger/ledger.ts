// 模擬売買の台帳（docs/PAPER_TRADING_RULES.md）。純関数だけで、外部や時計に依存しない。
import { INITIAL_CASH, LOT, type Account, type Deciyen, type Fill, type Order, type OrderSheet, type RejectReason } from "./types";

export function newAccount(): Account {
  return { cash: INITIAL_CASH, holdings: {} };
}

/** 約定日の注文の締め：その日の 8:30（日本時間）を UNIXミリ秒で返す（§1） */
export function cutoffOf(tradingDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradingDate);
  const [y, mo, d] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (!m || day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) throw new Error(`invalid trading date: ${tradingDate}`);
  return Date.UTC(y, mo - 1, d, 8 - 9, 30);
}

export interface CommitContext {
  universe: ReadonlySet<string>;
  /** その日、そのAIがすでに注文票を確定しているか */
  alreadyCommitted: boolean;
  account: Account;
}

/**
 * 注文票を確定してよいかを確かめる（§3）。価格は受け取らない。
 * 1つでも満たさなければ、注文票ごと受け付けない。
 */
export function validateSheet(sheet: OrderSheet, ctx: CommitContext): { ok: true } | { ok: false; reason: RejectReason } {
  if (!Number.isSafeInteger(sheet.committedAt) || !Array.isArray(sheet.orders)) return { ok: false, reason: "invalid_sheet" };
  if (sheet.committedAt >= cutoffOf(sheet.tradingDate)) return { ok: false, reason: "after_cutoff" };
  if (ctx.alreadyCommitted) return { ok: false, reason: "already_committed" };
  const selling = new Map<string, number>();
  for (const o of sheet.orders) {
    if (typeof o.symbol !== "string" || (o.side !== "buy" && o.side !== "sell")) return { ok: false, reason: "invalid_order" };
    if (!ctx.universe.has(o.symbol)) return { ok: false, reason: "unknown_symbol" };
    if (!Number.isSafeInteger(o.qty) || o.qty <= 0) return { ok: false, reason: "invalid_qty" };
    const held = ctx.account.holdings[o.symbol]?.qty ?? 0;
    // 100株単位。ただし端数を含む全株の売りは認める
    if (o.qty % LOT !== 0 && !(o.side === "sell" && o.qty === held)) return { ok: false, reason: "invalid_qty" };
    if (o.side === "sell") selling.set(o.symbol, (selling.get(o.symbol) ?? 0) + o.qty);
  }
  for (const [symbol, qty] of selling) {
    if (qty > (ctx.account.holdings[symbol]?.qty ?? 0)) return { ok: false, reason: "insufficient_holdings" };
  }
  return { ok: true };
}

/**
 * 確定した注文票を始値で約定させる（§4）。売りを先、買いを後に、それぞれ注文票の並び順で処理する。
 * opens には注文票の全銘柄を入れる。始値がつかない銘柄は null とし、約定させず失効させる。
 * 注文票は validateSheet を通したものだけを渡す。
 */
export function executeSheet(account: Account, sheet: OrderSheet, opens: Readonly<Record<string, Deciyen | null>>): { account: Account; fills: Fill[] } {
  let acc = clone(account);
  const ordered = [...sheet.orders.filter((o) => o.side === "sell"), ...sheet.orders.filter((o) => o.side === "buy")];
  const fills = ordered.map((o) => {
    if (!Object.hasOwn(opens, o.symbol)) throw new Error(`missing open data for ${o.symbol}`);
    const r = fillOne(acc, o, opens[o.symbol] ?? null);
    acc = r.account;
    return r.fill;
  });
  return { account: acc, fills };
}

function fillOne(acc: Account, o: Order, price: Deciyen | null): { account: Account; fill: Fill } {
  const base = { symbol: o.symbol, side: o.side, requestedQty: o.qty };
  const expired = (reason: Fill["reason"]) => ({ account: acc, fill: { ...base, qty: 0, price, amount: 0, status: "expired" as const, reason } });
  if (price === null) return expired("no_open_price");
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error(`invalid open price for ${o.symbol}: ${price}`);

  const h = acc.holdings[o.symbol] ?? { qty: 0, cost: 0 };
  if (!Number.isSafeInteger(o.qty) || o.qty <= 0 || (o.qty % LOT !== 0 && !(o.side === "sell" && o.qty === h.qty))) {
    throw new Error(`unvalidated order: ${o.side} ${o.symbol} ${o.qty}`);
  }
  if (o.side === "sell") {
    const qty = Math.min(o.qty, h.qty);
    if (qty === 0) return expired("insufficient_holdings");
    const amount = price * qty;
    // 取得原価は保有全体の総額で持ち、一部の売りでは株数の比で按分する（0.1円未満は四捨五入）
    const costOut = qty === h.qty ? h.cost : Math.round((h.cost * qty) / h.qty);
    const holdings = { ...acc.holdings };
    if (qty === h.qty) delete holdings[o.symbol];
    else holdings[o.symbol] = { qty: h.qty - qty, cost: h.cost - costOut };
    const reduced = qty < o.qty;
    return {
      account: { cash: acc.cash + amount, holdings },
      fill: { ...base, qty, price, amount, status: reduced ? "reduced" : "filled", ...(reduced ? { reason: "insufficient_holdings" as const } : {}) },
    };
  }

  // 買い：買える最大の100株単位まで減らす
  const affordable = Math.floor(acc.cash / (price * LOT)) * LOT;
  const qty = Math.min(o.qty, affordable);
  if (qty === 0) return expired("insufficient_cash");
  const amount = price * qty;
  const reduced = qty < o.qty;
  return {
    account: { cash: acc.cash - amount, holdings: { ...acc.holdings, [o.symbol]: { qty: h.qty + qty, cost: h.cost + amount } } },
    fill: { ...base, qty, price, amount, status: reduced ? "reduced" : "filled", ...(reduced ? { reason: "insufficient_cash" as const } : {}) },
  };
}

/** 総資産（現金＋保有株の時価）。評価に使う終値は呼び出し側が決める（§6） */
export function totalValue(account: Account, closes: Readonly<Record<string, Deciyen>>): Deciyen {
  let total = account.cash;
  for (const [symbol, h] of Object.entries(account.holdings)) {
    const close = closes[symbol];
    if (close === undefined) throw new Error(`missing close for ${symbol}`);
    total += close * h.qty;
  }
  return total;
}

/** 台帳の不変条件。違反があれば内容を返す */
export function invariantViolations(account: Account): string[] {
  const out: string[] = [];
  if (!Number.isSafeInteger(account.cash) || account.cash < 0) out.push(`cash: ${account.cash}`);
  for (const [symbol, h] of Object.entries(account.holdings)) {
    if (!Number.isSafeInteger(h.qty) || h.qty <= 0) out.push(`${symbol} qty: ${h.qty}`);
    if (!Number.isSafeInteger(h.cost) || h.cost < 0) out.push(`${symbol} cost: ${h.cost}`);
  }
  return out;
}

function clone(a: Account): Account {
  return { cash: a.cash, holdings: Object.fromEntries(Object.entries(a.holdings).map(([k, h]) => [k, { ...h }])) };
}
