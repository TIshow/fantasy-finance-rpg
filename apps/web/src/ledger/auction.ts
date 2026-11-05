// 板寄せ：1銘柄の、その日の全参加者の注文から、1つの価格と各注文の約定量を決める（docs/MARKET_DESIGN.md §3、D-042）。
// 純関数。現金の確かめ（§3 の5）は、この前に呼び出し側が行う。入力の注文は、確定の検査を通ったものだけを渡す。
import { LOT, type Deciyen, type Side } from "./types";

/** 呼値（価格の刻み）：1円 */
export const TICK: Deciyen = 10;
/** 値幅制限：前日の価格の ±20% と ±1円（呼値1つ）の大きいほう。価格は1円より下がらない（#110 の lead の決定） */
export const PRICE_BAND_PERCENT = 20;
/** 前日の価格の上限（1億円）。候補の価格を1つずつ数えるので、これより大きい価格は受け付けない */
export const MAX_PRICE: Deciyen = 100_000_000 * 10;

export interface AuctionOrder {
  /** 注文票（order_sheet.committed）の seq */
  sheetSeq: number;
  /** 注文票の中での位置（0から） */
  index: number;
  /** 注文票の確定時刻（UNIXミリ秒）。同じ価格の注文の優先に使う */
  committedAt: number;
  side: Side;
  qty: number;
  /** 指値。成行は null */
  limit: Deciyen | null;
}

export interface AuctionInput {
  symbol: string;
  /** 前日の価格。値幅と、並んだときの決め方に使う */
  prevPrice: Deciyen;
  orders: readonly AuctionOrder[];
}

/**
 * 約定しなかった・減った理由。
 * no_price：その日は価格がつかなかった／limit_not_reached：指値がその日の価格に届かない／outmatched：同じ側の注文が多く、優先の順で回らなかった
 */
export type AuctionReason = "no_price" | "limit_not_reached" | "outmatched";

export interface AuctionFill {
  sheetSeq: number;
  index: number;
  side: Side;
  requestedQty: number;
  qty: number;
  status: "filled" | "reduced" | "expired";
  reason?: AuctionReason;
}

export interface AuctionResult {
  symbol: string;
  /** その日の価格。約定量が0なら null */
  price: Deciyen | null;
  /** 約定した株数（買いの合計＝売りの合計） */
  volume: number;
  /** 値幅の下限と上限（その日に約定できる価格の範囲） */
  lower: Deciyen;
  upper: Deciyen;
  /** 入力の注文と同じ順 */
  fills: AuctionFill[];
}

/** 前日の価格から、呼値に合う値幅の下限と上限。±20% と ±1円の広いほうを、呼値に合わせて内側に丸め、下限は1円 */
export function priceBand(prevPrice: Deciyen): { lower: Deciyen; upper: Deciyen } {
  if (!Number.isSafeInteger(prevPrice) || prevPrice <= 0 || prevPrice > MAX_PRICE) throw new Error(`invalid previous price: ${prevPrice}`);
  const scale = 100 * TICK;
  // 安い価格でも値幅が1点にならないよう、±1円は必ず含める（上限は前日より高く、下限は前日より低いか1円）
  const lower = Math.max(TICK, Math.min(Math.ceil((prevPrice * (100 - PRICE_BAND_PERCENT)) / scale), Math.ceil((prevPrice - TICK) / TICK)) * TICK);
  const upper = Math.max(Math.floor((prevPrice * (100 + PRICE_BAND_PERCENT)) / scale), Math.floor((prevPrice + TICK) / TICK)) * TICK;
  return { lower, upper };
}

/** その価格で約定できる注文か（成行はいつでも、指値は価格が指値以下の買い・以上の売り） */
function executable(o: AuctionOrder, price: Deciyen): boolean {
  if (o.limit === null) return true;
  return o.side === "buy" ? o.limit >= price : o.limit <= price;
}

/**
 * 板寄せ（§3）。約定量が最大の価格 → 余り（買いと売りの差）が小さい → 前日の価格に近い → 低い、の順で1つに決める。
 * 価格の候補は、値幅の内側の呼値すべて。余った側は、成行 → 有利な指値 → 確定時刻の早い順 → 注文票の seq → 注文票の中の順に約定する
 */
export function runAuction(input: AuctionInput): AuctionResult {
  const { lower, upper } = priceBand(input.prevPrice);
  const seen = new Set<string>();
  for (const o of input.orders) {
    if (o.side !== "buy" && o.side !== "sell") throw new Error(`invalid side: ${String(o.side)}`);
    if (!Number.isSafeInteger(o.qty) || o.qty <= 0 || o.qty % LOT !== 0) throw new Error(`invalid qty: ${o.qty}`);
    if (o.limit !== null && (!Number.isSafeInteger(o.limit) || o.limit <= 0 || o.limit % TICK !== 0)) throw new Error(`invalid limit: ${String(o.limit)}`);
    if (![o.sheetSeq, o.index, o.committedAt].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("invalid order identity");
    const id = `${o.sheetSeq}:${o.index}`;
    if (seen.has(id)) throw new Error(`duplicate order ${id}`);
    seen.add(id);
  }

  // 価格を決める
  let best: { price: Deciyen; volume: number; surplus: number; distance: number } | null = null;
  for (let p = lower; p <= upper; p += TICK) {
    let buy = 0;
    let sell = 0;
    for (const o of input.orders) {
      if (!executable(o, p)) continue;
      if (o.side === "buy") buy += o.qty;
      else sell += o.qty;
    }
    const c = { price: p, volume: Math.min(buy, sell), surplus: Math.abs(buy - sell), distance: Math.abs(p - input.prevPrice) };
    // p は低い順に見るので、すべて並んだときは先に見た（低い）価格が残る
    if (!best || c.volume > best.volume || (c.volume === best.volume && (c.surplus < best.surplus || (c.surplus === best.surplus && c.distance < best.distance)))) best = c;
  }
  const price = best && best.volume > 0 ? best.price : null;
  const volume = price === null ? 0 : best!.volume;

  // 各注文に約定量を割り当てる
  const filled = new Map<AuctionOrder, number>();
  if (price !== null) {
    for (const side of ["buy", "sell"] as const) {
      const queue = input.orders.filter((o) => o.side === side && executable(o, price)).sort((a, b) => priority(a, b, side));
      let left = volume;
      for (const o of queue) {
        const q = Math.min(o.qty, left);
        filled.set(o, q);
        left -= q;
      }
    }
  }
  const fills = input.orders.map((o): AuctionFill => {
    const qty = filled.get(o) ?? 0;
    const base = { sheetSeq: o.sheetSeq, index: o.index, side: o.side, requestedQty: o.qty, qty };
    if (qty === o.qty) return { ...base, status: "filled" };
    const reason: AuctionReason = price === null ? "no_price" : !executable(o, price) ? "limit_not_reached" : "outmatched";
    return { ...base, status: qty === 0 ? "expired" : "reduced", reason };
  });
  return { symbol: input.symbol, price, volume, lower, upper, fills };
}

/** 余った側の優先：成行 → 有利な指値（買いは高い、売りは安い） → 確定時刻 → 注文票の seq → 注文票の中の順 */
function priority(a: AuctionOrder, b: AuctionOrder, side: Side): number {
  if ((a.limit === null) !== (b.limit === null)) return a.limit === null ? -1 : 1;
  if (a.limit !== null && b.limit !== null && a.limit !== b.limit) return side === "buy" ? b.limit - a.limit : a.limit - b.limit;
  return a.committedAt - b.committedAt || a.sheetSeq - b.sheetSeq || a.index - b.index;
}
