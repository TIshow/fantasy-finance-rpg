// 契約（src/contracts）のメモリ上の簡単な偽物。platform・web のテストが、契約だけに依存して使える。
import type { Clock, CommitResult, DraftInput, EventStore, LlmErrorCode, LlmPolicy, LlmPort, LlmRequest, LlmResult, MarketDataPort, MarketView, PriceObservation, SheetInput } from "../../src/contracts";
import type { EventLog } from "../../src/events/append";
import type { LogEvent } from "../../src/events/types";
import type { Deciyen } from "../../src/ledger/types";

/** 日本時間の日時を UNIXミリ秒にする */
export const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);

/** 日本時間の暦日 */
export const jstDay = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

/** テストが時刻を進められる時計。本番の保管には注入しない（clock.ts） */
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

/** この偽物が1回の read で返す件数の上限（limit を省いたとき） */
export const READ_MAX = 1000;

/**
 * EventLog の検査を通して追記するだけの保管。追記は1件ずつ直列にし、その中で Clock から recordedAt を決める。
 * 呼び出し側は時刻を渡せない。返すイベントは sealEvent が凍結したもの
 */
export class MemoryEventStore implements EventStore {
  private readonly serial = new Serial();

  constructor(
    private readonly log: EventLog,
    private readonly clock: Clock,
  ) {}

  async read(afterSeq = 0, limit = READ_MAX): Promise<readonly LogEvent[]> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new RangeError("afterSeq must be an integer >= 0");
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer >= 1");
    return this.log.events.filter((e) => e.seq > afterSeq).slice(0, Math.min(limit, READ_MAX));
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

/**
 * 観測を持ち、時点 at の窓には publishedAt < at のものだけを見せる。公開時刻が有限の数でない観測は返さない。
 * at が現在時刻より後なら RangeError
 */
export class MemoryMarketData implements MarketDataPort {
  constructor(
    private readonly all: readonly PriceObservation[],
    private readonly clock: Clock,
  ) {}

  asOf(at: number): MarketView {
    if (!Number.isFinite(at) || at > this.clock.now()) throw new RangeError("asOf is later than now");
    const visible = (symbol: string) =>
      this.all
        .filter((o) => o.symbol === symbol && Number.isFinite(o.publishedAt) && o.publishedAt < at)
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

/** 提供元の応答の代わり。cost: "unknown" は、課金されたか分からない失敗（timeout など） */
export type BackendReply =
  | { ok: true; output: string; cost: Deciyen; respondedModel?: string }
  | { ok: false; errorCode: Exclude<LlmErrorCode, "budget_exceeded" | "invalid_output">; cost: Deciyen | "unknown" };

/** 提供元を呼ぶ処理。テストは、解決を外から操作できる Promise を返して、呼び出し中の状態を確かめられる */
export type LlmBackend = (request: LlmRequest) => Promise<BackendReply>;

/** 決まった返事を順に返し、1回の費用は cost の提供元 */
export function scripted(replies: readonly string[], cost: Deciyen): LlmBackend {
  let n = 0;
  return async () => ({ ok: true, output: replies[n++ % replies.length] ?? "", cost });
}

const isCost = (v: unknown): v is Deciyen => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * 費用を予約して提供元を呼ぶLLM。使用済み（予約中を含む）＋maxCost が上限を超えるなら呼ばずに断る。
 * 判定と予約は同期で行い（間に await を挟まない）原子的。呼び出しは外に出し、直列にしない。
 * 精算は予約を実費に置き換える（実費が maxCost を超えても切り捨てない）。分からない失敗は maxCost を費用とする
 */
export class FakeLlm implements LlmPort {
  readonly calls: LlmRequest[] = [];
  private readonly spentByDay = new Map<string, Deciyen>();

  constructor(
    readonly policy: LlmPolicy,
    private readonly clock: Clock,
    private readonly backend: LlmBackend,
  ) {
    if (!isCost(policy.dailyCostLimit)) throw new RangeError("dailyCostLimit must be a non-negative safe integer");
  }

  async spent(day: string): Promise<Deciyen> {
    return this.spentByDay.get(day) ?? 0;
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    if (!isCost(request.maxCost)) throw new RangeError("maxCost must be a non-negative safe integer");
    const startedAt = this.clock.now();
    const day = jstDay(startedAt);
    const used = this.spentByDay.get(day) ?? 0;
    if (used + request.maxCost > this.policy.dailyCostLimit) {
      return { ok: false, errorCode: "budget_exceeded", usage: { inputTokens: 0, outputTokens: 0, cost: 0 }, startedAt, finishedAt: startedAt };
    }
    this.spentByDay.set(day, used + request.maxCost); // 予約
    this.calls.push(request);
    let reply: BackendReply;
    try {
      reply = await this.backend(request);
    } catch {
      reply = { ok: false, errorCode: "provider_error", cost: "unknown" };
    }
    const cost = reply.cost === "unknown" ? request.maxCost : reply.cost;
    this.spentByDay.set(day, (this.spentByDay.get(day) ?? 0) - request.maxCost + cost); // 精算：予約を実費に置き換える
    const usage = { inputTokens: 10, outputTokens: reply.ok ? reply.output.length : 0, cost };
    const finishedAt = this.clock.now();
    return reply.ok
      ? { ok: true, output: reply.output, usage, respondedModel: reply.respondedModel ?? `${request.model.modelId}-fake`, startedAt, finishedAt }
      : { ok: false, errorCode: reply.errorCode, usage, startedAt, finishedAt };
  }
}
