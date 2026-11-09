// 模擬売買の台帳（docs/PAPER_TRADING_RULES.md）。純関数だけで、外部や時計に依存しない。
import { priceBand, TICK } from "./auction";
import { cutoffOf, decisionOpensAt, EVERY_DAY_FROM, isValidDate, previousTradingDay, upcomingTradingDay } from "./calendar";
import { INITIAL_CASH, LOT, type Account, type Deciyen, type Fill, type FillReason, type Order, type OrderSheet, type RejectReason } from "./types";

export {
  cutoffOf,
  decisionOpensAt,
  EVERY_DAY_FROM,
  isBusinessDay,
  isTradingDay,
  isValidDate,
  marketClosedDays,
  nextBusinessDay,
  nextTradingDay,
  previousBusinessDay,
  previousTradingDay,
  tradingDateFor,
  upcomingTradingDay,
} from "./calendar";

export function newAccount(initialCash: Deciyen = INITIAL_CASH): Account {
  return { cash: initialCash, holdings: {} };
}

export interface CommitContext {
  universe: ReadonlySet<string>;
  /** その日、そのAIがすでに注文票を確定しているか */
  alreadyCommitted: boolean;
  account: Account;
  /**
   * 架空の市場の休み（YYYY-MM-DD。EventLog.holidays() か marketClosedDays() で作る。D-047）。
   * 切り替えの日より前は東証の祝日と臨時休場（土日と12月31日〜1月3日は含めなくてよい）、以後は臨時休場だけ
   */
  holidays: ReadonlySet<string>;
  /** account に反映済みの、最後の引け後処理（評価と分割・配当の反映）の取引日 */
  accountAsOf: string;
  /** 上場した銘柄（company.listed）。指値の値幅と、1件の株数の上限に使う。ない銘柄には指値を出せない */
  listings?: ReadonlyMap<string, Listing>;
}

export interface Listing {
  /** 発行済株式数。1件の注文の株数の上限 */
  sharesOutstanding: number;
  /** 値幅の基準の価格（前日の価格。板寄せの価格がまだなければ上場の価格） */
  refPrice: Deciyen;
}

/**
 * 注文票を確定してよいかを確かめる（§3）。価格は受け取らない。
 * 1つでも満たさなければ、注文票ごと受け付けない。
 */
export function validateSheet(sheet: OrderSheet, ctx: CommitContext): { ok: true } | { ok: false; reason: RejectReason } {
  if (!Number.isSafeInteger(sheet.committedAt) || !isValidDate(sheet.tradingDate) || !Array.isArray(sheet.orders)) return { ok: false, reason: "invalid_sheet" };
  if (sheet.committedAt >= cutoffOf(sheet.tradingDate)) return { ok: false, reason: "after_cutoff" };
  // 約定日は、確定時刻から見て締めがまだ来ていない最初の取引日（架空の市場の暦。D-047）だけ。
  // さらに、切り替えの日より後の取引日では、確定は前の取引日の引け（16:30）のあと。前の取引日の締めと引けの間の確定は、
  // どの取引日にも受け付けない（#228）。切り替えの日まで（11/9 以前）の取引日には当てない（すでにある記録の照合と拒否の理由を変えないため）
  if (sheet.tradingDate !== upcomingTradingDay(sheet.committedAt, ctx.holidays)) return { ok: false, reason: "wrong_trading_date" };
  if (sheet.tradingDate > EVERY_DAY_FROM && sheet.committedAt < decisionOpensAt(sheet.tradingDate, ctx.holidays)) return { ok: false, reason: "wrong_trading_date" };
  // 前の取引日の引け後処理が済んだ口座でだけ確定できる。確定から約定までに保有が変わらないようにするため
  if (ctx.accountAsOf !== previousTradingDay(sheet.tradingDate, ctx.holidays)) return { ok: false, reason: "account_not_ready" };
  if (ctx.alreadyCommitted) return { ok: false, reason: "already_committed" };
  const selling = new Map<string, number>();
  for (const o of sheet.orders) {
    if (typeof o.symbol !== "string" || (o.side !== "buy" && o.side !== "sell")) return { ok: false, reason: "invalid_order" };
    if (!ctx.universe.has(o.symbol)) return { ok: false, reason: "unknown_symbol" };
    if (!Number.isSafeInteger(o.qty) || o.qty <= 0) return { ok: false, reason: "invalid_qty" };
    const held = ctx.account.holdings[o.symbol]?.qty ?? 0;
    // 100株単位。ただし端数を含む全株の売りは認める
    if (o.qty % LOT !== 0 && !(o.side === "sell" && o.qty === held)) return { ok: false, reason: "invalid_qty" };
    const listing = ctx.listings?.get(o.symbol);
    if (listing && o.qty > listing.sharesOutstanding) return { ok: false, reason: "invalid_qty" };
    if (o.limit !== undefined) {
      // 指値は、呼値に合い、基準の価格から決まる値幅の内側（MARKET_DESIGN §2）
      if (!listing || !Number.isSafeInteger(o.limit) || o.limit % TICK !== 0) return { ok: false, reason: "invalid_price" };
      const band = priceBand(listing.refPrice);
      if (o.limit < band.lower || o.limit > band.upper) return { ok: false, reason: "invalid_price" };
    }
    if (o.side === "sell") selling.set(o.symbol, (selling.get(o.symbol) ?? 0) + o.qty);
  }
  for (const [symbol, qty] of selling) {
    if (qty > (ctx.account.holdings[symbol]?.qty ?? 0)) return { ok: false, reason: "insufficient_holdings" };
  }
  return { ok: true };
}

/** 板寄せで決まった1件の注文の結果（MARKET_DESIGN §3）。price はその日の価格（つかなければ null） */
export interface AuctionedFill {
  price: Deciyen | null;
  qty: number;
  /** qty が注文の株数より少ないときの理由 */
  reason?: FillReason;
}

/**
 * 確定した注文票を約定させる（§4）。売りを先、買いを後に、それぞれ注文票の並び順で処理する。
 * auctioned には、板寄せで決まった注文（上場した銘柄、キーは注文票の中の位置）を渡す。その買いは、ほかの買いより先に当てる
 * （板寄せの前に現金を確かめて取っておいた分なので、先に払えば必ず足りる）。
 * それ以外の注文は始値で約定する。opens にはその銘柄を入れる。始値がつかない銘柄は null とし、約定させず失効させる。
 * 注文票は validateSheet を通したものだけを渡す。
 */
export function executeSheet(
  account: Account,
  sheet: OrderSheet,
  opens: Readonly<Record<string, Deciyen | null>>,
  auctioned: ReadonlyMap<number, AuctionedFill> = new Map(),
): { account: Account; fills: Fill[] } {
  let acc = clone(account);
  const indexed = sheet.orders.map((o, i) => ({ o, i }));
  const buys = indexed.filter(({ o }) => o.side === "buy");
  const ordered = [...indexed.filter(({ o }) => o.side === "sell"), ...buys.filter(({ i }) => auctioned.has(i)), ...buys.filter(({ i }) => !auctioned.has(i))];
  const fills = ordered.map(({ o, i }) => {
    const a = auctioned.get(i);
    if (!a && !Object.hasOwn(opens, o.symbol)) throw new Error(`missing open data for ${o.symbol}`);
    const r = a ? fillAuctioned(acc, o, a) : fillOne(acc, o, opens[o.symbol] ?? null);
    acc = r.account;
    return r.fill;
  });
  return { account: acc, fills };
}

/** 板寄せで決まった株数をそのまま当てる。売る株・払う現金が足りなければ、確かめの漏れなので例外 */
function fillAuctioned(acc: Account, o: Order, a: AuctionedFill): { account: Account; fill: Fill } {
  const base = { symbol: o.symbol, side: o.side, requestedQty: o.qty, price: a.price };
  if (!Number.isSafeInteger(a.qty) || a.qty < 0 || a.qty > o.qty || (a.qty > 0 && a.price === null)) throw new Error(`invalid auction result for ${o.symbol}`);
  const status = a.qty === o.qty ? ("filled" as const) : a.qty === 0 ? ("expired" as const) : ("reduced" as const);
  const tail = status === "filled" ? {} : { reason: a.reason };
  if (a.qty === 0) return { account: acc, fill: { ...base, qty: 0, amount: 0, status, ...tail } };
  const price = a.price!;
  const amount = price * a.qty;
  const h = acc.holdings[o.symbol] ?? { qty: 0, cost: 0 };
  const holdings = { ...acc.holdings };
  if (o.side === "sell") {
    if (a.qty > h.qty) throw new Error(`auction sold more ${o.symbol} than held`);
    const costOut = a.qty === h.qty ? h.cost : Math.round((h.cost * a.qty) / h.qty);
    if (a.qty === h.qty) delete holdings[o.symbol];
    else holdings[o.symbol] = { qty: h.qty - a.qty, cost: h.cost - costOut };
    return { account: { cash: acc.cash + amount, holdings }, fill: { ...base, qty: a.qty, amount, status, ...tail } };
  }
  if (amount > acc.cash) throw new Error(`auction bought more ${o.symbol} than the cash allows`);
  holdings[o.symbol] = { qty: h.qty + a.qty, cost: h.cost + amount };
  return { account: { cash: acc.cash - amount, holdings }, fill: { ...base, qty: a.qty, amount, status, ...tail } };
}

/**
 * 板寄せの前の現金の確かめ（MARKET_DESIGN §3 の5）。上場した銘柄の買いを、注文票の並び順に、
 * 指値（成行は値幅の上限）× 株数で確かめ、買える最大の100株単位まで減らす。その日の価格は見込まず、売りの代金も当てにしない。
 * upperOf はその銘柄の値幅の上限（上場していなければ undefined）。返すのは注文ごとの株数で、売りと上場していない銘柄はそのまま
 */
export function reserveBuys(cash: Deciyen, orders: readonly Order[], upperOf: (symbol: string) => Deciyen | undefined): number[] {
  let left = cash;
  return orders.map((o) => {
    const upper = o.side === "buy" ? upperOf(o.symbol) : undefined;
    if (upper === undefined) return o.qty;
    const bound = o.limit ?? upper;
    const qty = Math.min(o.qty, Math.floor(left / (bound * LOT)) * LOT);
    left -= bound * qty;
    return qty;
  });
}

function fillOne(acc: Account, o: Order, price: Deciyen | null): { account: Account; fill: Fill } {
  const base = { symbol: o.symbol, side: o.side, requestedQty: o.qty };
  const expired = (reason: Fill["reason"]) => ({ account: acc, fill: { ...base, qty: 0, price, amount: 0, status: "expired" as const, reason } });
  if (price === null) return expired("no_open_price");
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error(`invalid open price for ${o.symbol}: ${price}`);
  if (o.limit !== undefined && (o.side === "buy" ? price > o.limit : price < o.limit)) return expired("limit_not_reached");

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
    // Object.prototype と同名の銘柄を拾わないよう、自分の項目だけを読む。null や不正な値を0として足さない
    const close: unknown = Object.hasOwn(closes, symbol) ? closes[symbol] : undefined;
    if (close === undefined || close === null) throw new Error(`missing close for ${symbol}`);
    if (typeof close !== "number" || !Number.isSafeInteger(close) || close <= 0) throw new Error(`invalid close for ${symbol}: ${String(close)}`);
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
