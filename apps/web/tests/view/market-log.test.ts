// 追記の検査と台帳の照合を通る、本物の記録の列から市場の表示を作る。値つかずの日に添える価格が、台帳の評価（priceSeq）と同じになること
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { Ledger } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/index";
import { cutoffOf } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Order } from "../../src/ledger/types";
import { buildView } from "../../src/view/build";
import { NO_PRICE_TEXT } from "../../src/view/market";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const H = "a".repeat(64);
const table: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set() };
const NO_VALUES = { get: () => undefined };
const D1 = "2026-11-10";
const D2 = "2026-11-11";
const op = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt, actor: "operator:owner", refs: [], payload });
const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });

async function build() {
  const ledger = new Ledger(NO_VALUES);
  const log = new EventLog({ holidayTables: new Map([[H, table]]), accountOf: (id) => ledger.account(id) });
  const add = async (d: Draft) => {
    const why = await ledger.check({ type: d.type, payload: d.payload });
    if (why) throw new Error(why);
    const r = await log.append(d);
    if (!r.ok) throw new Error(r.reason);
    await ledger.apply(r.event);
    return r.event.seq;
  };
  const commit = async (agentId: string, date: string, orders: Order[], at: number) => {
    const run = await add(sys("agent.run", at, { agentId, purpose: "order", inputSeqs: [], ok: true }));
    const r = await log.commitSheet(at, agentId, { tradingDate: date, orders, runSeq: run, inputSeqs: [] });
    if (!r.ok || r.rejected) throw new Error(r.ok ? r.rejected : r.reason);
    await ledger.apply(r.event);
    return r.event.seq;
  };
  /** 注文票の約定と、その日の板寄せ（sheets は [AIのID, 注文票の seq]） */
  const auction = async (date: string, listed: number, sheets: [string, number, boolean][]) => {
    const seqs = sheets.map(([, s]) => s);
    const { payload } = ledger.computeAuction("NEO1", date, seqs);
    const cleared = await add(sys("auction.cleared", cutoffOf(date) + 60_000, { symbol: "NEO1", date, sheetSeqs: seqs, ...payload }, [listed, ...seqs]));
    for (const [id, sheetSeq, traded] of sheets) {
      const auctions = traded ? [cleared] : []; // 注文のない注文票は、板寄せを指さない（auctionSeqs を書かない）
      const f = await ledger.computeFills(id, sheetSeq, undefined, auctions);
      await add(sys("fills.executed", cutoffOf(date) + 120_000, { agentId: id, tradingDate: date, sheetSeq, ...(traded ? { auctionSeqs: auctions } : {}), ...f.payload }, [sheetSeq, ...auctions]));
    }
    return cleared;
  };

  await add(op("holidays.adopted", 0, { holidaysSha256: H }));
  const listed = await add(sys("company.listed", jst("2026-11-09", 18), { symbol: "NEO1", name: "ネオ電機", sector: "電機", sharesOutstanding: 500_000, price: 10_000 }));
  await add(op("agent.registered", jst("2026-11-09", 19), { agentId: "mm", startDate: D1, kind: "market_maker", initialCash: 50_000_000 * 10 }));
  await add(op("agent.registered", jst("2026-11-09", 19), { agentId: "alpha", startDate: D1, kind: "investor", initialCash: INITIAL_CASH }));
  await add(op("universe.set", jst("2026-11-09", 19, 30), { symbols: ["NEO1"] }));
  await add(sys("shares.allotted", jst("2026-11-09", 19, 40), { agentId: "mm", symbol: "NEO1", qty: 5_000 }));

  // 1日目：価格がつく（1,010円、200株）
  const mm1 = await commit("mm", D1, [{ symbol: "NEO1", side: "sell", qty: 300, limit: 10_100 }], jst("2026-11-09", 21));
  const a1 = await commit("alpha", D1, [{ symbol: "NEO1", side: "buy", qty: 200, limit: 10_200 }], jst("2026-11-09", 22));
  const cleared1 = await auction(D1, listed, [["mm", mm1, true], ["alpha", a1, true]]);
  for (const id of ["alpha", "mm"]) await add(sys("valuation.recorded", jst(D1, 15, 40), { agentId: id, date: D1, ...ledger.computeValuation(id, D1) }));
  await add(sys("company.disclosed", jst(D1, 15, 45), { symbol: "NEO1", period: "2026-Q3", revenue: 2_000_000_000, netIncome: -50_000_000, eps: -1_005, dividendPerShare: 0 }));
  for (const id of ["alpha", "mm"]) await add(sys("corporate_actions.applied", jst(D1, 16), { agentId: id, asOf: D1, exDate: D2, announcedSeqs: [], ...(await ledger.computeCorporate(id, D1, D2, [])).payload }));

  // 2日目：どちらも注文しない → 価格がつかない。評価は前の日の価格（cleared1）
  const mm2 = await commit("mm", D2, [], jst(D1, 21));
  const a2 = await commit("alpha", D2, [], jst(D1, 22));
  const cleared2 = await auction(D2, cleared1, [["mm", mm2, false], ["alpha", a2, false]]);
  for (const id of ["alpha", "mm"]) await add(sys("valuation.recorded", jst(D2, 15, 40), { agentId: id, date: D2, ...ledger.computeValuation(id, D2) }));
  return { events: log.events as readonly LogEvent[], listed, cleared1, cleared2 };
}

describe("本物の記録の列から作る市場の表示", async () => {
  const { events, listed, cleared1, cleared2 } = await build();
  const view = buildView(events, () => undefined);
  const neo = view.market.companies[0]!;

  it("板寄せの日は記録の seq・価格・出来高と同じ。値つかずの日に添える価格は、台帳の評価が使った記録（priceSeq）の価格と同じ", () => {
    expect(neo.listing).toMatchObject({ symbol: "NEO1", listedPrice: 10_000 });
    const payloads = events.filter((e) => e.type === "auction.cleared").map((e) => e.payload as { price: number | null; volume: number });
    expect(neo.days.map((d) => [d.seq, d.price, d.volume])).toEqual([[cleared1, payloads[0]!.price, payloads[0]!.volume], [cleared2, null, 0]]);
    expect(neo.days.map((d) => [d.priceText, d.volumeText])).toEqual([["¥1,010", "200株"], [NO_PRICE_TEXT, "0株"]]);
    const v2 = events.find((e) => e.type === "valuation.recorded" && (e.payload as { date: string; agentId: string }).date === D2 && (e.payload as { agentId: string }).agentId === "alpha")!.payload as { positions: { priceSeq: number; price: number }[] };
    expect(v2.positions[0]!.priceSeq).toBe(cleared1);
    expect(neo.days[1]).toMatchObject({ carriedSeq: v2.positions[0]!.priceSeq, carriedText: "¥1,010" });
    expect(neo.days[1]!.carriedSeq).not.toBe(listed);
  });

  it("評価の保有は板寄せの価格の記録を指す。値つかずの日の評価は『直近の価格で評価』の印がつく", () => {
    const vals = view.timeline.filter((t) => t.kind === "valuation" && t.agentId === "alpha");
    expect(vals.map((t) => t.kind === "valuation" && t.positions.map((p) => [p.closeSeq, p.stale]))).toEqual([[[cleared1, false]], [[cleared1, true]]]);
  });

  it("決算の発表が記録のとおり出る（1株利益は0.1円の端数まで）", () => {
    expect(neo.disclosures[0]).toMatchObject({ periodText: "2026年 第3四半期", revenueText: "¥2,000,000,000", netIncomeText: "-¥50,000,000", epsText: "-¥100.5", dividendText: "¥0" });
  });
});
