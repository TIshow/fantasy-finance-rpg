import { describe, expect, it } from "vitest";
import type { Clock, PriceObservation } from "../../src/contracts";
import { IngestedMarketData, type SourceQuote, staticSource } from "../../src/ingest/market-data";
import { describeMarketDataContract } from "../contracts/conformance";
import { FakeClock, jst } from "../contracts/fakes";
import { buildScenario } from "../fixtures/scenario";

/** 観測の fetchedAt を取得元の値にしない（取り込みが Clock から入れる）ので、取得元の形に戻す */
const toQuote = ({ fetchedAt: _, ...o }: PriceObservation): SourceQuote => ({ ...o, publishedAt: Number.isFinite(o.publishedAt) ? o.publishedAt : null });

/**
 * 試験の観測を、fetchedAt の時刻に取り込んだことにする。取り込みの間だけ時計をその時刻にし、終わったら契約の時計に戻す。
 * fetchedAt が数でない観測は、その時刻に取り込めないので足さない（窓が返さないことと同じ）
 */
function ingestAt(observations: readonly PriceObservation[], clock: Clock) {
  let override: number | null = null;
  const port = new IngestedMarketData({ now: () => override ?? clock.now() });
  for (const o of [...observations].filter((o) => Number.isFinite(o.fetchedAt)).sort((a, b) => a.fetchedAt - b.fetchedAt)) {
    override = o.fetchedAt;
    port.capture([toQuote(o)]);
  }
  override = null;
  return port;
}

describeMarketDataContract("IngestedMarketData", ingestAt);

const close = (price: number, publishedAt: number | null, extra: Partial<SourceQuote> = {}): SourceQuote => ({ symbol: "TSTA", date: "2026-11-10", kind: "close", price, volume: 1000, publishedAt, source: "fixture", ...extra });
const T = jst("2026-11-10", 15, 30);

describe("IngestedMarketData の取り込み", () => {
  it("fetchedAt は取り込んだときの Clock の値で、取得元が渡した値は使わない", async () => {
    const clock = new FakeClock(T + 5_000);
    const port = new IngestedMarketData(clock);
    const r = await port.ingest(staticSource([{ ...close(1_010_0, T), fetchedAt: T } as SourceQuote]));
    expect(r.fetchedAt).toBe(T + 5_000);
    expect(r.added.map((o) => o.fetchedAt)).toEqual([T + 5_000]);
    clock.set(T + 10_000);
    expect(await port.asOf(T + 5_000).history("TSTA")).toEqual([]);
    expect((await port.asOf(T + 5_001).latest("TSTA", "close"))?.price).toBe(1_010_0);
  });

  it("同じ値は版を足さない。改訂は元を残し、改訂の時刻がなければ最初に観測した時刻を publishedAt にする", async () => {
    const clock = new FakeClock(T + 1_000);
    const port = new IngestedMarketData(clock);
    port.capture([close(1_010_0, T)]);
    clock.set(T + 2_000);
    expect(port.capture([close(1_010_0, T)])).toMatchObject({ added: [], unchanged: 1 });
    clock.set(T + 3_600_000);
    const revised = port.capture([close(1_011_0, T)]).added; // 取得元は古い公開時刻のまま
    expect(revised.map((o) => [o.price, o.publishedAt, o.fetchedAt])).toEqual([[1_011_0, T + 3_600_000, T + 3_600_000]]);
    clock.set(T + 7_200_000);
    expect((await port.asOf(T + 3_600_000).latest("TSTA", "close"))?.price).toBe(1_010_0); // 過去の窓は改訂前のまま
    expect((await port.asOf(T + 3_600_001).history("TSTA")).map((o) => o.price)).toEqual([1_010_0, 1_011_0]);
  });

  it("取得元の改訂時刻を使う。元の版を取得した時刻より前・数でない改訂時刻は断る", () => {
    const clock = new FakeClock(T + 1_000);
    const port = new IngestedMarketData(clock);
    port.capture([close(1_010_0, T)]);
    clock.set(T + 7_200_000);
    const bad = [close(1_012_0, T, { revisedAt: T + 500 }), close(1_013_0, T, { revisedAt: NaN })].map((q) => port.capture([q]));
    expect(bad.flatMap((r) => r.rejected.map((x) => x.reason))).toEqual(["invalid_revised_at", "invalid_revised_at"]);
    const r = port.capture([close(1_011_0, T, { revisedAt: T + 1_800_000 })]);
    expect(r.added.map((o) => [o.price, o.publishedAt])).toEqual([[1_011_0, T + 1_800_000]]);
  });

  it("公開時刻が分からない・取り込みより後に公開・形の壊れた観測は足さず、理由を返す", () => {
    const port = new IngestedMarketData(new FakeClock(T));
    const quotes = [close(1_010_0, null), close(1_010_0, T + 1), close(1.5, T), close(1_010_0, T, { date: "11/10" }), close(1_010_0, T, { date: "2026-13-45" }), close(1_010_0, T, { volume: -1 })];
    const results = quotes.map((q) => port.capture([q]));
    expect(results.flatMap((r) => r.added)).toEqual([]);
    expect(results.flatMap((r) => r.rejected.map((x) => x.reason))).toEqual(["unknown_published_at", "published_after_fetch", "invalid_quote", "invalid_quote", "invalid_quote", "invalid_quote"]);
  });

  it("同じ取り込みに同じ銘柄・日・種類が2件あれば、どちらも足さない", () => {
    const port = new IngestedMarketData(new FakeClock(T + 1_000));
    const r = port.capture([close(1_010_0, T), close(1_011_0, T), close(1_000_0, T, { kind: "open" })]);
    expect(r.added.map((o) => o.kind)).toEqual(["open"]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["duplicate_in_batch", "duplicate_in_batch"]);
  });

  it("渡した窓は、後の取り込みや改訂で中身が変わらない。窓を渡した時刻より前に時計が戻ったら取り込みを断る", async () => {
    const clock = new FakeClock(T + 1_000);
    const port = new IngestedMarketData(clock);
    port.capture([close(1_010_0, T)]);
    clock.set(T + 10_000);
    const view = port.asOf(T + 10_000);
    const before = await view.history("TSTA");
    clock.set(T + 5_000); // 時計の巻き戻り（NTP の補正など）
    expect(() => port.capture([close(1_011_0, T)])).toThrow(RangeError);
    clock.set(T + 10_000);
    port.capture([close(1_012_0, T)]); // ちょうど at に取得したものは見えない
    expect(await view.history("TSTA")).toEqual(before);
    expect(() => new IngestedMarketData({ now: () => NaN }).asOf(0)).toThrow(RangeError);
  });

  it("時計が前回の取り込みより前に戻ったら、何も足さずに断る", () => {
    const clock = new FakeClock(T + 2_000);
    const port = new IngestedMarketData(clock);
    port.capture([close(1_010_0, T)]);
    clock.set(T + 1_000);
    expect(() => port.capture([close(1_011_0, T)])).toThrow(RangeError);
    clock.set(T + 3_000);
    expect(port.capture([close(1_010_0, T)]).unchanged).toBe(1);
  });

  it("始値の出来高は捨てる。返す観測は凍結していて、書き換えても保管に響かない", async () => {
    const clock = new FakeClock(T);
    const port = new IngestedMarketData(clock);
    port.capture([{ symbol: "TSTA", date: "2026-11-10", kind: "open", price: 1_000_0, volume: 5, publishedAt: T - 1, source: "fixture" }]);
    clock.set(T + 1);
    const [o] = await port.asOf(T + 1).history("TSTA");
    expect(o && "volume" in o).toBe(false);
    expect(Object.isFrozen(o)).toBe(true);
  });

  it("架空のシナリオを取得の時刻どおりに取り込むと、判断の時点では判断した日の終値までしか見えない", async () => {
    const scenario = buildScenario(1);
    const clock = new FakeClock(0);
    const port = new IngestedMarketData(clock);
    for (const fetchedAt of [...new Set(scenario.observations.map((o) => o.fetchedAt))].sort((a, b) => a - b)) {
      clock.set(fetchedAt);
      const batch = scenario.observations.filter((o) => o.fetchedAt === fetchedAt).map(toQuote);
      expect((await port.ingest(staticSource(batch))).rejected).toEqual([]);
    }
    for (const plan of scenario.plans) {
      const view = port.asOf(plan.decideAt);
      for (const symbol of scenario.symbols) {
        expect((await view.latest(symbol, "close"))?.date).toBe(plan.decidedOn);
        expect((await view.history(symbol)).every((o) => o.date <= plan.decidedOn)).toBe(true);
      }
    }
  });
});
