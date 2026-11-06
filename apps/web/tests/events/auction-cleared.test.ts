// 板寄せの結果の記録（auction.cleared）と、それから作る約定（fills.executed の auctionSeqs）。MARKET_DESIGN §3、#110 PR-2b
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
const op = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt, actor: "operator:owner", refs: [], payload });
const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });

/** 追記と台帳を一緒に進める（保管と同じく、台帳が断るものは書かない） */
class World {
  readonly ledger = new Ledger(NO_VALUES);
  readonly log = new EventLog({ ...CTX, accountOf: (id) => this.ledger.account(id) });
  async add(d: Draft): Promise<number> {
    const why = await this.try(d);
    if (why !== "ok") throw new Error(why);
    return this.log.events.length;
  }
  async try(d: Draft): Promise<string> {
    const why = await this.ledger.check({ type: d.type, payload: d.payload });
    if (why) return why;
    const r = await this.log.append(d);
    if (!r.ok) return r.reason;
    await this.ledger.apply(r.event);
    return "ok";
  }
  /** 追記の処理だけの理由（台帳より先に断るもの） */
  async rule(d: Draft): Promise<string> {
    const r = await this.log.append(d);
    if (r.ok) throw new Error("appended");
    return r.reason;
  }
  async commit(agentId: string, orders: Order[], at: number): Promise<number> {
    const run = await this.add(sys("agent.run", at, { agentId, purpose: "order", inputSeqs: [], ok: true }));
    const r = await this.log.commitSheet(at, agentId, { tradingDate: T, orders, runSeq: run, inputSeqs: [] });
    if (!r.ok || r.rejected) throw new Error(r.ok ? r.rejected : r.reason);
    await this.ledger.apply(r.event);
    return r.event.seq;
  }
}

/** NEO1（上場の価格1000円）を上場し、2体のAIが T の注文票を確定したところ */
async function setup() {
  const w = new World();
  await w.add(op("holidays.adopted", 0, { holidaysSha256: H }));
  const listed = await w.add(sys("company.listed", 1, { symbol: "NEO1", name: "ネオ電機", sector: "電機", sharesOutstanding: 500_000, price: 10_000 }));
  await w.add(op("universe.set", 2, { symbols: ["NEO1"] }));
  for (const id of ["alpha", "beta"]) await w.add(op("agent.registered", jst("2026-11-09", 20), { agentId: id, startDate: T, initialCash: INITIAL_CASH }));
  const a = await w.commit(
    "alpha",
    [
      { symbol: "NEO1", side: "buy", qty: 300, limit: 10_100 },
      // 残りの現金を値幅の上限（1200円）で確かめ、8,000株まで減る
      { symbol: "NEO1", side: "buy", qty: 100_000 },
      // もう現金が残らないので0株
      { symbol: "NEO1", side: "buy", qty: 100 },
    ],
    jst("2026-11-09", 21),
  );
  const b = await w.commit("beta", [{ symbol: "NEO1", side: "buy", qty: 100 }], jst("2026-11-09", 22));
  return { w, listed, sheets: [a, b] };
}

const auction = (listed: number, sheets: number[], extra: Record<string, unknown> = {}, at = cutoffOf(T) + 60_000) =>
  sys("auction.cleared", at, { symbol: "NEO1", date: T, refSeq: listed, sheetSeqs: sheets, price: null, volume: 0, ...extra }, [listed, ...sheets]);

describe("auction.cleared（#110 PR-2b）", () => {
  it("締めのあとに、その日の全員の注文票と、直近の価格を指して書く", async () => {
    const { w, listed, sheets } = await setup();
    expect(await w.rule(auction(listed, sheets, {}, cutoffOf(T) - 1))).toBe("auction recorded before the cutoff");
    expect(await w.rule(auction(listed, [sheets[0]!]))).toBe("sheetSeqs must be every committed sheet for the date");
    expect(await w.rule(auction(sheets[0]!, sheets, {}, cutoffOf(T) + 60_000))).toBe("refSeq must be the latest price before the date");
    expect(await w.rule({ ...auction(listed, sheets), payload: { symbol: "OLD1", date: T, refSeq: listed, sheetSeqs: sheets, price: null, volume: 0 } })).toBe("symbol is not listed");
    expect(await w.rule(auction(listed, sheets, { price: null, volume: 100 }))).toBe("invalid price or volume");
  });

  it("板寄せの日付は、銘柄を問わず戻らない。上場より前の日の板寄せは書けない", async () => {
    const { w, listed, sheets } = await setup();
    const neo2 = await w.add(sys("company.listed", jst("2026-11-09", 23), { symbol: "NEO2", name: "ネオ銀行", sector: "銀行", sharesOutstanding: 500_000, price: 5_000 }));
    await w.add(op("universe.set", jst("2026-11-09", 23), { symbols: ["NEO1", "NEO2"] }));
    // NEO2 の上場は 11/9 の締めのあとなので、11/9 の板寄せはない
    expect(await w.rule(sys("auction.cleared", cutoffOf(T) + 60_000, { symbol: "NEO2", date: "2026-11-09", refSeq: neo2, sheetSeqs: [], price: null, volume: 0 }, [neo2]))).toBe("auction before the listing");
    await w.add(auction(listed, sheets));
    // NEO1 の T のあとに、NEO2 の前の日を書くことはできない（どちらの順で書いても結果が同じになるように）
    const at = cutoffOf("2026-11-11") + 60_000;
    expect(await w.rule(sys("auction.cleared", at, { symbol: "NEO2", date: "2026-11-09", refSeq: neo2, sheetSeqs: [], price: null, volume: 0 }, [neo2]))).toBe("a later auction is already recorded");
    // 同じ日の別の銘柄は書ける。価格がつかなかったので、次の日の基準は上場の価格のまま
    await w.add(sys("auction.cleared", cutoffOf(T) + 90_000, { symbol: "NEO2", date: T, refSeq: neo2, sheetSeqs: sheets, price: null, volume: 0 }, [neo2, ...sheets]));
    expect(await w.rule(sys("auction.cleared", at, { symbol: "NEO1", date: "2026-11-11", refSeq: sheets[0], sheetSeqs: [], price: null, volume: 0 }, [sheets[0]!]))).toBe("refSeq must be the latest price before the date");
  });

  it("臨時休場の日は板寄せを書けず、約定は板寄せを指さずに全件失効", async () => {
    const { w, listed, sheets } = await setup();
    await w.add(op("market.closed", jst(T, 8, 40), { date: T, reason: "x" }));
    expect(await w.rule(auction(listed, sheets))).toBe("market was closed");
    const r = await w.ledger.computeFills("beta", sheets[1]!, undefined, []);
    expect(r.payload.fills.map((f) => f.reason)).toEqual(["market_closed"]);
    expect(await w.rule(sys("fills.executed", jst(T, 9), { agentId: "beta", tradingDate: T, sheetSeq: sheets[1], auctionSeqs: [listed], ...r.payload }, [sheets[1]!, listed]))).toBe("market was closed");
    await w.add(sys("fills.executed", jst(T, 9), { agentId: "beta", tradingDate: T, sheetSeq: sheets[1], ...r.payload }, [sheets[1]!]));
  });

  it("価格と約定量は、台帳が注文票から作り直して確かめる（買いしかない日は価格がつかない）", async () => {
    const { w, listed, sheets } = await setup();
    expect(await w.try(auction(listed, sheets, { price: 10_000, volume: 100 }))).toContain("recomputed");
    expect(await w.try(auction(listed, sheets))).toBe("ok");
    // 同じ銘柄の、前の日の板寄せはもう書けない（上場より前の日も）。板寄せのあとの日は臨時休場にできない
    expect(await w.try(sys("auction.cleared", cutoffOf(T) + 120_000, { symbol: "NEO1", date: "2026-11-09", refSeq: listed, sheetSeqs: [], price: null, volume: 0 }, [listed]))).toBe("a later auction of the symbol is already recorded");
    expect(await w.try(op("market.closed", cutoffOf(T) + 120_000, { date: T, reason: "x" }))).toBe("auction already recorded");
  });

  it("約定は板寄せの結果から作る。現金で減った注文は insufficient_cash、価格がつかなければ no_price。保存済みのログを確かめ直しても同じ", async () => {
    const { w, listed, sheets } = await setup();
    const fill = (sheetSeq: number, agentId: string, extra: Record<string, unknown>, refs: number[]) => sys("fills.executed", cutoffOf(T) + 180_000, { agentId, tradingDate: T, sheetSeq, ...extra }, [sheetSeq, ...refs]);
    // 板寄せの前には約定を書けない
    expect(await w.rule(fill(sheets[0]!, "alpha", { fills: [], accountHash: "0".repeat(64) }, []))).toBe("the listed symbols of the sheet are not auctioned yet");
    const cleared = await w.add(auction(listed, sheets));
    const r = await w.ledger.computeFills("alpha", sheets[0]!, undefined, [cleared]);
    expect(r.payload.fills.map((f) => [f.requestedQty, f.qty, f.status, f.reason])).toEqual([
      [300, 0, "expired", "no_price"],
      [100_000, 0, "expired", "no_price"],
      [100, 0, "expired", "insufficient_cash"],
    ]);
    expect(await w.rule(fill(sheets[0]!, "alpha", r.payload, []))).toBe("auctionSeqs must be the auctions of the listed symbols in the sheet");
    await w.add(fill(sheets[0]!, "alpha", { auctionSeqs: [cleared], ...r.payload }, [cleared]));
    const rb = await w.ledger.computeFills("beta", sheets[1]!, undefined, [cleared]);
    await w.add(fill(sheets[1]!, "beta", { auctionSeqs: [cleared], ...rb.payload }, [cleared]));
    const again = await replay(w.log.events, NO_VALUES, CTX);
    expect(again.account("alpha")).toEqual(w.ledger.account("alpha"));
    expect(w.ledger.account("alpha").cash).toBe(INITIAL_CASH);
  });
});
