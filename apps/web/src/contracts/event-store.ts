// 外側とのつなぎ目の契約：イベントの保管（docs/EVENT_LOG.md §4・§8の4）。型だけ。
// 追記だけの保管で、更新・削除の口は作らない。訂正は新しいイベントを足して表す（§6）。
import type { AppendResult, Draft } from "../events/append";
import type { EventType, LogEvent } from "../events/types";
import type { Order, RejectReason } from "../ledger/types";

/**
 * 読むだけの口。画面（web）には、追記の口を渡さずにこれだけを渡す。
 * AIの判断の入力も、ここから読んだイベント（seq つき）だけを使う。入力の seq が agent.run に残り、
 * 追記の処理が時点の検査をかけられる（§3.2）。市場データの窓（MarketDataPort）から直接プロンプトを組まない。
 *
 * 内部用：P-001（データの権利）が決まるまで、第三者（外部の利用者・公開APIなど）には出さない。
 *
 * 返す LogEvent は、凍結済みか複製で、書き換えても保管に影響しない（型は readonly にしない。
 * replay(events: readonly LogEvent[]) など、既存の関数の引数に響くため）。呼び出し側は書き換えない。
 */
export interface EventReader {
  /**
   * seq が afterSeq より大きいイベントを、seq の昇順で最大 limit 件返す。afterSeq は 0 以上の整数（既定 0）、
   * limit は 1 以上の整数。外れた値は RangeError。limit を省くと、実装の上限（実装が決める。1回の読みで全件を返すとは限らない）まで返す。
   * 全件を読むには、返った最後の seq を次の afterSeq にして、空の配列が返るまで繰り返す。
   */
  read(afterSeq?: number, limit?: number): Promise<readonly LogEvent[]>;
  /** 最後の1件。まだ何もなければ null */
  last(): Promise<LogEvent | null>;
}

/** 確定する注文票。確定時刻は保管が時計から入れ、AIの出力や呼び出し側から取らない */
export interface SheetInput {
  tradingDate: string;
  orders: Order[];
  /** 元になった agent.run の seq */
  runSeq: number;
  /** 判断に使った入力の seq（runSeq の入力の一部でなければならない） */
  inputSeqs: number[];
}

/**
 * commitSheet の結果。ok: false は何も書けなかった（理由は reason）。
 * ok: true で rejected があるときは、注文票が拒否され、order_sheet.rejected を**記録した**という意味（event はその拒否の記録）。
 * ok: true で rejected がなければ、order_sheet.committed を記録した。
 */
export type CommitResult = AppendResult & { rejected?: RejectReason };

/**
 * 呼び出し側が決める部分。recordedAt は保管が決める（下の EventStore）。
 * 注文票（order_sheet.committed・order_sheet.rejected）は commitSheet からだけ書けるので、type から除く。
 */
export type DraftInput = Omit<Draft, "recordedAt" | "type"> & {
  type: Exclude<EventType, "order_sheet.committed" | "order_sheet.rejected">;
};

/**
 * 追記だけのイベントの保管。
 * - 追記のたびに、直列化したトランザクションの中で、保管が持つ Clock（時計の権威は保管の1つ。clock.ts）から
 *   recordedAt を一度だけ決め、EventLog の検査（append・commitSheet）を通す（§4）。呼び出し側は時刻を渡せない。
 *   締めの検査（validateSheet）は、この時刻で行われる。検査に通らないものは書かず、理由を返す。
 * - seq・prevHash・hash も保管が付ける。
 * - 書き手（actor）は、本来は認証した身元から入れる。その分け方は保存先と一緒に決める（#20、§3.2）。
 *   それまでは、追記の口を持つ者がすべての書き手を名乗れるので、追記の口は信頼できる処理（runner・ingest）にだけ渡す。
 * - 起動時は、保存済みのログを先頭から読み、EventLog.admit に通して状態を作り直す。採用した祝日の一覧は版ごとに
 *   残し、AppendContext.holidayTables に渡す（§3.5・§8の4）。これらは保管の実装（platform）の仕事で、契約には出さない。
 */
export interface EventStore extends EventReader {
  /** 注文票以外のイベントを足す */
  append(draft: DraftInput): Promise<AppendResult>;
  /** 注文票を確定する。検査に通らなければ order_sheet.rejected を残す（§4） */
  commitSheet(agentId: string, sheet: SheetInput): Promise<CommitResult>;
}

/**
 * 注文を出せない保管。試運転（LlmPolicy.dryRun）の間、runner に渡す。投稿と agent.run は書けるが、注文票は確定できない。
 *
 * これは型の上の便宜であって、保証ではない：実体の EventStore はそのまま代入できる（commitSheet が実体に残る）。
 * 保証は runner（#29）の仕事：dryRun のとき、commitSheet を持たない凍結したオブジェクトを返す工場関数で
 * OrderlessEventStore を作り、runner にはそれだけを渡す。
 */
export type OrderlessEventStore = Omit<EventStore, "commitSheet">;
