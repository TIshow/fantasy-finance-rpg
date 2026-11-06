// 人工市場の1日を通す（#110 PR-2c）：最初の配分（shares.allotted）と参加者ごとの最初の現金、板寄せでの売買、
// 板寄せの価格での評価、決算の発表（company.disclosed）。保存済みのログを確かめ直しても同じ
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { Ledger, replay } from "../../src/events/replay";
import type { HolidayTable } from "../../src/holidays/index";
import { cutoffOf } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Order } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const H = "a".repeat(64);
const table: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set() };
const CTX = { holidayTables: new Map([[H, table]]) };
const NO_VALUES = { get: () => undefined };
const T = "2026-11-10";
const MM_CASH = 50_000_000 * 10;
const op = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt, actor: "operator:owner", refs: [], payload });
const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });

class World {
  readonly ledger = new Ledger(NO_VALUES);
  readonly log = new EventLog({ ...CTX, accountOf: (id) => this.ledger.account(id) });
  async add(d: Draft): Promise<number> {
    const why = await this.ledger.check({ type: d.type, payload: d.payload });
    if (why) throw new Error(why);
    const r = await this.log.append(d);
    if (!r.ok) throw new Error(r.reason);
    await this.ledger.apply(r.event);
    return r.event.seq;
  }
  /** 追記の処理だけの理由 */
  async rule(d: Draft): Promise<string> {
    const r = await this.log.append(d);
    if (r.ok) throw new Error("appended");
    return r.reason;
  }
  async commit(agentId: string, orders: Order[], at: number, inputSeqs: number[] = []): Promise<number> {
    const run = await this.add(sys("agent.run", at, { agentId, purpose: "order", inputSeqs, ok: true }, inputSeqs));
    const r = await this.log.commitSheet(at, agentId, { tradingDate: T, orders, runSeq: run, inputSeqs });
    if (!r.ok || r.rejected) throw new Error(r.ok ? r.rejected : r.reason);
    await this.ledger.apply(r.event);
    return r.event.seq;
  }
}

/** NEO1（上場の価格1000円）を上場し、マーケットメイカー mm に5,000株と現金5,000万円、AI alpha に現金1,000万円 */
async function setup() {
  const w = new World();
  await w.add(op("holidays.adopted", 0, { holidaysSha256: H }));
  const listed = await w.add(sys("company.listed", jst("2026-11-09", 18), { symbol: "NEO1", name: "ネオ電機", sector: "電機", sharesOutstanding: 500_000, price: 10_000 }));
  await w.add(op("agent.registered", jst("2026-11-09", 19), { agentId: "mm", startDate: T, initialCash: MM_CASH }));
  await w.add(op("agent.registered", jst("2026-11-09", 19), { agentId: "alpha", startDate: T, initialCash: INITIAL_CASH }));
  await w.add(op("universe.set", jst("2026-11-09", 19, 30), { symbols: ["NEO1"] }));
  await w.add(sys("shares.allotted", jst("2026-11-09", 19, 40), { agentId: "mm", symbol: "NEO1", qty: 5_000 }));
  return { w, listed };
}

describe("最初の配分と最初の現金（#110 PR-2c）", () => {
  it("参加者ごとに最初の現金を決められ、配った株は上場の価格を取得原価にする（現金は動かさない）", async () => {
    const { w } = await setup();
    expect(w.ledger.account("mm")).toEqual({ cash: MM_CASH, holdings: { NEO1: { qty: 5_000, cost: 10_000 * 5_000 } } });
    expect(w.ledger.account("alpha")).toEqual({ cash: INITIAL_CASH, holdings: {} });
    expect(await w.rule(op("agent.registered", jst("2026-11-09", 20), { agentId: "big", startDate: T, initialCash: 10_000_000_000 * 10 + 1 }))).toBe("initialCash must be a positive amount up to MAX_INITIAL_CASH");
    expect(await w.rule(op("agent.registered", jst("2026-11-09", 20), { agentId: "zero", startDate: T, initialCash: 0 }))).toBe("initialCash must be a positive amount up to MAX_INITIAL_CASH");
  });

  it("配分は、システムだけが、参加者ごと・銘柄ごとに1回、発行済株式数の内で、最初の板寄せより前に書ける", async () => {
    const { w, listed } = await setup();
    const at = jst("2026-11-09", 20);
    expect(await w.rule({ ...sys("shares.allotted", at, { agentId: "alpha", symbol: "NEO1", qty: 100 }), actor: "operator:owner" })).toBe("shares.allotted must be written by system");
    expect(await w.rule(sys("shares.allotted", at, { agentId: "mm", symbol: "NEO1", qty: 100 }))).toContain("allot:mm:NEO1");
    expect(await w.rule(sys("shares.allotted", at, { agentId: "alpha", symbol: "OLD1", qty: 100 }))).toBe("symbol is not listed");
    expect(await w.rule(sys("shares.allotted", at, { agentId: "alpha", symbol: "NEO1", qty: 495_001 }))).toBe("allotments exceed sharesOutstanding");
    expect(await w.rule(sys("shares.allotted", at, { agentId: "alpha", symbol: "NEO1", qty: 0 }))).toBe("qty must be a positive integer");
    expect(await w.rule(sys("shares.allotted", at, { agentId: "alpha", symbol: "NEO1", qty: 100, memo: "x" }))).toBe("unknown field in an allotment");
    // 取引対象にない銘柄や、最初の評価の日（11/10）の締めより後に上場した銘柄は、その日に板寄せができないので配らない
    await w.add(sys("company.listed", at, { symbol: "NEO2", name: "ネオ銀行", sector: "銀行", sharesOutstanding: 500_000, price: 5_000 }));
    expect(await w.rule(sys("shares.allotted", at, { agentId: "alpha", symbol: "NEO2", qty: 100 }))).toBe("symbol is not in the universe");
    // 注文票を確定したあとの参加者には配らない。板寄せのあとの銘柄も
    await w.commit("alpha", [], jst("2026-11-09", 21));
    expect(await w.rule(sys("shares.allotted", jst("2026-11-09", 22), { agentId: "alpha", symbol: "NEO1", qty: 100 }))).toBe("the agent already started trading");
    await w.add(op("agent.registered", jst("2026-11-09", 22), { agentId: "late", startDate: T, initialCash: INITIAL_CASH }));
    await w.add(sys("auction.cleared", cutoffOf(T) + 60_000, { symbol: "NEO1", date: T, refSeq: listed, sheetSeqs: [w.log.events.find((e) => e.type === "order_sheet.committed")!.seq], price: null, volume: 0 }, [listed, w.log.events.find((e) => e.type === "order_sheet.committed")!.seq]));
    expect(await w.rule(sys("shares.allotted", cutoffOf(T) + 120_000, { agentId: "late", symbol: "NEO1", qty: 100 }))).toBe("the symbol is already auctioned");
    const after = cutoffOf(T) + 180_000;
    await w.add(sys("company.listed", after, { symbol: "NEO3", name: "ネオ商事", sector: "商社", sharesOutstanding: 500_000, price: 5_000 }));
    await w.add(op("universe.set", after, { symbols: ["NEO1", "NEO3"] }));
    expect(await w.rule(sys("shares.allotted", after, { agentId: "late", symbol: "NEO3", qty: 100 }))).toBe("the symbol cannot be auctioned on the first valuation date");
  });
});

describe("板寄せでの売買と、板寄せの価格での評価（#110 PR-2c）", () => {
  it("マーケットメイカーの売りと AI の買いで価格がつき、評価はその価格で、終値なしで書ける", async () => {
    const { w, listed } = await setup();
    const mmSheet = await w.commit("mm", [{ symbol: "NEO1", side: "sell", qty: 300, limit: 10_100 }], jst("2026-11-09", 21));
    const aSheet = await w.commit("alpha", [{ symbol: "NEO1", side: "buy", qty: 200, limit: 10_200 }], jst("2026-11-09", 22));
    // 1010〜1020円で約定量200、前日（上場の価格1000円）に近い1010円
    const { payload } = w.ledger.computeAuction("NEO1", T, [mmSheet, aSheet]);
    expect(payload).toEqual({ refSeq: listed, price: 10_100, volume: 200 });
    const cleared = await w.add(sys("auction.cleared", cutoffOf(T) + 60_000, { symbol: "NEO1", date: T, sheetSeqs: [mmSheet, aSheet], ...payload }, [listed, mmSheet, aSheet]));
    for (const [id, sheetSeq] of [["mm", mmSheet], ["alpha", aSheet]] as const) {
      const f = await w.ledger.computeFills(id, sheetSeq, undefined, [cleared]);
      await w.add(sys("fills.executed", cutoffOf(T) + 120_000, { agentId: id, tradingDate: T, sheetSeq, auctionSeqs: [cleared], ...f.payload }, [sheetSeq, cleared]));
    }
    expect(w.ledger.account("alpha")).toEqual({ cash: INITIAL_CASH - 10_100 * 200, holdings: { NEO1: { qty: 200, cost: 10_100 * 200 } } });
    expect(w.ledger.account("mm").holdings.NEO1!.qty).toBe(4_800);

    // 評価：終値（prices.close）はない。板寄せの価格で評価し、その記録の seq を残す
    const v = w.ledger.computeValuation("alpha", T);
    expect(v).toEqual({ cash: INITIAL_CASH - 10_100 * 200, positions: [{ symbol: "NEO1", qty: 200, price: 10_100, priceSeq: cleared }], total: INITIAL_CASH });
    await w.add(sys("valuation.recorded", jst(T, 15, 40), { agentId: "alpha", date: T, ...v }));
    await w.add(sys("valuation.recorded", jst(T, 15, 40), { agentId: "mm", date: T, ...w.ledger.computeValuation("mm", T) }));

    // 決算の発表は、締めより前に記録したものを、翌日の判断の入力に使える
    const disclosed = await w.add(sys("company.disclosed", jst(T, 15, 45), { symbol: "NEO1", period: "2026-Q3", revenue: 2_000_000_000, netIncome: -50_000_000, eps: -1_000, dividendPerShare: 0 }));
    await w.add(sys("corporate_actions.applied", jst(T, 16), { agentId: "alpha", asOf: T, exDate: "2026-11-11", announcedSeqs: [], ...(await w.ledger.computeCorporate("alpha", T, "2026-11-11", [])).payload }));
    const run = await w.add(sys("agent.run", jst(T, 20), { agentId: "alpha", purpose: "order", inputSeqs: [disclosed, cleared], ok: true }, [disclosed, cleared]));
    const next = await w.log.commitSheet(jst(T, 21), "alpha", { tradingDate: "2026-11-11", orders: [{ symbol: "NEO1", side: "sell", qty: 200, limit: 10_000 }], runSeq: run, inputSeqs: [disclosed, cleared] });
    expect(next.ok && next.event.type).toBe("order_sheet.committed");
    if (next.ok) await w.ledger.apply(next.event);

    const again = await replay(w.log.events, NO_VALUES, CTX);
    for (const id of ["mm", "alpha"]) expect(again.account(id)).toEqual(w.ledger.account(id));
  });

  it("持っている上場した銘柄の、その日の板寄せが済むまで評価は書けない", async () => {
    const { w } = await setup();
    const mmSheet = await w.commit("mm", [], jst("2026-11-09", 21));
    await w.add(sys("fills.executed", cutoffOf(T) + 60_000, { agentId: "mm", tradingDate: T, sheetSeq: mmSheet, ...(await w.ledger.computeFills("mm", mmSheet, undefined, [])).payload }, [mmSheet]));
    expect(await w.rule(sys("valuation.recorded", jst(T, 15, 40), { agentId: "mm", date: T, ...w.ledger.computeValuation("mm", T) }))).toBe("auction the held listed symbols of the date first");
  });
});

describe("決算の発表（company.disclosed）", () => {
  it("システムだけが、上場した銘柄の四半期ごとに1回書ける。形の崩れたものは断る", async () => {
    const { w } = await setup();
    const at = jst("2026-11-09", 20);
    const base = { symbol: "NEO1", period: "2026-Q3", revenue: 1, netIncome: -1, eps: -1, dividendPerShare: 0 };
    await w.add(sys("company.disclosed", at, base));
    expect(await w.rule(sys("company.disclosed", at, base))).toContain("disclosed:NEO1:2026-Q3");
    expect(await w.rule({ ...sys("company.disclosed", at, { ...base, period: "2026-Q4" }), actor: "operator:owner" })).toBe("company.disclosed must be written by system");
    const bad: [Record<string, unknown>, string][] = [
      [{ symbol: "OLD1" }, "symbol is not listed"],
      [{ period: "2026Q4" }, "invalid period"],
      [{ period: "2026-Q5" }, "invalid period"],
      [{ revenue: -1 }, "invalid figures"],
      [{ eps: 1.5 }, "invalid figures"],
      [{ dividendPerShare: -1 }, "invalid figures"],
      [{ note: "x" }, "unknown field in a disclosure"],
    ];
    for (const [patch, why] of bad) expect(await w.rule(sys("company.disclosed", at, { ...base, period: "2026-Q4", ...patch })), JSON.stringify(patch)).toBe(why);
  });
});
