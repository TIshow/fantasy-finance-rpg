// 架空の企業の上場と、上場した銘柄の毎日の板寄せ（#113 PR-2）
import { describe, expect, it } from "vitest";
import type { EventStore, PriceObservation } from "../../../src/contracts";
import { verifyChain } from "../../../src/events/chain";
import { replay } from "../../../src/events/replay";
import type { LogEvent } from "../../../src/events/types";
import { IngestedMarketData, type SourceQuote } from "../../../src/ingest/market-data";
import { cutoffOf } from "../../../src/ledger/ledger";
import { INITIAL_CASH } from "../../../src/ledger/types";
import { type RunnerAgent, runDay, scheduleOf } from "../../../src/runner/day";
import { RunnerValues } from "../../../src/runner/values";
import { COMPANIES, listingPrice } from "../../../src/runner/world/companies";
import { listCompanies } from "../../../src/runner/world/listing";
import { InMemoryEventStore } from "../../../src/store/memory-store";
import { FakeClock } from "../../contracts/fakes";
import { FIXTURE_HOLIDAYS } from "../../fixtures/golden";
import { mulberry32 } from "../../fixtures/prng";
import { PRIOR_DAY, TRADING_DAYS, buildScenario } from "../../fixtures/scenario";

const SEED = 20261106;
const [VRN1, ORS1, MRH1] = [COMPANIES[0]!, COMPANIES[1]!, COMPANIES[2]!];
const toQuote = ({ fetchedAt: _, ...o }: PriceObservation): SourceQuote => o;
const p = (e: LogEvent) => e.payload as Record<string, unknown>;
const holidayTables = new Map([[FIXTURE_HOLIDAYS.contentSha256, FIXTURE_HOLIDAYS]]);

function newStore(clock = new FakeClock(0)) {
  const rand = mulberry32(5);
  const values = new RunnerValues(() => Uint8Array.from({ length: 16 }, () => Math.floor(rand() * 256)));
  return { clock, values, store: new InMemoryEventStore(values, holidayTables, clock) };
}

describe("listCompanies（上場の記録）", () => {
  it("上場の記録を書いてから取引対象に加える。取引対象のほかの銘柄は残し、呼び直しても二重にならない", async () => {
    const { store } = newStore();
    await store.append({ type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 } });
    await store.append({ type: "universe.set", actor: "operator:owner", refs: [], payload: { symbols: ["TSTA"] } });
    expect(await listCompanies(store, SEED, [VRN1, ORS1])).toEqual({ listed: ["VRN1", "ORS1"], universeSet: true });
    const events = await store.read();
    expect(events.slice(2).map((e) => e.type)).toEqual(["company.listed", "company.listed", "universe.set"]);
    expect(p(events[2]!)).toEqual({ symbol: "VRN1", name: "ヴェルナ電機", sector: "電機", sharesOutstanding: VRN1.sharesOutstanding, price: listingPrice(SEED, VRN1) });
    expect(p(events[4]!).symbols).toEqual(["ORS1", "TSTA", "VRN1"]);
    expect(await listCompanies(store, SEED, [VRN1, ORS1])).toEqual({ listed: [], universeSet: false });
    expect((await store.read()).length).toBe(5);
  });

  it("書けない企業（TST で始まる銘柄）なら、理由つきの例外", async () => {
    const { store } = newStore();
    await store.append({ type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 } });
    await expect(listCompanies(store, SEED, [{ ...VRN1, symbol: "TSTZ" }])).rejects.toThrow("company.listed TSTZ: symbols starting with TST are for tests");
  });

  it("上場の記録のあと、取引対象に加える前に落ちていても、呼び直せば加える", async () => {
    const { store } = newStore();
    await store.append({ type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 } });
    await store.append({ type: "company.listed", actor: "system", refs: [], payload: { symbol: "MRH1", name: MRH1.name, sector: "電力・水道", sharesOutstanding: MRH1.sharesOutstanding, price: listingPrice(SEED, MRH1) } });
    expect(await listCompanies(store, SEED, [MRH1])).toEqual({ listed: [], universeSet: true });
    expect(p((await store.last())!).symbols).toEqual(["MRH1"]);
  });
});

/** 初日に、上場した VRN1 の買い（成行と指値）と TSTA の買いを出すAI */
const buyer: RunnerAgent = {
  id: "ai-a",
  model: { provider: "rule", modelId: "scripted", settings: {} },
  prompt: { id: "scripted", version: "1", hash: "0".repeat(64) },
  decide: (input) => ({
    orders:
      input.tradingDate === TRADING_DAYS[0]
        ? [
            { symbol: "VRN1", side: "buy", qty: 100 },
            { symbol: "VRN1", side: "buy", qty: 100, limit: listingPrice(SEED, VRN1) },
            { symbol: "TSTA", side: "buy", qty: 100 },
          ]
        : [],
    post: null,
    note: "",
  }),
};

/**
 * TST の銘柄と、上場した VRN1・ORS1 を取引対象にした世界。上場は前営業日（PRIOR_DAY）の締めのあとなので、板寄せは初日から。
 * held の観測は release() まで取り込まない。crashOnce の銘柄の板寄せは、1回だけ書く前に落ちる
 */
async function world(opts: { held?: (o: PriceObservation) => boolean; crashOnce?: string } = {}) {
  const scenario = buildScenario(7);
  const { clock, values, store } = newStore();
  const market = new IngestedMarketData(clock);
  const pending = [...scenario.observations].sort((a, b) => a.fetchedAt - b.fetchedAt);
  const held: PriceObservation[] = [];
  const waitUntil = async (at: number) => {
    while (pending.length > 0 && pending[0]!.fetchedAt <= at) {
      const o = pending.shift()!;
      if (o.fetchedAt > clock.now()) clock.set(o.fetchedAt);
      if (opts.held?.(o)) held.push(o);
      else market.capture([toQuote(o)]);
    }
    if (at > clock.now()) clock.set(at);
  };
  let crash = opts.crashOnce;
  const wrapped: EventStore = {
    read: (a, l) => store.read(a, l),
    last: () => store.last(),
    commitSheet: (id, sheet) => store.commitSheet(id, sheet),
    append: async (d) => {
      if (d.type === "auction.cleared" && d.payload.symbol === crash) {
        crash = undefined;
        throw new Error("crashed");
      }
      return store.append(d);
    },
  };
  const deps = { store: wrapped, market, values, holidayTables, agents: [buyer], clock, waitUntil };
  await store.append({ type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 } });
  await store.append({ type: "universe.set", actor: "operator:owner", refs: [], payload: { symbols: [...scenario.symbols] } });
  clock.set(cutoffOf(PRIOR_DAY) + 3_600_000);
  await listCompanies(store, SEED, [VRN1, ORS1]);
  await runDay(PRIOR_DAY, deps);
  await waitUntil(scheduleOf(PRIOR_DAY).closeAt + 3 * 3_600_000);
  await store.append({ type: "agent.registered", actor: "operator:owner", refs: [], payload: { agentId: "ai-a", displayName: "ai-a", startDate: TRADING_DAYS[0], initialCash: INITIAL_CASH } });
  const all = () => store.read(0, 100_000);
  // 取り込んだ観測は、取り込みの時刻より後にだけ見える（窓の決まり）ので、時計を1分進める
  const release = () => {
    market.capture(held.splice(0).map(toQuote));
    clock.set(clock.now() + 60_000);
  };
  return { scenario, clock, values, store, deps, all, release };
}

describe("runDay（上場した銘柄があるとき）", async () => {
  const w = await world();
  for (const d of TRADING_DAYS) await runDay(d, w.deps);
  const events = await w.all();
  const of = (type: LogEvent["type"]) => events.filter((e) => e.type === type);

  it("上場した銘柄ごとに、毎日、締めのあとに板寄せの結果を書く。その日の全員の注文票を渡す。上場より前の日の板寄せはない", () => {
    const auctions = of("auction.cleared");
    expect(auctions.map((e) => [p(e).date, p(e).symbol])).toEqual(TRADING_DAYS.flatMap((d) => [[d, "ORS1"], [d, "VRN1"]]));
    for (const a of auctions) {
      expect(a.recordedAt).toBeGreaterThanOrEqual(cutoffOf(p(a).date as string));
      const sheets = of("order_sheet.committed").filter((e) => p(e).tradingDate === p(a).date).map((e) => e.seq);
      expect(p(a).sheetSeqs).toEqual(sheets);
    }
    // 売る人がいない（最初の配分は core の PR-2c のあと）ので、価格はつかない
    expect(auctions.every((e) => p(e).price === null && p(e).volume === 0)).toBe(true);
    // 上場した銘柄の始値・終値は外から取り込まない
    for (const e of [...of("prices.open"), ...of("prices.close")]) expect(Object.keys(w.values.get(p(e).valuesHash as string)!.value as object).sort()).toEqual([...w.scenario.symbols]);
  });

  it("上場した銘柄の注文は板寄せの結果で、ほかの銘柄の注文は始値で約定する。replay の台帳が保管と一致する", async () => {
    const first = of("fills.executed").find((e) => p(e).tradingDate === TRADING_DAYS[0])!;
    const vrn = of("auction.cleared").find((e) => p(e).date === TRADING_DAYS[0] && p(e).symbol === "VRN1")!;
    expect(p(first).auctionSeqs).toEqual([vrn.seq]);
    expect(first.refs).toEqual([p(first).sheetSeq, p(first).openSeq, vrn.seq]);
    expect((p(first).fills as { symbol: string; status: string; reason?: string }[]).map((f) => [f.symbol, f.status, f.reason])).toEqual([
      ["VRN1", "expired", "no_price"],
      ["VRN1", "expired", "no_price"],
      ["TSTA", "filled", undefined],
    ]);
    // 上場した銘柄の注文がない日は、板寄せを指さない
    expect(of("fills.executed").filter((e) => e !== first).every((e) => p(e).auctionSeqs === undefined)).toBe(true);
    expect(await verifyChain(events)).toEqual([]);
    const ledger = await replay(events, w.values, { holidayTables });
    expect(ledger.account("ai-a")).toEqual(w.store.account("ai-a"));
    expect(of("valuation.recorded").length).toBe(TRADING_DAYS.length);
  });

  it("同じ日をもう一度回しても、板寄せも約定も二重にならない", async () => {
    await runDay(TRADING_DAYS.at(-1)!, w.deps);
    expect((await w.all()).length).toBe(events.length);
  });
});

describe("runDay（上場した銘柄の、途中で止まったときの続き）", () => {
  const [d0, d1, d2] = TRADING_DAYS;

  it("回さなかった日があり、追いつきが前の日で止まっていても、後の日の板寄せを先に書かない。そろえば古い順に書く", async () => {
    // d0 の終値を遅らせ、d1 は回さない
    const w = await world({ held: (o) => o.date === d0 && o.kind === "close" });
    await runDay(d0, w.deps);
    await w.deps.waitUntil(scheduleOf(d1).closeAt);
    const r = await runDay(d2, w.deps);
    expect(r).toContainEqual({ stage: "open", status: "waiting", detail: `auctions of ${d1} not done: ORS1,VRN1` });
    expect((await w.all()).filter((e) => e.type === "auction.cleared").map((e) => p(e).date)).toEqual([d0, d0]);
    w.release();
    await runDay(d2, w.deps);
    expect((await w.all()).filter((e) => e.type === "auction.cleared").map((e) => p(e).date)).toEqual([d0, d0, d1, d1, d2, d2]);
  });

  it("2銘柄のうち1銘柄の板寄せだけ書いて落ちても、回し直せば残りの板寄せと約定を書く", async () => {
    const w = await world({ crashOnce: "VRN1" });
    await expect(runDay(d0, w.deps)).rejects.toThrow("crashed");
    expect((await w.all()).filter((e) => e.type === "auction.cleared").map((e) => p(e).symbol)).toEqual(["ORS1"]);
    await runDay(d0, w.deps);
    const events = await w.all();
    expect(events.filter((e) => e.type === "auction.cleared").map((e) => p(e).symbol)).toEqual(["ORS1", "VRN1"]);
    expect(events.filter((e) => e.type === "fills.executed").map((e) => p(e).tradingDate)).toEqual([d0]);
  });
});
