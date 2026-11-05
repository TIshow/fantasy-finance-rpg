// 約定・拒否の理由と状態の表示名（画面の共通）
export const REASON: Record<string, string> = {
  insufficient_cash: "現金不足", insufficient_holdings: "保有不足", no_open_price: "始値なし", market_closed: "休場",
  invalid_sheet: "注文票の不備", after_cutoff: "締め切り後", wrong_trading_date: "約定日の誤り", account_not_ready: "口座の準備前",
  already_committed: "確定済み", invalid_order: "注文の不備", unknown_symbol: "対象外の銘柄", invalid_qty: "数量の不備", suspended: "停止中",
};
export const STATUS = { filled: "約定", reduced: "一部のみ約定", expired: "失効" } as const;
