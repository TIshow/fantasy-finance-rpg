// メモリ上の EventStore（#25 の前半。契約は src/contracts/event-store.ts、規則は D-034・EVENT_LOG §4）。
// 既存の EventLog（追記の検査）と Ledger（口座の再計算）を包む。DB（Postgres）は #20 の判断待ちなので、
// ファイルやDBへの書き出しはしない。保存済みのイベントの列からの作り直し（fromEvents）だけを用意する。
import type { Clock, CommitResult, DraftInput, EventStore, SheetInput } from "../contracts";
import { EventLog, type AppendResult } from "../events/append";
import { Ledger, type ValueStore } from "../events/replay";
import type { LogEvent } from "../events/types";
import type { HolidayTable } from "../holidays/table";
import type { Account } from "../ledger/types";

/** limit を省いたときに1回の read で返す件数の上限 */
export const READ_MAX = 1000;

/**
 * 追記だけの保管。追記は1件ずつ直列にし、その中で Clock から recordedAt を一度だけ決めて EventLog の検査を通す。
 * 呼び出し側が実行時に recordedAt を渡しても無視する。書けたイベントは同じ直列の中で台帳（Ledger）にも当て、
 * 注文票の検査（validateSheet）はその口座で行う。返すイベントは sealEvent が深く凍結したもの。
 *
 * 台帳に当てられなかったら（ログの外の値がない、記録と再計算が食い違うなど）、その後の追記はすべて断る
 * （イベントはログに残るが、口座が進まないまま注文票を検査しないため）。
 */
export class InMemoryEventStore implements EventStore {
  private readonly log: EventLog;
  private readonly ledger: Ledger;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped: string | null = null;

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
   */
  static async fromEvents(events: readonly LogEvent[], values: ValueStore, holidayTables: ReadonlyMap<string, HolidayTable>, clock: Clock, readMax = READ_MAX): Promise<InMemoryEventStore> {
    const store = new InMemoryEventStore(values, holidayTables, clock, readMax);
    for (const e of events) {
      const problem = await store.log.admit(e);
      if (problem) throw new Error(problem);
      await store.ledger.apply(e);
    }
    return store;
  }

  async read(afterSeq = 0, limit = this.readMax): Promise<readonly LogEvent[]> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new RangeError("afterSeq must be an integer >= 0");
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer >= 1");
    // seq は 1 から連番なので、afterSeq 番目の次から切り出せる
    return this.log.events.slice(afterSeq, afterSeq + Math.min(limit, this.readMax));
  }

  async last(): Promise<LogEvent | null> {
    return this.log.events.at(-1) ?? null;
  }

  /** AIの口座の写し（書き換えても保管は変わらない）。未登録のAIや、台帳が止まっていれば例外 */
  account(agentId: string): Account {
    return this.ledger.account(agentId);
  }

  append(draft: DraftInput): Promise<AppendResult> {
    // 時計の値を最後に置く（実行時に混ざった recordedAt を上書きする。D-034）
    return this.serial(() => this.log.append({ ...draft, recordedAt: this.clock.now() }));
  }

  commitSheet(agentId: string, sheet: SheetInput): Promise<CommitResult> {
    return this.serial(() => this.log.commitSheet(this.clock.now(), agentId, sheet));
  }

  /** 1件ずつ直列に書き、書けたイベントを台帳に当てる。前の失敗は次に伝えない */
  private serial<T extends AppendResult>(write: () => Promise<T>): Promise<T> {
    const run = async () => {
      if (this.stopped) throw new Error(`store stopped: ${this.stopped}`);
      const r = await write();
      if (r.ok) {
        try {
          await this.ledger.apply(r.event);
        } catch (err) {
          this.stopped = `ledger failed at seq ${r.event.seq}`;
          throw err;
        }
      }
      return r;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
