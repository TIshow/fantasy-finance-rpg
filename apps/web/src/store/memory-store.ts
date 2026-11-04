// メモリ上の EventStore（#25 の前半。契約は src/contracts/event-store.ts、規則は D-034・EVENT_LOG §4）。
// 既存の EventLog（追記の検査）と Ledger（口座の再計算）を包む。DB（Postgres）は #20 の判断待ちなので、
// ファイルやDBへの書き出しはしない。保存済みのイベントの列からの作り直し（fromEvents）だけを用意する。
import type { Clock, CommitResult, DraftInput, EventStore, SheetInput } from "../contracts";
import { EventLog, type AppendResult } from "../events/append";
import { canonicalize } from "../events/canonical";
import { bodyHash } from "../events/hash";
import { Ledger, type ValueStore } from "../events/replay";
import type { LogEvent } from "../events/types";
import type { HolidayTable } from "../holidays/table";
import { INITIAL_CASH, type Account } from "../ledger/types";

/** limit を省いたときに1回の read で返す件数の上限 */
export const READ_MAX = 1000;

/**
 * 追記だけの保管。追記は1件ずつ直列にし、その中で Clock から recordedAt を一度だけ決めて EventLog の検査を通す。
 * 呼び出し側が実行時に recordedAt を渡しても無視する。書けたイベントは同じ直列の中で台帳（Ledger）にも当て、
 * 注文票の検査（validateSheet）はその口座で行う。返すイベントは sealEvent が深く凍結したもの。
 *
 * 台帳が断るイベント（ログの外の値がない・ハッシュが合わない、約定・分割配当・評価の中身が再計算と違う）は、
 * 書く前に同じ計算（Ledger.compute*）で確かめて ok: false で返す（EVENT_LOG §4「1つでも満たさなければ書かない」・§7）。
 * read・last・account は、台帳に当て終えたイベントまでを見せる。
 * それでも書いた後に台帳が断ったら（内部の食い違い）、その後の追記をすべて断る。
 */
export class InMemoryEventStore implements EventStore {
  private readonly log: EventLog;
  private readonly ledger: Ledger;
  private readonly values: ValueStore;
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
    this.values = values;
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
    for (const e of events) {
      const problem = await store.log.admit(e);
      if (problem) throw new Error(problem);
      await store.ledger.apply(e);
      store.applied++;
    }
    const last = events.at(-1);
    if (last && !(clock.now() >= last.recordedAt)) throw new RangeError("clock is earlier than the last recordedAt");
    return store;
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
      const refused = await this.ledgerRefuses(draft);
      if (refused) return { ok: false, reason: refused };
      // 時計の値を最後に置く（実行時に混ざった recordedAt を上書きする。D-034）
      return this.log.append({ ...draft, recordedAt: this.clock.now() });
    });
  }

  commitSheet(agentId: string, sheet: SheetInput): Promise<CommitResult> {
    return this.serial(() => this.log.commitSheet(this.clock.now(), agentId, sheet));
  }

  /**
   * 台帳がこのイベントを断るなら理由。Ledger.apply が確かめることを、書く前に同じ計算で確かめる。
   * 値の形の検査は replay.ts の isPrices・isAnnouncement と同じ（core に、書く前の検査を Ledger に出す口を頼む）
   */
  private async ledgerRefuses(d: DraftInput): Promise<string | null> {
    const p = d.payload;
    try {
      switch (d.type) {
        case "agent.registered":
          return p.initialCash === INITIAL_CASH ? null : "initialCash must be INITIAL_CASH";
        case "prices.open":
        case "prices.close":
        case "corporate_action.announced": {
          const v = typeof p.valuesHash === "string" ? this.values.get(p.valuesHash) : undefined;
          if (!v) return "values are not available";
          if ((await bodyHash(v.salt, { value: v.value })) !== p.valuesHash) return "values do not match valuesHash";
          return (d.type === "corporate_action.announced" ? isAnnouncement(v.value) : isPrices(v.value)) ? null : `values have the wrong shape for ${d.type}`;
        }
        case "fills.executed": {
          const r = await this.ledger.computeFills(p.agentId as string, p.sheetSeq as number, p.openSeq as number | undefined);
          return same({ fills: p.fills, accountHash: p.accountHash }, r.payload) ? null : "fills do not match the ledger";
        }
        case "corporate_actions.applied": {
          const r = await this.ledger.computeCorporate(p.agentId as string, p.asOf as string, p.exDate as string, p.announcedSeqs as number[]);
          return same({ actions: p.actions, accountHash: p.accountHash }, r.payload) ? null : "corporate actions do not match the ledger";
        }
        case "valuation.recorded":
          return same({ cash: p.cash, positions: p.positions, total: p.total }, this.ledger.computeValuation(p.agentId as string, p.date as string)) ? null : "valuation does not match the ledger";
        default:
          return null;
      }
    } catch (err) {
      return err instanceof Error ? err.message : "ledger refused the event";
    }
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

const same = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);
const posInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isPrices = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => x === null || posInt(x));
function isAnnouncement(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  if (a.kind === "split") return posInt(a.from) && posInt(a.to);
  return a.kind === "dividend" && typeof a.perShare === "number" && Number.isSafeInteger(a.perShare) && a.perShare >= 0;
}
