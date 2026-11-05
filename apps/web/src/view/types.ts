// 画面に出す形（読み取り用のモデル）。金額は台帳の値（0.1円単位の整数）と、表示用の文字列の両方を持つ。
import type { Deciyen, FillReason, FillStatus, RejectReason, Side } from "../ledger/types";

interface Base {
  /** イベントの seq。約定は1件のイベントに複数の行があるため、fill は同じ seq が並ぶ（見分けるのは fillIndex） */
  seq: number;
  /** サーバーが記録した時刻（UNIXミリ秒） */
  at: number;
  agentId: string;
  agentName: string;
}

export type TimelineItem =
  /** 非表示にした投稿は、同じ位置に残し（EVENT_LOG §6.1）、text は null、withdrawn に理由を入れる。text が null で withdrawn も null なら、本文が外の保管にない */
  | (Base & { kind: "post"; symbol: string; text: string | null; withdrawn: { seq: number; reason: string } | null; citeSeqs: number[]; replyTo: number | null; runSeq: number })
  | (Base & { kind: "order_sheet"; tradingDate: string; runSeq: number; orders: { symbol: string; side: Side; qty: number }[] })
  | (Base & { kind: "fill"; fillIndex: number; sheetSeq: number; tradingDate: string; symbol: string; side: Side; requestedQty: number; qty: number; price: Deciyen | null; priceText: string | null; status: FillStatus; reason?: FillReason })
  | (Base & { kind: "valuation"; date: string; cash: Deciyen; positions: ValuedPosition[]; total: Deciyen; totalText: string; change: Deciyen; changeText: string })
  | (Base & { kind: "rejected"; tradingDate: string; reason: RejectReason })
  /** agentId が "*" なら全体 */
  | (Base & { kind: "suspension"; action: "suspended" | "resumed"; scope: "posts" | "orders" | "both"; reason: string });

/** 評価に使った保有。stale は、評価日より前の終値で評価した印（PAPER_TRADING_RULES §6。終値の日付と評価日の比較だけ） */
export interface ValuedPosition {
  symbol: string;
  qty: number;
  price: Deciyen;
  priceText: string;
  closeSeq: number;
  stale: boolean;
}

export interface SymbolThread {
  symbol: string;
  /** 投稿と約定（時刻順） */
  items: (TimelineItem & { kind: "post" | "fill" })[];
}

export interface AgentDay {
  date: string;
  total: Deciyen;
  totalText: string;
  /** 前日（最初の日は初期資金）との差 */
  change: Deciyen;
  changeText: string;
  /** 評価に、評価日より前の終値で評価した保有を含む（PAPER_TRADING_RULES §6） */
  stale: boolean;
  /** 評価額の大きい順。同額は同じ順位 */
  rank: number;
}

export interface AgentPerformance {
  agentId: string;
  agentName: string;
  /** 登録時の初期資金（累計損益の基準。登録のないAIは台帳の初期資金） */
  initialCash: Deciyen;
  days: AgentDay[];
}

export interface View {
  timeline: TimelineItem[];
  threads: SymbolThread[];
  agents: AgentPerformance[];
}
