// 架空の市場の通しの試験（#113 PR-3b）：6社の上場 → 最初の配分 → 毎日の注文 → 板寄せ → 約定 → 評価 → 決算の発表を、
// 10営業日回す。取引対象は6社だけで、外の始値・終値は使わない。外部通信・DB・LLM なし。
import { describe, expect, it } from "vitest";
import { verifyChain } from "../../../src/events/chain";
import { replay } from "../../../src/events/replay";
import type { LogEvent } from "../../../src/events/types";
import { IngestedMarketData } from "../../../src/ingest/market-data";
import { priceBand } from "../../../src/ledger/auction";
import { cutoffOf } from "../../../src/ledger/ledger";
import { INITIAL_CASH, type Order } from "../../../src/ledger/types";
import { type RunnerDeps, runDay, scheduleOf } from "../../../src/runner/day";
import { ruleAgents } from "../../../src/runner/rule-agents";
import { RunnerValues } from "../../../src/runner/values";
import { COMPANIES, listingPrice, quarters } from "../../../src/runner/world/companies";
import { QUARTER_DAYS, discloseDue, periodOf } from "../../../src/runner/world/disclosure";
import { listCompanies } from "../../../src/runner/world/listing";
import { NOISE_ID, liquidityAgents, makerId, setUpParticipants } from "../../../src/runner/world/participants";
import { InMemoryEventStore } from "../../../src/store/memory-store";
import { FakeClock, jst } from "../../contracts/fakes";
import { FIXTURE_HOLIDAYS } from "../../fixtures/golden";
import { mulberry32 } from "../../fixtures/prng";
import { PRIOR_DAY, TRADING_DAYS, buildScenario } from "../../fixtures/scenario";

const SEED = 20261106;
const PRIOR = "2026-11-06";
/** 10取引日（架空の市場は 11/9 から毎日が取引日。土日の 11/14・11/15 を含む） */
const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18"];
const AIS = ["ai-ma5", "ai-reversal", "ai-hold"];
const p = (e: LogEvent) => e.payload as Record<string, unknown>;

/**
 * 前営業日の夜に6社を上場させ、上場の前の四半期を発表し、売買役と規則のAI 3体を登録してから、days を回す。
 * crashCommit：その AI のその日の注文票の確定で1回だけ落ち（agent.run は書いたあと）、その日を回し直す
 */
async function world(quarterDays = QUARTER_DAYS, opts: { days?: readonly string[]; crashCommit?: { id: string; date: string } } = {}) {
  const clock = new FakeClock(0);
  const holidayTables = new Map([[FIXTURE_HOLIDAYS.contentSha256, FIXTURE_HOLIDAYS]]);
  const rand = mulberry32(0x5a17);
  const values = new RunnerValues(() => Uint8Array.from({ length: 16 }, () => Math.floor(rand() * 256)));
  const inner = new InMemoryEventStore(values, holidayTables, clock);
  let crash = opts.crashCommit;
  const store = {
    read: (after?: number, limit?: number) => inner.read(after, limit),
    last: () => inner.last(),
    append: (d: Parameters<InMemoryEventStore["append"]>[0]) => inner.append(d),
    account: (id: string) => inner.account(id),
    commitSheet: (id: string, sheet: Parameters<InMemoryEventStore["commitSheet"]>[1]) => {
      if (crash && crash.id === id && crash.date === sheet.tradingDate) {
        crash = undefined;
        return Promise.reject(new Error("crashed"));
      }
      return inner.commitSheet(id, sheet);
    },
  };
  const waitUntil = async (at: number) => {
    if (at > clock.now()) clock.set(at);
  };
  const agents = [...(await ruleAgents()), ...(await liquidityAgents(SEED))];
  const deps: RunnerDeps = { store, market: new IngestedMarketData(clock), values, holidayTables, agents, clock, waitUntil, inputDays: 5 };
  await store.append({ type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 } });
  clock.set(jst(PRIOR, 18));
  await listCompanies(store, SEED);
  const disclosedAtListing = await discloseDue(store, SEED, clock, COMPANIES, quarterDays);
  await setUpParticipants(store, DAYS[0]!);
  for (const id of AIS) await store.append({ type: "agent.registered", actor: "operator:owner", refs: [], payload: { agentId: id, displayName: id, startDate: DAYS[0], initialCash: INITIAL_CASH } });
  const disclosed: string[][] = [];
  for (const d of opts.days ?? DAYS) {
    await runDay(d, deps).catch((e: unknown) => {
      if (!(e instanceof Error) || !e.message.includes("crashed")) throw e;
      return runDay(d, deps);
    });
    disclosed.push(await discloseDue(store, SEED, clock, COMPANIES, quarterDays));
  }
  const events = await store.read(0, 100_000);
  return { clock, values, store, deps, events, disclosedAtListing, disclosed };
}

const sheetOf = (events: readonly LogEvent[], agentId: string, date: string) => events.find((e) => e.type === "order_sheet.committed" && p(e).agentId === agentId && p(e).tradingDate === date);
const of = (events: readonly LogEvent[], type: LogEvent["type"]) => events.filter((e) => e.type === type);
const runOf = (events: readonly LogEvent[], sheet: LogEvent) => events[(p(sheet).runSeq as number) - 1]!;

describe("架空の市場を10取引日回す", async () => {
  const w = await world();
  const of = (type: LogEvent["type"]) => w.events.filter((e) => e.type === type);

  it("取引対象は6社だけで、外の始値・終値を取り込まない。上場の日に、上場の前の四半期を発表する", () => {
    expect(p(of("universe.set").at(-1)!).symbols).toEqual(COMPANIES.map((c) => c.symbol).sort());
    expect(of("prices.open").length + of("prices.close").length + of("source.captured").length).toBe(0);
    const listedAt = of("company.listed")[0]!.recordedAt;
    expect(w.disclosedAtListing).toEqual(COMPANIES.map((c) => `${c.symbol}:${periodOf(listedAt, 0)}`));
    expect(periodOf(listedAt, 0)).toBe("2026-Q3");
    for (const c of COMPANIES) {
      const { index: _, ...q0 } = quarters(SEED, c, 1)[0]!;
      expect(p(of("company.disclosed").find((e) => p(e).symbol === c.symbol)!)).toEqual({ symbol: c.symbol, period: "2026-Q3", ...q0 });
    }
    // 1四半期は板寄せの20日なので、10取引日では次の四半期をまだ発表しない
    expect(w.disclosed.flat()).toEqual([]);
  });

  it("毎日、参加者の全員が締めより前に注文票を確定し、拒否はない。6社の板寄せを毎日書く", () => {
    expect(of("order_sheet.rejected")).toEqual([]);
    const ids = [...AIS, ...COMPANIES.map((c) => makerId(c.symbol)), NOISE_ID];
    for (const d of DAYS) {
      for (const id of ids) expect(sheetOf(w.events, id, d)!.recordedAt).toBeLessThan(cutoffOf(d));
      const auctions = of("auction.cleared").filter((e) => p(e).date === d);
      expect(auctions.map((e) => p(e).symbol)).toEqual(COMPANIES.map((c) => c.symbol).sort());
    }
    // 価格がつくのは、ばらばらに売買する参加者や規則のAIの注文が、マーケットメイカーの指値に届いた日だけ
    // （#139 で売買役の数字と規則を変えたあとは、60回のうち60回。数字を変える前は22回、数字だけ変えたときは57回。
    // 日付を土日を含む10取引日にしたあと（#228）は、ばらばらの参加者の乱数の並びが変わり、60回のうち57回）
    const priced = of("auction.cleared").filter((e) => p(e).price !== null);
    expect(priced.length).toBe(57);
    expect(of("auction.cleared").filter((e) => p(e).date === DAYS[0]).every((e) => p(e).price !== null)).toBe(true);
  });

  it("マーケットメイカーは、上場の日から毎日、目安の価格（発表済みの決算から出した値）の上下に、値幅の内側で売りと買いを並べる", () => {
    for (const c of COMPANIES) {
      for (const d of DAYS) {
        const sheet = sheetOf(w.events, makerId(c.symbol), d)!;
        const orders = p(sheet).orders as Order[];
        expect(orders.some((o) => o.side === "buy")).toBe(true);
        expect(orders.some((o) => o.side === "sell")).toBe(true);
        const before = of("auction.cleared").filter((e) => p(e).symbol === c.symbol && (p(e).date as string) < d && p(e).price !== null);
        const band = priceBand((before.length > 0 ? p(before.at(-1)!).price : listingPrice(SEED, c)) as number);
        for (const o of orders) expect(o.limit! >= band.lower && o.limit! <= band.upper).toBe(true);
        // 上場の前の四半期を発表したので、目安の価格は上場の価格と同じ（最初の発表で跳ばない）
        const note = JSON.parse(w.values.body(p(runOf(w.events, sheet)).outputHash as string)!.value).note as string;
        expect(note).toMatch(new RegExp(`^fair ${listingPrice(SEED, c)} from 1 disclosed quarters`));
      }
    }
  });

  it("規則のAIは、板寄せの価格の並びを入力にして判断し、板寄せの価格で約定する", () => {
    const hold = sheetOf(w.events, "ai-hold", DAYS[0]!)!;
    expect((p(hold).orders as Order[]).map((o) => o.symbol)).toEqual(COMPANIES.map((c) => c.symbol).sort());
    const fills = of("fills.executed").find((e) => p(e).sheetSeq === hold.seq)!;
    const auctionSeqs = of("auction.cleared").filter((e) => p(e).date === DAYS[0]).map((e) => e.seq);
    expect(p(fills).auctionSeqs).toEqual(auctionSeqs);
    expect(p(fills).openSeq).toBeUndefined();
    // 6日目の 5日移動平均の入力には、前の5営業日の板寄せの結果が入る
    const ma5 = runOf(w.events, sheetOf(w.events, "ai-ma5", DAYS[5]!)!);
    const prev5 = of("auction.cleared").filter((e) => DAYS.slice(0, 5).includes(p(e).date as string)).map((e) => e.seq);
    expect(p(ma5).inputSeqs).toEqual(expect.arrayContaining(prev5));
  });

  it("評価は終値を使わず、その日の板寄せの価格で、毎日全員分を書く。ログはつながり、作り直した台帳が保管と一致する", async () => {
    for (const d of DAYS) {
      const vs = of("valuation.recorded").filter((e) => p(e).date === d);
      expect(vs.length).toBe(AIS.length + COMPANIES.length + 1);
      for (const v of vs) expect(p(v).closeSeq).toBeUndefined();
    }
    expect(await verifyChain(w.events)).toEqual([]);
    const ledger = await replay(w.events, w.values, { holidayTables: w.deps.holidayTables });
    for (const id of [...AIS, ...COMPANIES.map((c) => makerId(c.symbol)), NOISE_ID]) expect(ledger.account(id)).toEqual(w.store.account(id));
  });

  it("同じ日をもう一度回しても、決算の発表をもう一度呼んでも、何も書かない", async () => {
    const before = (await w.store.last())!.seq;
    await runDay(DAYS.at(-1)!, w.deps);
    expect(await discloseDue(w.store, SEED, w.clock)).toEqual([]);
    expect((await w.store.last())!.seq).toBe(before);
  });
});

describe("決算の発表の時期（1四半期を4日にした場合）", async () => {
  const w = await world(4);
  const disclosed = w.events.filter((e) => e.type === "company.disclosed");

  it("板寄せの日が4日たまるごとに、その日の15:30より後、次の日の締めより前に、次の四半期を発表する", () => {
    expect(w.disclosed.map((xs) => xs.length)).toEqual([0, 0, 0, 6, 0, 0, 0, 6, 0, 0]);
    for (const [k, day] of [[1, DAYS[3]!], [2, DAYS[7]!]] as const) {
      const period = periodOf(disclosed[0]!.recordedAt, k);
      const xs = disclosed.filter((e) => p(e).period === period);
      expect(xs.map((e) => p(e).symbol)).toEqual(COMPANIES.map((c) => c.symbol));
      for (const e of xs) {
        expect(e.recordedAt).toBeGreaterThanOrEqual(scheduleOf(day).closeAt);
        expect(e.recordedAt).toBeLessThan(cutoffOf(DAYS[DAYS.indexOf(day) + 1]!));
      }
    }
    expect(disclosed.map((e) => p(e).period)).toEqual([...Array(6).fill("2026-Q3"), ...Array(6).fill("2026-Q4"), ...Array(6).fill("2027-Q1")]);
  });

  it("次の日のマーケットメイカーの判断は、発表した決算を入力に入れる", () => {
    const c = COMPANIES[0]!;
    const q1 = disclosed.find((e) => p(e).symbol === c.symbol && p(e).period === "2026-Q4")!;
    const run = runOf(w.events, sheetOf(w.events, makerId(c.symbol), DAYS[4]!)!);
    expect(p(run).inputSeqs).toContain(q1.seq);
    expect(JSON.parse(w.values.body(p(run).outputHash as string)!.value).note).toMatch(/from 2 disclosed quarters/);
    const before = runOf(w.events, sheetOf(w.events, makerId(c.symbol), DAYS[3]!)!);
    expect(p(before).inputSeqs).not.toContain(q1.seq);
  });
});

describe("決算の発表の時期の境目と、途中で落ちたときの続き", async () => {
  const w = await world(4, { days: DAYS.slice(0, 3) });
  const day = DAYS[3]!;
  // 4日目の板寄せのあと、引けの前で止める
  const stop = { ...w.deps, waitUntil: async (at: number) => (at === scheduleOf(day).closeAt ? Promise.reject(new Error("stop")) : w.deps.waitUntil(at)) };
  await expect(runDay(day, stop)).rejects.toThrow("stop");

  it("板寄せが4日分そろっても、その日の15:30より前には書かない。15:30からは書く。途中で落ちても、残りだけを書く", async () => {
    expect(await discloseDue(w.store, SEED, w.clock, COMPANIES, 4)).toEqual([]);
    w.clock.set(cutoffOf(day) + 7 * 3_600_000 - 1);
    expect(await discloseDue(w.store, SEED, w.clock, COMPANIES, 4)).toEqual([]);
    w.clock.set(cutoffOf(day) + 7 * 3_600_000);
    expect(await discloseDue(w.store, SEED, w.clock, COMPANIES.slice(0, 3), 4)).toEqual(COMPANIES.slice(0, 3).map((c) => `${c.symbol}:2026-Q4`));
    expect(await discloseDue(w.store, SEED, w.clock, COMPANIES, 4)).toEqual(COMPANIES.slice(3).map((c) => `${c.symbol}:2026-Q4`));
    await runDay(day, w.deps);
    expect(of(await w.store.read(0, 100_000), "valuation.recorded").filter((e) => p(e).date === day).length).toBe(AIS.length + COMPANIES.length + 1);
  });
});

describe("上場した銘柄だけのとき、判断を記録したあと注文票の確定の前に落ちたら", async () => {
  const w = await world(QUARTER_DAYS, { days: DAYS.slice(0, 3), crashCommit: { id: "ai-hold", date: DAYS[1]! } });

  it("回し直しでは判断をやり直さず、記録した run から注文票だけを確定する", () => {
    const runs = w.events.filter((e) => e.type === "agent.run" && p(e).agentId === "ai-hold" && e.recordedAt >= cutoffOf(DAYS[0]!) && e.recordedAt < cutoffOf(DAYS[1]!));
    expect(runs.length).toBe(1);
    const sheet = sheetOf(w.events, "ai-hold", DAYS[1]!)!;
    expect(p(sheet).runSeq).toBe(runs[0]!.seq);
    expect(w.events.filter((e) => e.type === "order_sheet.committed" && p(e).agentId === "ai-hold").length).toBe(3);
  });
});

describe("外の銘柄の終値で動いていた世界を、上場した銘柄だけに切り替える", async () => {
  const scenario = buildScenario(7);
  const clock = new FakeClock(0);
  const holidayTables = new Map([[FIXTURE_HOLIDAYS.contentSha256, FIXTURE_HOLIDAYS]]);
  const values = new RunnerValues(() => new Uint8Array(16).fill(7));
  const store = new InMemoryEventStore(values, holidayTables, clock);
  const market = new IngestedMarketData(clock);
  const pending = [...scenario.observations].sort((a, b) => a.fetchedAt - b.fetchedAt);
  const waitUntil = async (at: number) => {
    while (pending.length > 0 && pending[0]!.fetchedAt <= at) {
      const { fetchedAt, ...o } = pending.shift()!;
      if (fetchedAt > clock.now()) clock.set(fetchedAt);
      market.capture([o]);
    }
    if (at > clock.now()) clock.set(at);
  };
  const deps: RunnerDeps = { store, market, values, holidayTables, agents: await ruleAgents(), clock, waitUntil };
  await store.append({ type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 } });
  await store.append({ type: "universe.set", actor: "operator:owner", refs: [], payload: { symbols: [...scenario.symbols] } });
  await runDay(PRIOR_DAY, deps);
  await listCompanies(store, SEED);
  for (const id of AIS) await store.append({ type: "agent.registered", actor: "operator:owner", refs: [], payload: { agentId: id, displayName: id, startDate: TRADING_DAYS[0], initialCash: INITIAL_CASH } });
  await runDay(TRADING_DAYS[0]!, deps);
  const events = await store.read(0, 100_000);

  it("切り替えの前の終値を判断に渡さないので、取引対象の外の銘柄を注文せず、注文票は拒否されない", () => {
    expect(of(events, "prices.close").length).toBe(1);
    expect(of(events, "order_sheet.rejected")).toEqual([]);
    const hold = sheetOf(events, "ai-hold", TRADING_DAYS[0]!)!;
    expect((p(hold).orders as Order[]).map((o) => o.symbol)).toEqual(COMPANIES.map((c) => c.symbol).sort());
    const closeSeq = of(events, "prices.close")[0]!.seq;
    expect(p(runOf(events, hold)).inputSeqs).not.toContain(closeSeq);
  });
});
