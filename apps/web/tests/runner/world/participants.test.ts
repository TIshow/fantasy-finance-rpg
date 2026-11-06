// 値をつきやすくする売買役の登録・最初の配分と、毎日の注文の記録（#113 PR-3a）
import { describe, expect, it } from "vitest";
import type { PriceObservation } from "../../../src/contracts";
import { verifyChain } from "../../../src/events/chain";
import { replay } from "../../../src/events/replay";
import type { LogEvent } from "../../../src/events/types";
import { IngestedMarketData, type SourceQuote } from "../../../src/ingest/market-data";
import { priceBand } from "../../../src/ledger/auction";
import { cutoffOf } from "../../../src/ledger/ledger";
import type { Order } from "../../../src/ledger/types";
import { runDay, scheduleOf } from "../../../src/runner/day";
import { RunnerValues } from "../../../src/runner/values";
import { COMPANIES, fairPrice, listingPrice, quarters } from "../../../src/runner/world/companies";
import { listCompanies } from "../../../src/runner/world/listing";
import { ALLOTMENT, NOISE_ID, liquidityAgents, makerId, setUpParticipants } from "../../../src/runner/world/participants";
import { InMemoryEventStore } from "../../../src/store/memory-store";
import { FakeClock } from "../../contracts/fakes";
import { FIXTURE_HOLIDAYS } from "../../fixtures/golden";
import { mulberry32 } from "../../fixtures/prng";
import { PRIOR_DAY, TRADING_DAYS, buildScenario } from "../../fixtures/scenario";

const SEED = 20261106;
const [VRN1, ORS1] = [COMPANIES[0]!, COMPANIES[1]!];
const toQuote = ({ fetchedAt: _, ...o }: PriceObservation): SourceQuote => o;
const p = (e: LogEvent) => e.payload as Record<string, unknown>;
const holidayTables = new Map([[FIXTURE_HOLIDAYS.contentSha256, FIXTURE_HOLIDAYS]]);
const IDS = [makerId("VRN1"), makerId("ORS1"), NOISE_ID];

/** PRIOR_DAY の締めのあとに上場した VRN1・ORS1（取引対象はこの2銘柄だけになる）。売買役は同じときに登録し、株を配る */
async function world(inputDays?: number) {
  const scenario = buildScenario(7);
  const clock = new FakeClock(0);
  const rand = mulberry32(5);
  const values = new RunnerValues(() => Uint8Array.from({ length: 16 }, () => Math.floor(rand() * 256)));
  const store = new InMemoryEventStore(values, holidayTables, clock);
  const market = new IngestedMarketData(clock);
  const pending = [...scenario.observations].sort((a, b) => a.fetchedAt - b.fetchedAt);
  const waitUntil = async (at: number) => {
    while (pending.length > 0 && pending[0]!.fetchedAt <= at) {
      const o = pending.shift()!;
      if (o.fetchedAt > clock.now()) clock.set(o.fetchedAt);
      market.capture([toQuote(o)]);
    }
    if (at > clock.now()) clock.set(at);
  };
  const deps = { store, market, values, holidayTables, agents: await liquidityAgents(SEED, [VRN1, ORS1]), clock, waitUntil, inputDays };
  await store.append({ type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 } });
  await store.append({ type: "universe.set", actor: "operator:owner", refs: [], payload: { symbols: [...scenario.symbols] } });
  clock.set(cutoffOf(PRIOR_DAY) + 3_600_000);
  await listCompanies(store, SEED, [VRN1, ORS1]);
  await setUpParticipants(store, TRADING_DAYS[0]!, [VRN1, ORS1]);
  await runDay(PRIOR_DAY, deps);
  const all = () => store.read(0, 100_000);
  return { clock, values, store, deps, all };
}

describe("setUpParticipants（売買役の登録と最初の配分）", async () => {
  const w = await world();
  const events = await w.all();

  it("マーケットメイカーは銘柄ごとに、ばらばらに売買する参加者は1つ、種類と最初の現金をつけて登録し、株を配る", () => {
    expect(events.filter((e) => e.type === "agent.registered").map((e) => [p(e).agentId, p(e).kind, p(e).initialCash, p(e).startDate])).toEqual([
      [makerId("VRN1"), "market_maker", ALLOTMENT.maker.cash, TRADING_DAYS[0]],
      [makerId("ORS1"), "market_maker", ALLOTMENT.maker.cash, TRADING_DAYS[0]],
      [NOISE_ID, "noise", ALLOTMENT.noise.cash, TRADING_DAYS[0]],
    ]);
    expect(events.filter((e) => e.type === "shares.allotted").map((e) => [p(e).agentId, p(e).symbol, p(e).qty])).toEqual([
      [makerId("VRN1"), "VRN1", 5_000],
      [makerId("ORS1"), "ORS1", 5_000],
      [NOISE_ID, "VRN1", 1_000],
      [NOISE_ID, "ORS1", 1_000],
    ]);
    // 取得原価は上場の価格 × 株数で、現金は動かない
    expect(w.store.account(NOISE_ID)).toEqual({
      cash: 300_000_000,
      holdings: { VRN1: { qty: 1_000, cost: listingPrice(SEED, VRN1) * 1_000 }, ORS1: { qty: 1_000, cost: listingPrice(SEED, ORS1) * 1_000 } },
    });
  });

  it("呼び直しても二重に書かない", async () => {
    await setUpParticipants(w.store, TRADING_DAYS[0]!, [VRN1, ORS1]);
    expect((await w.all()).length).toBe(events.length);
  });

  it("同じ ID で別の種類の参加者が登録済みなら、株を配らずに例外", async () => {
    const store = new InMemoryEventStore(w.values, holidayTables, new FakeClock(cutoffOf(PRIOR_DAY) + 3_600_000));
    await store.append({ type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 } });
    await listCompanies(store, SEED, [VRN1]);
    await store.append({ type: "agent.registered", actor: "operator:owner", refs: [], payload: { agentId: makerId("VRN1"), displayName: "x", startDate: TRADING_DAYS[0], initialCash: 100_000_000 } });
    await expect(setUpParticipants(store, TRADING_DAYS[0]!, [VRN1])).rejects.toThrow(`agent.registered ${makerId("VRN1")}: already registered as investor`);
    expect((await store.read()).some((e) => e.type === "shares.allotted")).toBe(false);
  });
});

describe("runDay（入力の日数より前の価格が値幅の基準のとき）", () => {
  it("板寄せの入力を1日に切っても、値幅の基準は価格のついた直近の板寄せで、注文票は拒否されない", async () => {
    const w = await world(1);
    for (const d of TRADING_DAYS) await runDay(d, w.deps);
    const events = await w.all();
    expect(events.filter((e) => e.type === "order_sheet.rejected")).toEqual([]);
    const sheets = events.filter((e) => e.type === "order_sheet.committed" && p(e).agentId === makerId("VRN1"));
    for (const s of sheets) {
      const ref = events.filter((e) => e.type === "auction.cleared" && p(e).symbol === "VRN1" && p(e).price !== null && (p(e).date as string) < (p(s).tradingDate as string)).at(-1);
      if (ref) expect(p(s).inputSeqs).toContain(ref.seq);
    }
  });
});

describe("runDay（売買役の毎日の注文）", async () => {
  const w = await world();
  // 2日目の判断の前に、VRN1 の次の四半期の決算を発表する
  const q1 = quarters(SEED, VRN1, 2)[1]!;
  await runDay(TRADING_DAYS[0]!, w.deps);
  await w.store.append({ type: "company.disclosed", actor: "system", refs: [], payload: { symbol: "VRN1", period: "2026-Q4", revenue: q1.revenue, netIncome: q1.netIncome, eps: q1.eps, dividendPerShare: q1.dividendPerShare } });
  for (const d of TRADING_DAYS.slice(1)) await runDay(d, w.deps);
  const events = await w.all();
  const of = (type: LogEvent["type"]) => events.filter((e) => e.type === type);
  const output = (run: LogEvent) => JSON.parse(w.values.body(p(run).outputHash as string)!.value) as { orders: Order[]; note: string };

  it("毎日、締めの前に、売買役ごとに規則の判断の記録（agent.run）と注文票を書く", () => {
    for (const d of TRADING_DAYS) {
      const sheets = of("order_sheet.committed").filter((e) => p(e).tradingDate === d);
      expect(sheets.map((e) => p(e).agentId)).toEqual(IDS);
      for (const s of sheets) {
        expect(s.recordedAt).toBeLessThan(cutoffOf(d));
        const run = events[(p(s).runSeq as number) - 1]!;
        expect(p(run)).toMatchObject({ agentId: p(s).agentId, purpose: "order", ok: true, model: { provider: "rule" } });
        // 注文を決める値は、記録の settings に残る
        expect((p(run).model as { settings: Record<string, string> }).settings).toMatchObject(p(s).agentId === NOISE_ID ? { seed: String(SEED) } : { qtyPerLevel: "300", target: "5000" });
        expect(output(run).orders).toEqual(p(s).orders);
      }
    }
    expect(of("order_sheet.rejected")).toEqual([]);
  });

  it("マーケットメイカーは自分の銘柄の指値を、値幅の内側に出し、入力に上場の記録と前の日までの板寄せを入れる", () => {
    const sheets = of("order_sheet.committed").filter((e) => p(e).agentId === makerId("VRN1"));
    // 初日は買いと売りを3段ずつ。決算の発表で目安の価格が値幅の下限より下がった日は、下限の売りだけ
    expect((p(sheets[0]!).orders as Order[]).map((o) => o.side)).toEqual(["sell", "sell", "sell", "buy", "buy", "buy"]);
    // 値幅は、2日目の前で価格のついた直近の板寄せ（なければ上場の価格）から決まる
    const day1 = of("auction.cleared").find((e) => p(e).symbol === "VRN1" && p(e).date === p(sheets[0]!).tradingDate)!;
    const ref = (p(day1).price as number | null) ?? listingPrice(SEED, VRN1);
    expect(p(sheets[1]!).orders).toEqual([{ symbol: "VRN1", side: "sell", qty: 900, limit: priceBand(ref).lower }]);
    for (const s of sheets) {
      const orders = p(s).orders as Order[];
      const prev = of("auction.cleared").filter((e) => p(e).symbol === "VRN1" && (p(e).date as string) < (p(s).tradingDate as string));
      const band = priceBand((prev.map((e) => p(e).price as number | null).filter((x) => x !== null).at(-1) ?? listingPrice(SEED, VRN1)) as number);
      for (const o of orders) expect(o.symbol === "VRN1" && o.limit! >= band.lower && o.limit! <= band.upper).toBe(true);
      const listed = of("company.listed").find((e) => p(e).symbol === "VRN1")!;
      expect(p(s).inputSeqs).toEqual(expect.arrayContaining([listed.seq, ...prev.map((e) => e.seq)]));
    }
  });

  it("目安の価格は、発表済みの決算から出す（発表の前の日は上場の価格）", () => {
    const notes = of("agent.run").filter((e) => p(e).agentId === makerId("VRN1")).map((e) => output(e).note);
    expect(notes[0]).toBe(`fair ${listingPrice(SEED, VRN1)} from 0 disclosed quarters, held 5000`);
    const disclosed = of("company.disclosed")[0]!;
    expect(notes[1]).toMatch(new RegExp(`^fair ${fairPrice(VRN1, [{ ...q1, index: 0 }])} from 1 disclosed quarters`));
    const run = of("agent.run").filter((e) => p(e).agentId === makerId("VRN1"))[1]!;
    expect(p(run).inputSeqs).toContain(disclosed.seq);
  });

  it("売買役の注文で板寄せに価格がつき、約定・評価・引け後の処理まで進む。replay の台帳が保管と一致する", async () => {
    expect(of("auction.cleared").some((e) => p(e).price !== null && (p(e).volume as number) > 0)).toBe(true);
    expect(of("valuation.recorded").filter((e) => IDS.includes(p(e).agentId as string)).length).toBe(TRADING_DAYS.length * IDS.length);
    expect(await verifyChain(events)).toEqual([]);
    const ledger = await replay(events, w.values, { holidayTables });
    for (const id of IDS) expect(ledger.account(id)).toEqual(w.store.account(id));
  });

  it("同じ日をもう一度回しても、二重に書かない", async () => {
    await w.deps.waitUntil(scheduleOf(TRADING_DAYS.at(-1)!).closeAt + 3_600_000);
    await runDay(TRADING_DAYS.at(-1)!, w.deps);
    expect((await w.all()).length).toBe(events.length);
  });
});
