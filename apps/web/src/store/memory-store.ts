// メモリ上の EventStore（#25 の前半。契約は src/contracts/event-store.ts、規則は D-034・EVENT_LOG §4）。
// 既存の EventLog（追記の検査）と Ledger（口座の再計算）を包む。DB（Postgres）は #20 の判断待ちなので、
// ファイルやDBへの書き出しはしない。保存済みのイベントの列からの作り直し（fromEvents）だけを用意する。
import type { Clock, CommitResult, DraftInput, EventStore, SheetInput } from "../contracts";
import { EventLog, type AppendResult } from "../events/append";
import { Ledger, type ValueStore } from "../events/replay";
import type { LogEvent } from "../events/types";
import type { HolidayTable } from "../holidays/table";
import type { Account } from "../ledger/types";

/**
 * DB の保管（pg-store.ts）だけが使う口の名前。呼び出し側が作ったイベントを時計を通さずに取り込めてしまうので、
 * 普通の名前の公開メソッドにはしない（D-034）。
 */
export const ADOPT = Symbol("InMemoryEventStore.adopt");

/** limit を省いたときに1回の read で返す件数の上限 */
export const READ_MAX = 1000;

/**
 * 追記だけの保管。追記は1件ずつ直列にし、その中で Clock から recordedAt を一度だけ決めて EventLog の検査を通す。
 * 呼び出し側が実行時に recordedAt を渡しても無視する。書けたイベントは同じ直列の中で台帳（Ledger）にも当て、
 * 注文票の検査（validateSheet）はその口座で行う。返すイベントは sealEvent が深く凍結したもの。
 *
 * 台帳が断るイベント（ログの外の値がない・ハッシュが合わない、約定・板寄せ・分割配当・評価の中身が再計算と違う）は、
 * 書く前に Ledger.check（状態を変えずに apply と同じ計算をする）で確かめて ok: false で返す（EVENT_LOG §4「1つでも満たさなければ書かない」・§7）。
 * read・last・account は、台帳に当て終えたイベントまでを見せる。
 * それでも書いた後に台帳が断ったら（内部の食い違い）、その後の追記をすべて断る。
 */
export class InMemoryEventStore implements EventStore {
  private readonly log: EventLog;
  private readonly ledger: Ledger;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped: string | null = null;
  /** 台帳に当て終えたイベントの数。読む側にはここまでを見せる */
  private applied = 0;

  /**
   * values：ログの外の値（prices.* などの valuesHash で引く）。追記する側が、追記より前に入れておく。
   * holidayTables：採用してよい祝日の一覧（版 → 一覧）。clock：時計の権威（本番で偽の時計を注入しない）
   */
  constructor(
    values: ValueStore,
    holidayTables: ReadonlyMap<string, HolidayTable>,
    private readonly clock: Clock,
    private readonly readMax = READ_MAX,
  ) {
    if (!Number.isInteger(readMax) || readMax < 1) throw new RangeError("readMax must be an integer >= 1");
    this.ledger = new Ledger(values);
    this.log = new EventLog({ holidayTables, accountOf: (id) => this.ledger.account(id) });
  }

  /**
   * 保存済みのイベントの列から作り直す（起動時。EVENT_LOG §8の4）。各イベントを EventLog.admit（追記と同じ検査と、
   * 記録と同じハッシュになること）に通してから台帳に当てる。どれかが通らなければ例外で、保管は作らない。
   * 時計が最後のイベントの recordedAt より前なら、追記できないので例外。
   */
  static async fromEvents(events: readonly LogEvent[], values: ValueStore, holidayTables: ReadonlyMap<string, HolidayTable>, clock: Clock, readMax = READ_MAX): Promise<InMemoryEventStore> {
    const store = new InMemoryEventStore(values, holidayTables, clock, readMax);
    await store[ADOPT](events);
    const last = events.at(-1);
    if (last && !(clock.now() >= last.recordedAt)) throw new RangeError("clock is earlier than the last recordedAt");
    return store;
  }

  /**
   * 保存済みのイベントを、いまの末尾の続きとして取り込む（DB の保管が、別の処理の書いた分に追いつくのにも使う。ADOPT の説明を参照）。
   * 各イベントを EventLog.admit に通してから台帳に当てる。通らなければ例外。時計は見ない（追記が断る）。
   */
  async [ADOPT](events: readonly LogEvent[]): Promise<void> {
    for (const e of events) {
      const problem = await this.log.admit(e);
      if (problem) throw new Error(problem);
      await this.ledger.apply(e);
      this.applied++;
    }
  }

  async read(afterSeq = 0, limit = this.readMax): Promise<readonly LogEvent[]> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new RangeError("afterSeq must be an integer >= 0");
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer >= 1");
    // seq は 1 から連番なので、afterSeq 番目の次から切り出せる
    return this.log.events.slice(0, this.applied).slice(afterSeq, afterSeq + Math.min(limit, this.readMax));
  }

  async last(): Promise<LogEvent | null> {
    return this.log.events[this.applied - 1] ?? null;
  }

  /** AIの口座の写し（書き換えても保管は変わらない）。未登録のAIや、台帳が止まっていれば例外 */
  account(agentId: string): Account {
    return this.ledger.account(agentId);
  }

  append(draft: DraftInput): Promise<AppendResult> {
    return this.serial(async () => {
      // 台帳が断るイベントは書かない。check は状態を変えずに apply と同じ計算をする（同じ直列の中で呼ぶ）。
      // 追記の検査より先に呼ぶので、両方が断るときは台帳の理由が返る
      const refused = await this.ledger.check(draft);
      if (refused) return { ok: false, reason: refused };
      // 時計の値を最後に置く（実行時に混ざった recordedAt を上書きする。D-034）
      return this.log.append({ ...draft, recordedAt: this.clock.now() });
    });
  }

  commitSheet(agentId: string, sheet: SheetInput): Promise<CommitResult> {
    return this.serial(() => this.log.commitSheet(this.clock.now(), agentId, sheet));
  }

  /** 1件ずつ直列に書き、書けたイベントを台帳に当てる。前の失敗は次に伝えない */
  private serial<T extends AppendResult>(write: () => Promise<T>): Promise<T> {
    const run = async () => {
      if (this.stopped) throw new Error(`store stopped: ${this.stopped}`);
      const before = this.log.events.length;
      try {
        const r = await write();
        if (r.ok) {
          await this.ledger.apply(r.event);
          this.applied++;
        }
        return r;
      } catch (err) {
        // ログに足した後の失敗は、ログと台帳がずれるので止める（イベントは書かれている。読む側には見せない）
        if (this.log.events.length !== before) this.stopped = `event seq ${before + 1} was written but the ledger failed`;
        throw err;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
