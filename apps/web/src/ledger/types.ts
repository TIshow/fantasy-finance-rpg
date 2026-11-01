// 模擬売買の台帳の型（docs/PAPER_TRADING_RULES.md）。
// 金額と価格は 0.1円 を最小単位とする整数で持つ（§4）。

/** 0.1円単位の整数 */
export type Deciyen = number;

export const LOT = 100;
export const INITIAL_CASH: Deciyen = 10_000_000 * 10;

export type Side = "buy" | "sell";

export interface Holding {
  qty: number;
  /** 保有株全体の取得原価 */
  cost: Deciyen;
}

export interface Account {
  cash: Deciyen;
  holdings: Record<string, Holding>;
}

export interface Order {
  symbol: string;
  side: Side;
  qty: number;
}

/** AIが1日1回だけ確定する注文票（§3） */
export interface OrderSheet {
  agentId: string;
  /** 約定させる営業日（YYYY-MM-DD、日本時間） */
  tradingDate: string;
  /** 確定時刻（UNIXミリ秒）。AIの出力ではなく、サーバーが受け取った時刻を入れる */
  committedAt: number;
  orders: Order[];
}

export type RejectReason =
  | "invalid_sheet"
  | "after_cutoff"
  | "already_committed"
  | "invalid_order"
  | "unknown_symbol"
  | "invalid_qty"
  | "insufficient_holdings";

export type FillStatus = "filled" | "reduced" | "expired";
export type FillReason = "insufficient_cash" | "insufficient_holdings" | "no_open_price";

export interface Fill {
  symbol: string;
  side: Side;
  requestedQty: number;
  qty: number;
  price: Deciyen | null;
  amount: Deciyen;
  status: FillStatus;
  reason?: FillReason;
}
