// 約定・拒否の理由と状態の表示名（画面の共通）。理由を足したときに表示を付け忘れないよう、型のすべての理由を書く
import type { FillReason, RejectReason } from "../ledger/types";

export const REASON: Record<FillReason | RejectReason, string> = {
  insufficient_cash: "現金が足りなかった",
  insufficient_holdings: "売る株が足りなかった",
  no_open_price: "始値がなかった",
  market_closed: "休場だった",
  limit_not_reached: "指値に届かなかった",
  no_price: "その日は値段がつかなかった",
  outmatched: "ほかの注文が優先された",
  invalid_sheet: "注文票の不備",
  after_cutoff: "締め切りに間に合わなかった",
  wrong_trading_date: "約定日が違った",
  account_not_ready: "口座の準備ができていなかった",
  already_committed: "すでに確定していた",
  invalid_order: "注文の不備",
  unknown_symbol: "対象外の銘柄だった",
  invalid_qty: "数量の不備",
  invalid_price: "指値が呼値・値幅に合わなかった",
  suspended: "停止中だった",
};
export const STATUS = { filled: "約定", reduced: "一部のみ約定", expired: "失効" } as const;
