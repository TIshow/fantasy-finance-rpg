// 外側とのつなぎ目の契約：市場データ（docs/PAPER_TRADING_RULES.md §2、docs/EVENT_LOG.md §3.1）。型だけ。
// 用途は、取り込み（ingest）が prices.*・source.captured のイベントを書くこと。AIの判断の入力は、
// この窓から直接組まず、EventReader で読んだイベント（seq つき）から組む（event-store.ts）。
//
// 先読みを型で防ぐ：データは「時点 at を決めた窓（MarketView）」からしか引けず、窓は
// 公開時刻 publishedAt が at より前（等号を含まない。§3.2「締めより前」と同じ）の観測だけを返す。
// 窓に at より後を引く口はない。at が現在時刻（Clock）より後なら、実装は RangeError で断る。
// 取得元は差し替え可能。実データの取得元と利用許諾は P-001 が未決なので、ここでは決めない。
import type { Deciyen } from "../ledger/types";

interface ObservationBase {
  symbol: string;
  /** 取引日（YYYY-MM-DD、日本時間） */
  date: string;
  /** 0.1円単位の整数。値がない日は null（EVENT_LOG §5.1 の null と同じ意味） */
  price: Deciyen | null;
  /**
   * 市場（取得元）がこの値を公開した時刻（UNIXミリ秒）。窓はこれで絞る。
   * 公開時刻が分からない観測は返さない（EVENT_LOG §3.1。判断の入力に使えない）。
   */
  publishedAt: number;
  /**
   * 私たちがこの値を取得した時刻（UNIXミリ秒）。source.captured の publishedAt <= fetchedAt <= recordedAt を
   * 満たすために持つ（EVENT_LOG §3.1）。publishedAt 以上でなければならない。
   */
  fetchedAt: number;
  /** 出典の識別子（取得元・利用条件をたどれるもの） */
  source: string;
}

/** 始値の観測。出来高は持たない（1日の出来高は大引け後にしか分からないため、始値に載せられない） */
export interface OpenObservation extends ObservationBase {
  kind: "open";
}

/** 終値の観測。その日の出来高（株、取れなければ null）は、終値と同時に公開されたものとして持つ */
export interface CloseObservation extends ObservationBase {
  kind: "close";
  volume: number | null;
}

export type PriceObservation = OpenObservation | CloseObservation;

/**
 * 時点 at より前に公開されたデータだけの窓。返す観測は、すべて publishedAt < at。
 *
 * 改訂：取得元が値を改訂したら、元の観測を書き換えず、新しい観測として足す。その publishedAt は、
 * 取得元が改訂の時刻を出すならその時刻、出さないなら**こちらが最初に観測した時刻以上**にする
 * （名目の古い時刻を入れて、過去の窓に改訂後の値を見せない）。過去の窓を作れるよう、観測した版はすべて残す。
 */
export interface MarketView {
  /** この窓の時点（UNIXミリ秒） */
  readonly at: number;
  /** 銘柄の観測を、(date, publishedAt, 始値が先) の昇順で返す。limit（1以上）があれば新しい方から limit 件（返す順は昇順） */
  history(symbol: string, limit?: number): Promise<readonly PriceObservation[]>;
  /** 銘柄の kind ごとの、一番新しい観測（改訂があれば改訂後）。まだなければ null */
  latest(symbol: string, kind: "open" | "close"): Promise<PriceObservation | null>;
}

export interface MarketDataPort {
  /** 時点 at（UNIXミリ秒）の窓を返す。at 以後に公開されたデータは見えない。at が現在時刻より後なら RangeError */
  asOf(at: number): MarketView;
}
