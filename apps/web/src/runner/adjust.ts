// 分割で調整した終値の列（#27 の lead 判断）。判断の入力のイベント（終値と分割の公表）だけから作る純関数。
// 調整した値はログに書かない（入力の seq から誰でも作り直せる）。価格データそのものは調整しない値のまま（PAPER_TRADING_RULES §5）
import { splitAdjustedPrice } from "../ledger/corporate";
import type { CloseInput } from "./day";

/** 分割の公表（corporate_action.announced の seq と、ログの外の値の from・to） */
export interface SplitInput {
  seq: number;
  symbol: string;
  exDate: string;
  from: number;
  to: number;
}

/**
 * 権利落ち日より前の終値を、分割に合わせて from/to 倍にする（0.1円未満は四捨五入。§5）。
 * 複数の分割は権利落ち日・seq の順に1つずつ当てる（同じ入力なら同じ列）。値がない日（null）はそのまま
 */
export function adjustCloses(closes: readonly CloseInput[], splits: readonly SplitInput[]): CloseInput[] {
  const ordered = [...splits].sort((a, b) => (a.exDate === b.exDate ? a.seq - b.seq : a.exDate < b.exDate ? -1 : 1));
  return closes.map((c) => {
    const prices = { ...c.prices };
    for (const s of ordered) {
      const v = prices[s.symbol];
      if (c.date < s.exDate && typeof v === "number") prices[s.symbol] = splitAdjustedPrice(v, s);
    }
    return { ...c, prices };
  });
}
