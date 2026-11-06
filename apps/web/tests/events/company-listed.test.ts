// 架空の企業の上場の記録（company.listed）と、それを使う指値の注文票（#110 PR-2a）。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { replay } from "../../src/events/replay";
import type { HolidayTable } from "../../src/holidays/index";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Order } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const H = "a".repeat(64);
const table: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set() };
const CTX = { holidayTables: new Map([[H, table]]) };
const op = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt, actor: "operator:owner", refs: [], payload });
const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });
const listing = { symbol: "NEO1", name: "ネオ電機", sector: "電機", sharesOutstanding: 500_000, price: 10_000 };

async function ok(log: EventLog, d: Draft) {
  const r = await log.append(d);
  if (!r.ok) throw new Error(r.reason);
  return r.event.seq;
}
const reason = async (log: EventLog, d: Draft) => {
  const r = await log.append(d);
  return r.ok ? "ok" : r.reason;
};

async function setup() {
  const log = new EventLog({ ...CTX, accountOf: () => newAccount() });
  await ok(log, op("holidays.adopted", 0, { holidaysSha256: H }));
  await ok(log, sys("company.listed", 1, listing));
  await ok(log, op("universe.set", 2, { symbols: ["NEO1"] }));
  await ok(log, op("agent.registered", jst("2026-11-09", 20), { agentId: "alpha", startDate: "2026-11-10", initialCash: INITIAL_CASH }));
  const src = await ok(log, sys("source.captured", jst("2026-11-09", 21), { publishedAt: jst("2026-11-09", 19), fetchedAt: jst("2026-11-09", 21) }));
  const run = await ok(log, sys("agent.run", jst("2026-11-09", 22), { agentId: "alpha", purpose: "order", inputSeqs: [src], ok: true }, [src]));
  return { log, src, run };
}

describe("company.listed（#110 PR-2a）", () => {
  it("上場した銘柄の分割の公表は、まだ受け付けない。配当は受け付ける", async () => {
    const { log } = await setup();
    const at = jst("2026-11-09", 23);
    expect(await reason(log, sys("corporate_action.announced", at, { symbol: "NEO1", kind: "split", exDate: "2026-11-16", valuesHash: "c".repeat(64) }))).toBe("splits of listed companies are not supported yet");
    expect(await reason(log, sys("corporate_action.announced", at, { symbol: "NEO1", kind: "dividend", exDate: "2026-11-16", valuesHash: "c".repeat(64) }))).toBe("ok");
  });

  it("正規化できない指値（小数）は、理由 invalid_price の読めない拒否として残り、照合でも認められる", async () => {
    const { log, src, run } = await setup();
    const r = await log.commitSheet(jst("2026-11-10", 7), "alpha", { tradingDate: "2026-11-10", orders: [{ symbol: "NEO1", side: "buy", qty: 100, limit: 10_000.5 }], runSeq: run, inputSeqs: [src] });
    expect(r.ok && [r.rejected, (r.event.payload as Record<string, unknown>).ordersUnreadable]).toEqual(["invalid_price", true]);
    await expect(replay(log.events, { get: () => undefined }, CTX)).resolves.toBeDefined();
  });

  it("システムだけが書け、同じ銘柄の上場は1回だけ", async () => {
    const { log } = await setup();
    expect(await reason(log, { ...sys("company.listed", 3, { ...listing, symbol: "NEO2" }), actor: "operator:owner" })).toBe("company.listed must be written by system");
    await ok(log, sys("company.listed", jst("2026-11-09", 23), { ...listing, symbol: "NEO2" }));
    expect(await reason(log, sys("company.listed", jst("2026-11-09", 23), { ...listing, symbol: "NEO2" }))).toContain("listed:NEO2");
    // 取引対象に入れたあとの銘柄は上場させない（上場は、取引対象に入れる前）
    await ok(log, op("universe.set", jst("2026-11-09", 23), { symbols: ["NEO1", "OLD1"] }));
    expect(await reason(log, sys("company.listed", jst("2026-11-09", 23), { ...listing, symbol: "OLD1" }))).toBe("list the company before adding it to the universe");
  });

  it("形の崩れた上場の記録は理由を返して断る", async () => {
    const { log } = await setup();
    const at = jst("2026-11-09", 23);
    const bad: [Record<string, unknown>, string][] = [
      [{ symbol: "neo2" }, "invalid symbol"],
      [{ symbol: "TSTX" }, "symbols starting with TST are for tests"],
      [{ name: "" }, "name and sector are required (up to 100 characters)"],
      [{ name: "あ".repeat(101) }, "name and sector are required (up to 100 characters)"],
      [{ sector: 1 }, "name and sector are required (up to 100 characters)"],
      [{ sharesOutstanding: 0 }, "sharesOutstanding must be a positive integer up to 10000000000"],
      [{ sharesOutstanding: 1.5 }, "sharesOutstanding must be a positive integer up to 10000000000"],
      [{ sharesOutstanding: 10_000_000_001 }, "sharesOutstanding must be a positive integer up to 10000000000"],
      [{ ceo: "x" }, "unknown field in a listing"],
      [{ price: 10_005 }, "price must be a positive multiple of the tick"],
      [{ price: 0 }, "price must be a positive multiple of the tick"],
    ];
    for (const [patch, why] of bad) expect(await reason(log, sys("company.listed", at, { ...listing, symbol: "NEO2", ...patch })), JSON.stringify(patch)).toBe(why);
  });

  it("注文票の指値は、上場の価格（1000円）から決まる値幅で確かめ、株数は発行済株式数まで。照合でも同じ", async () => {
    const { log, src, run } = await setup();
    const commit = (orders: Order[], mm: number) => log.commitSheet(jst("2026-11-10", 7, mm), "alpha", { tradingDate: "2026-11-10", orders, runSeq: run, inputSeqs: [src] });
    expect((await commit([{ symbol: "NEO1", side: "buy", qty: 100, limit: 12_010 }], 0)).rejected).toBe("invalid_price");
    expect((await commit([{ symbol: "NEO1", side: "buy", qty: 500_100 }], 1)).rejected).toBe("invalid_qty");
    const r = await commit([{ symbol: "NEO1", side: "buy", qty: 100, limit: 12_000 }], 2);
    expect(r.ok && r.event.type).toBe("order_sheet.committed");
    // 保存済みのログを、追記と同じ検査で確かめ直す（拒否の理由も出し直せる）
    await expect(replay(log.events, { get: () => undefined }, CTX)).resolves.toBeDefined();
  });
});
