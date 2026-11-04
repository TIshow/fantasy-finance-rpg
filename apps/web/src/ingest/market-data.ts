// 市場データの取り込み口と、その観測を時点ごとの窓で見せる MarketDataPort の実装（#26、契約は src/contracts/market-data.ts）。
// 取得元（MarketSource）は差し替えられる。実データの取得元と利用許諾は P-001 が未決なので、今は架空のデータ（staticSource）だけで動かす。
// 観測は追記だけで持ち（今はメモリ。保存先は #20 で決める）、書き換え・削除の口は作らない。
import type { Clock, MarketDataPort, MarketView, PriceObservation } from "../contracts";

/**
 * 取得元が返す1件。fetchedAt は持たない（取り込みが Clock から入れる。取得元の値や入力から取らない）。
 * publishedAt は取得元の公開時刻で、分からなければ null。revisedAt は取得元が改訂の時刻を出すときだけ入れる。
 */
export interface SourceQuote {
  symbol: string;
  date: string;
  kind: "open" | "close";
  price: number | null;
  /** 終値の出来高（株）。始値では無視する */
  volume?: number | null;
  publishedAt: number | null;
  revisedAt?: number | null;
  source: string;
}

/** 差し替えられる取得元。外部と通信する実装は P-001 の決定まで作らない */
export interface MarketSource {
  fetch(): Promise<readonly SourceQuote[]>;
}

/** 決まった観測を返すだけの取得元（架空のデータ用）。外部とは通信しない */
export function staticSource(quotes: readonly SourceQuote[]): MarketSource {
  const copy = quotes.map((q) => ({ ...q }));
  return { fetch: async () => copy.map((q) => ({ ...q })) };
}

export type QuoteRejectReason = "invalid_quote" | "unknown_published_at" | "published_after_fetch" | "invalid_revised_at" | "duplicate_in_batch";

export interface CaptureResult {
  fetchedAt: number;
  /** 新しい版として足した観測（初めての観測と改訂） */
  added: PriceObservation[];
  /** 最新の版と同じ値で、足さなかった件数 */
  unchanged: number;
  rejected: { quote: SourceQuote; reason: QuoteRejectReason }[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** 暦の上にある日付（2026-13-45 などを断る） */
const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !DATE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};
const isAmount = (v: unknown) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
const KIND_ORDER = { open: 0, close: 1 } as const;
const keyOf = (o: { symbol: string; date: string; kind: string }) => `${o.symbol}\u0000${o.date}\u0000${o.kind}`;
const volumeOf = (o: PriceObservation) => (o.kind === "close" ? o.volume : undefined);

/** 契約の並び：(date, publishedAt, kind, fetchedAt) の昇順 */
const compare = (a: PriceObservation, b: PriceObservation) =>
  (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.publishedAt - b.publishedAt || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.fetchedAt - b.fetchedAt;

/** 窓に見せてよい観測。取り込みで検査済みだが、窓の側でも確かめる */
const visibleAt = (o: PriceObservation, at: number) => isTime(o.publishedAt) && isTime(o.fetchedAt) && o.publishedAt <= o.fetchedAt && o.publishedAt < at && o.fetchedAt < at;

/**
 * 取り込んだ観測を版ごとに追記して持ち、asOf(at) で publishedAt < at かつ fetchedAt < at の観測だけを見せる。
 * clock は時計の権威（本番で偽の時計を注入しない）。fetchedAt と、asOf の「現在時刻より後は断る」の両方に使う。
 */
export class IngestedMarketData implements MarketDataPort {
  /** 観測したすべての版（凍結済み）。追記だけ */
  private readonly versions: PriceObservation[] = [];
  /** (銘柄, 日, 種類) ごとの最新の版 */
  private readonly latestByKey = new Map<string, PriceObservation>();
  /** capture と asOf が見た Clock の最大値。これより前の fetchedAt を足すと、渡した窓の中身が後から変わるので断る */
  private highWater = -Infinity;

  constructor(private readonly clock: Clock) {}

  /** 取得元から取り、取り終えた時刻を fetchedAt にして取り込む */
  async ingest(source: MarketSource): Promise<CaptureResult> {
    return this.capture(await source.fetch());
  }

  /**
   * 取得した観測を取り込む。fetchedAt はここで Clock から一度だけ取る（同期なので、途中に別の取り込みは挟まらない）。
   * - 公開時刻が分からない・fetchedAt より後の観測は足さない（窓が返せないため。rejected に理由を残す）
   * - 最新の版と値（価格・出来高・出典）が同じなら足さない
   * - 値が違えば改訂として新しい版を足す。元の版は残す。改訂の publishedAt は取得元の revisedAt（元の版の fetchedAt 以上に限る）、なければ fetchedAt
   *   （こちらが改訂を最初に観測した時刻。取得元の古い publishedAt を使うと、過去の窓に改訂後の値が見えるため）
   * - 同じ取り込みの中で同じ (銘柄, 日, 種類) が2件以上あれば、どれも足さない（どちらが正しいか決められない）
   * Clock が、前回の取り込みや asOf で見た時刻より前に戻っていたら、何も足さずに RangeError
   * （後から過去の fetchedAt を作らない。渡した窓に、後から観測が増えない）。
   */
  capture(quotes: readonly SourceQuote[]): CaptureResult {
    const fetchedAt = this.clock.now();
    if (!isTime(fetchedAt) || fetchedAt < this.highWater) throw new RangeError("clock went backwards or is not a time");
    this.highWater = fetchedAt;
    const result: CaptureResult = { fetchedAt, added: [], unchanged: 0, rejected: [] };
    const counts = new Map<string, number>();
    for (const q of quotes) counts.set(keyOf(q), (counts.get(keyOf(q)) ?? 0) + 1);
    for (const quote of quotes) {
      const outcome = (counts.get(keyOf(quote)) ?? 0) > 1 ? "duplicate_in_batch" : this.toVersion(quote, fetchedAt);
      if (typeof outcome === "string") result.rejected.push({ quote, reason: outcome });
      else if (outcome === null) result.unchanged++;
      else {
        this.versions.push(outcome);
        this.latestByKey.set(keyOf(outcome), outcome);
        result.added.push(outcome);
      }
    }
    return result;
  }

  /** 新しい版、同じ値なら null、足せなければ理由 */
  private toVersion(q: SourceQuote, fetchedAt: number): PriceObservation | null | QuoteRejectReason {
    if (typeof q.symbol !== "string" || q.symbol === "" || !isDate(q.date)) return "invalid_quote";
    if ((q.kind !== "open" && q.kind !== "close") || typeof q.source !== "string" || q.source === "" || !isAmount(q.price)) return "invalid_quote";
    const volume = q.kind === "close" ? (q.volume ?? null) : undefined;
    if (volume !== undefined && !isAmount(volume)) return "invalid_quote";
    if (!isTime(q.publishedAt)) return "unknown_published_at";

    const prev = this.latestByKey.get(keyOf(q));
    let publishedAt = q.publishedAt;
    if (prev) {
      if (prev.price === q.price && volumeOf(prev) === volume && prev.source === q.source) return null;
      if (q.revisedAt == null) publishedAt = fetchedAt;
      // 元の版を取得した時刻には、取得元はまだ元の値を出していた。それより前の改訂時刻は、見たことと矛盾する
      else if (!isTime(q.revisedAt) || q.revisedAt < prev.fetchedAt) return "invalid_revised_at";
      else publishedAt = q.revisedAt;
    }
    if (publishedAt > fetchedAt) return "published_after_fetch";

    const base = { symbol: q.symbol, date: q.date, price: q.price, publishedAt, fetchedAt, source: q.source };
    return Object.freeze(q.kind === "close" ? { ...base, kind: "close" as const, volume: volume ?? null } : { ...base, kind: "open" as const });
  }

  asOf(at: number): MarketView {
    const now = this.clock.now();
    if (!isTime(now)) throw new RangeError("clock is not a time");
    if (!Number.isFinite(at) || at > now) throw new RangeError("asOf is later than now");
    this.highWater = Math.max(this.highWater, now);
    const visible = (symbol: string) => this.versions.filter((o) => o.symbol === symbol && visibleAt(o, at)).sort(compare);
    return Object.freeze({
      at,
      history: async (symbol: string, limit?: number) => {
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new RangeError("limit must be an integer >= 1");
        const v = visible(symbol);
        return limit === undefined ? v : v.slice(Math.max(0, v.length - limit));
      },
      latest: async (symbol: string, kind: "open" | "close") => visible(symbol).filter((o) => o.kind === kind).at(-1) ?? null,
    });
  }
}
