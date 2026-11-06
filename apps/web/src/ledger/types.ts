// 模擬売買の台帳の型（docs/PAPER_TRADING_RULES.md）。
// 金額と価格は 0.1円 を最小単位とする整数で持つ（§4）。

/** 0.1円単位の整数 */
export type Deciyen = number;

export const LOT = 100;
export const INITIAL_CASH: Deciyen = 10_000_000 * 10;
/** 参加者の最初の現金の上限（100億円）。AI投資家は INITIAL_CASH、マーケットメイカーなどは別の額で始まる（#110） */
export const MAX_INITIAL_CASH: Deciyen = 10_000_000_000 * 10;

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
  /** 指値（0.1円単位、呼値に合う値）。書かなければ成行（docs/MARKET_DESIGN.md §2） */
  limit?: Deciyen;
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
  | "wrong_trading_date"
  | "account_not_ready"
  | "already_committed"
  | "invalid_order"
  | "unknown_symbol"
  | "invalid_qty"
  | "insufficient_holdings"
  /** 指値が呼値に合わない・値幅の外・基準の価格がない銘柄（docs/MARKET_DESIGN.md §2） */
  | "invalid_price"
  /** 停止中のAI。validateSheet は返さず、追記の処理が使う（docs/EVENT_LOG.md §4） */
  | "suspended";

export type FillStatus = "filled" | "reduced" | "expired";
export type FillReason =
  | "insufficient_cash"
  | "insufficient_holdings"
  | "no_open_price"
  /** 指値が、約定の価格に届かない（買いは価格が指値より高い、売りは安い） */
  | "limit_not_reached"
  /** 板寄せで、その日の価格がつかなかった（docs/MARKET_DESIGN.md §3 の3） */
  | "no_price"
  /** 板寄せで、同じ側の注文が多く、優先の順で回らなかった（§3 の4） */
  | "outmatched"
  /** 臨時休場の日の注文票を閉じるとき。executeSheet は返さず、追記の処理が使う（docs/EVENT_LOG.md §3.3） */
  | "market_closed";

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
