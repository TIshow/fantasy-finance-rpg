// 画面に出す形（読み取り用のモデル）。金額は台帳の値（0.1円単位の整数）と、表示用の文字列の両方を持つ。
import type { ParticipantKind } from "../ledger/types";
import type { Intent, Stance } from "./body";
import type { MarketView } from "./market";
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
  | (Base & { kind: "post"; symbol: string; text: string | null; intent: Intent | null; stance: Stance | null; withdrawn: { seq: number; reason: string } | null; citeSeqs: number[]; replyTo: number | null; runSeq: number; dryRun: boolean })
  | (Base & { kind: "order_sheet"; tradingDate: string; runSeq: number; orders: { symbol: string; side: Side; qty: number }[] })
  | (Base & { kind: "fill"; fillIndex: number; sheetSeq: number; tradingDate: string; symbol: string; side: Side; requestedQty: number; qty: number; price: Deciyen | null; priceText: string | null; status: FillStatus; reason?: FillReason })
  | (Base & { kind: "valuation"; date: string; cash: Deciyen; positions: ValuedPosition[]; total: Deciyen; totalText: string; change: Deciyen; changeText: string })
  | (Base & { kind: "rejected"; tradingDate: string; reason: RejectReason; runSeq: number | null })
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

/** AIが読める情報の記録（source.captured と終値）。投稿の citeSeqs が指す */
export interface Evidence {
  seq: number;
  /** other は、投稿が引用した出典以外の記録（投稿・評価など）。post は引用された投稿 */
  kind: "source" | "close" | "post" | "other";
  label: string;
  /** 終値の記録には公開時刻がない */
  publishedAt: number | null;
  /** 記録に取得時刻がなければ null（記録時刻を取得時刻として見せない） */
  fetchedAt: number | null;
}

/** 判断の記録（agent.run）に残ったモデル。AIごとに、最後に成功した判断（ok が false でないもの）のもの */
export interface AgentModel {
  agentId: string;
  provider: string;
  modelId: string;
  /** その判断を記録した時刻（UNIXミリ秒） */
  at: number;
  /** 成功した判断の中で、提供元かモデルIDが途中で変わったことがあるか */
  changed: boolean;
}

/** 判断の記録1件（成功・失敗を問わない）。投稿や注文票の runSeq から、そのときのモデルを引くのに使う */
export interface RunModel {
  seq: number;
  agentId: string;
  provider: string;
  modelId: string;
  /** 記録された時刻 */
  at: number;
  /** 判断に成功したか（ok が false のものだけ失敗。ない記録は成功扱い） */
  ok: boolean;
  /** 失敗したときのエラーコード（timeout・budget_exceeded など。ないか文字列でなければ null） */
  errorCode: string | null;
  /** 試運転（注文を出さない実行）か。dryRun が true のときだけ true、ない記録は本番 */
  dryRun: boolean;
  /** 目的（post・order）。ないか文字列でなければ null */
  purpose: string | null;
}

export interface View {
  timeline: TimelineItem[];
  /** 架空の市場の記録（上場・板寄せ・決算）。記録がなければ companies は空 */
  market: MarketView;
  /** 登録された参加者の種類。順位・カードを AI投資家だけに絞るのに使う（#126 の3本目） */
  participants: { agentId: string; kind: ParticipantKind }[];
  evidence: Evidence[];
  threads: SymbolThread[];
  agents: AgentPerformance[];
  /** 判断の記録のあるAIのモデル（AIのID順） */
  models: AgentModel[];
  /** 判断の記録の全件（seq の順）。判断ごとのモデルを引く */
  runs: RunModel[];
  /** 取引対象の記号（universe.set の最後のもの）。銘柄の掲示板として知っている記号 */
  universe: string[];
}
