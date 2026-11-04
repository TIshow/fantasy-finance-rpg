// 契約（src/contracts）のメモリ上の簡単な偽物。platform・web のテストが、契約だけに依存して使える。
import type { Clock, CommitResult, DraftInput, EventStore, LlmPolicy, LlmPort, LlmRequest, LlmResult, MarketDataPort, MarketView, PriceObservation, SheetInput } from "../../src/contracts";
import type { EventLog } from "../../src/events/append";
import type { LogEvent } from "../../src/events/types";
import type { Deciyen } from "../../src/ledger/types";

/** 日本時間の日時を UNIXミリ秒にする */
export const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);

/** 日本時間の暦日 */
export const jstDay = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

export class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
  set(t: number) {
    this.t = t;
  }
}

/** 直列に実行する（EVENT_LOG §4 のトランザクションの代わり）。前の失敗は次に伝えない */
class Serial {
  private queue: Promise<unknown> = Promise.resolve();
  run<T>(f: () => Promise<T>): Promise<T> {
    const r = this.queue.then(f, f);
    this.queue = r.catch(() => undefined);
    return r;
  }
}

/**
 * EventLog の検査を通して追記するだけの保管。追記は1件ずつ直列にし、その中で Clock から recordedAt を決める。
 * 呼び出し側は時刻を渡せない
 */
export class MemoryEventStore implements EventStore {
  private readonly serial = new Serial();

  constructor(
    private readonly log: EventLog,
    private readonly clock: Clock,
  ) {}

  async read(afterSeq = 0, limit = Infinity): Promise<readonly LogEvent[]> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new RangeError("afterSeq must be an integer >= 0");
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new RangeError("limit must be an integer >= 1");
    return this.log.events.filter((e) => e.seq > afterSeq).slice(0, limit);
  }

  async last(): Promise<LogEvent | null> {
    return this.log.events.at(-1) ?? null;
  }

  append(draft: DraftInput) {
    return this.serial.run(() => this.log.append({ ...draft, recordedAt: this.clock.now() }));
  }

  commitSheet(agentId: string, sheet: SheetInput): Promise<CommitResult> {
    return this.serial.run(() => this.log.commitSheet(this.clock.now(), agentId, sheet));
  }
}

const KIND_ORDER = { open: 0, close: 1 } as const;

/** 観測を持ち、時点 at の窓には publishedAt < at のものだけを見せる。at が現在時刻より後なら RangeError */
export class MemoryMarketData implements MarketDataPort {
  constructor(
    private readonly all: readonly PriceObservation[],
    private readonly clock: Clock,
  ) {}

  asOf(at: number): MarketView {
    if (!Number.isFinite(at) || at > this.clock.now()) throw new RangeError("asOf is later than now");
    const visible = (symbol: string) =>
      this.all
        .filter((o) => o.symbol === symbol && o.publishedAt < at)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.publishedAt - b.publishedAt || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]));
    return {
      at,
      history: async (symbol, limit) => {
        const v = visible(symbol);
        return limit === undefined ? v : v.slice(Math.max(0, v.length - limit));
      },
      latest: async (symbol, kind) => visible(symbol).filter((o) => o.kind === kind).at(-1) ?? null,
    };
  }
}

/** 決まった返事を順に返すLLM。1回の費用は costPerCall（maxCost で頭打ち）。判定と予約は直列に行う */
export class FakeLlm implements LlmPort {
  readonly calls: LlmRequest[] = [];
  private readonly spentByDay = new Map<string, Deciyen>();
  private readonly serial = new Serial();
  private n = 0;

  constructor(
    readonly policy: LlmPolicy,
    private readonly clock: Clock,
    private readonly replies: readonly string[],
    private readonly costPerCall: Deciyen,
  ) {}

  async spent(day: string): Promise<Deciyen> {
    return this.spentByDay.get(day) ?? 0;
  }

  complete(request: LlmRequest): Promise<LlmResult> {
    return this.serial.run(async () => {
      const startedAt = this.clock.now();
      const day = jstDay(startedAt);
      const used = this.spentByDay.get(day) ?? 0;
      if (used + request.maxCost > this.policy.dailyCostLimit) {
        return { ok: false, errorCode: "budget_exceeded", usage: { inputTokens: 0, outputTokens: 0, cost: 0 }, startedAt, finishedAt: startedAt };
      }
      this.calls.push(request);
      const cost = Math.min(this.costPerCall, request.maxCost);
      this.spentByDay.set(day, used + cost);
      const output = this.replies[this.n++ % this.replies.length] ?? "";
      return { ok: true, output, usage: { inputTokens: 10, outputTokens: output.length, cost }, respondedModel: `${request.model.modelId}-fake`, startedAt, finishedAt: this.clock.now() };
    });
  }
}
