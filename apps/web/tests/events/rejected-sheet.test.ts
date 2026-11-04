// 拒否した注文票の記録（docs/EVENT_LOG.md §3.2「受け取った注文票を残す」・§7 の照合。#66）。
// 拒否の理由は、run と入力を外して残しても同じに出し直せること。読めない注文の拒否でも、理由が状態と矛盾しないこと。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { sealEvent } from "../../src/events/chain";
import type { LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/index";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Order } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const H = "c".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set() };
const CTX = { holidayTables: new Map([[H, TABLE]]), accountOf: () => newAccount() };
const buy: Order[] = [{ symbol: "AAA", side: "buy", qty: 100 }];
/** 正規化できない注文（小数の株数） */
const unreadable = [{ symbol: "AAA", side: "buy", qty: 0.5 }] as Order[];

const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });
const op = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt, actor: "operator:owner", refs: [], payload });

async function ok(log: EventLog, d: Draft) {
  const r = await log.append(d);
  if (!r.ok) throw new Error(r.reason);
  return r.event.seq;
}

/** 11/9（月）夜に alpha を登録し、出典と注文の agent.run を書いたログ */
async function setup() {
  const log = new EventLog(CTX);
  await ok(log, op("holidays.adopted", 0, { holidaysSha256: H }));
  await ok(log, op("universe.set", 0, { symbols: ["AAA"] }));
  await ok(log, op("agent.registered", jst("2026-11-09", 20), { agentId: "alpha", startDate: "2026-11-10", initialCash: INITIAL_CASH }));
  const src = await ok(log, sys("source.captured", jst("2026-11-09", 21), { publishedAt: jst("2026-11-09", 19), fetchedAt: jst("2026-11-09", 21) }));
  const run = await ok(log, sys("agent.run", jst("2026-11-09", 22), { agentId: "alpha", purpose: "order", inputSeqs: [src], ok: true }, [src]));
  return { log, src, run };
}

/** 保存済みのログを新しい追記の処理で読み直し、最初の問題を返す（replay と同じ入口） */
async function admitAll(events: readonly LogEvent[]): Promise<string | null> {
  const log = new EventLog(CTX);
  for (const e of events) {
    const p = await log.admit(e);
    if (p) return p;
  }
  return null;
}

/** 保存済みのログの末尾に、読めない注文の拒否を1件足して、連鎖を作り直す */
async function withUnreadable(events: readonly LogEvent[], at: number, payload: Record<string, unknown>, refs: number[] = []): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  const drafts = [...events.map((e) => ({ type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: e.payload as Record<string, unknown> })), { type: "order_sheet.rejected" as const, recordedAt: at, actor: "system" as const, refs, keys: [], payload: { agentId: "alpha", tradingDate: "2026-11-10", ordersUnreadable: true, ...payload } }];
  for (const d of drafts) out.push(await sealEvent(out.at(-1) ?? null, d));
  return out;
}

describe("拒否した注文票の記録（§3.2・§7）", () => {
  it("停止中のAIの注文票は、run と入力の形が崩れていても理由 suspended で、受け取った注文を残す", async () => {
    const { log, src } = await setup();
    await ok(log, op("agent.suspended", jst("2026-11-10", 6), { agentId: "alpha", scope: "orders", reason: "x" }));
    const bad = await log.commitSheet(jst("2026-11-10", 7), "alpha", { tradingDate: "2026-11-10", orders: buy, runSeq: "x" as unknown as number, inputSeqs: [src] });
    expect(bad.ok && [bad.rejected, bad.event.payload]).toEqual(["suspended", { agentId: "alpha", tradingDate: "2026-11-10", reason: "suspended", orders: buy }]);
    // 停止は注文の形より先（§4）。形の違う注文でも、読めない注文でも理由は suspended
    const shape = await log.commitSheet(jst("2026-11-10", 7, 1), "alpha", { tradingDate: "2026-11-10", orders: "x" as unknown as Order[], runSeq: 0, inputSeqs: [src] });
    const unread = await log.commitSheet(jst("2026-11-10", 7, 2), "alpha", { tradingDate: "2026-11-10", orders: unreadable, runSeq: 0, inputSeqs: [src] });
    expect([shape.rejected, unread.rejected]).toEqual(["suspended", "suspended"]);
    expect(await admitAll(log.events)).toBeNull();
    // 停止中に、読めない拒否の理由を invalid_order と書いた記録は落ちる
    expect(await admitAll(await withUnreadable(log.events, jst("2026-11-10", 7, 3), { reason: "invalid_order" }))).toMatch(/order_sheet\.rejected/);
  });

  it("読めない注文の拒否も、照合で理由を確かめて通す（株数・日付・締めの後・停止）", async () => {
    const { log, src, run } = await setup();
    const s = (orders: Order[], tradingDate = "2026-11-10") => ({ tradingDate, orders, runSeq: run, inputSeqs: [src] });
    const r1 = await log.commitSheet(jst("2026-11-10", 7), "alpha", s(unreadable));
    const committed = await log.commitSheet(jst("2026-11-10", 7, 1), "alpha", s(buy));
    const r3 = await log.commitSheet(jst("2026-11-10", 7, 2), "alpha", s(unreadable, "2026-11-11"));
    const r2 = await log.commitSheet(jst("2026-11-10", 9), "alpha", s(unreadable));
    await ok(log, op("agent.suspended", jst("2026-11-10", 9, 1), { agentId: "alpha", scope: "orders", reason: "x" }));
    const r4 = await log.commitSheet(jst("2026-11-10", 9, 2), "alpha", s(unreadable));
    expect(committed.ok && committed.event.type).toBe("order_sheet.committed");
    expect([r1, r2, r3, r4].map((r) => r.rejected)).toEqual(["invalid_qty", "after_cutoff", "wrong_trading_date", "suspended"]);
    for (const r of [r1, r2, r3, r4]) expect(r.ok && r.event.payload).toMatchObject({ ordersUnreadable: true });
    expect(await admitAll(log.events)).toBeNull();
  });

  it("全体の停止（*）でも、形の違う注文・読めない注文・日付の誤りは理由 suspended で、照合を通る", async () => {
    const { log, src } = await setup();
    await ok(log, op("agent.suspended", jst("2026-11-10", 6), { agentId: "*", scope: "orders", reason: "x" }));
    const rs = [];
    for (const [i, [tradingDate, orders]] of ([["nope", buy], ["2026-11-10", [null]], ["2026-11-10", unreadable]] as [string, Order[]][]).entries()) {
      rs.push(await log.commitSheet(jst("2026-11-10", 7, i), "alpha", { tradingDate, orders, runSeq: 999, inputSeqs: [src] }));
    }
    expect(rs.map((r) => r.ok && r.rejected)).toEqual(["suspended", "suspended", "suspended"]);
    expect(await admitAll(log.events)).toBeNull();
  });

  it("検査は通るが正規化できない注文（余分な項目に小数）は、invalid_order の読めない拒否として残る", async () => {
    const { log, src, run } = await setup();
    const orders = [{ symbol: "AAA", side: "buy", qty: 100, limit: 1234.5 }] as unknown as Order[];
    const r = await log.commitSheet(jst("2026-11-10", 7), "alpha", { tradingDate: "2026-11-10", orders, runSeq: run, inputSeqs: [src] });
    expect(r.ok && [r.rejected, r.event.payload]).toEqual(["invalid_order", { agentId: "alpha", tradingDate: "2026-11-10", reason: "invalid_order", runSeq: run, inputSeqs: [src], ordersUnreadable: true }]);
    expect(await admitAll(log.events)).toBeNull();
  });

  it("読めない注文の拒否で、理由が一覧にない、または状態と矛盾する記録は、照合で落ちる", async () => {
    const { log, src, run } = await setup();
    const at = jst("2026-11-10", 7);
    const seqs = { runSeq: run, inputSeqs: [src] };
    expect(await admitAll(await withUnreadable(log.events, at, { reason: "invalid_qty", ...seqs }, [run, src]))).toBeNull();
    expect(await admitAll(await withUnreadable(log.events, at, { reason: "invalid_order" }))).toBeNull();
    const bad: [Record<string, unknown>, number[], number][] = [
      [{ reason: "foo", ...seqs }, [run, src], at],
      [{ reason: null, ...seqs }, [run, src], at],
      [{ ...seqs }, [run, src], at],
      [{ reason: "suspended", ...seqs }, [run, src], at], // 停止していない
      [{ reason: "account_not_ready", ...seqs }, [run, src], at], // 約定待ちも評価済みもない
      [{ reason: "invalid_qty", ...seqs }, [run, src], jst("2026-11-10", 9)], // 締めの後なら after_cutoff のはず
      [{ reason: "invalid_qty" }, [], at], // run と入力がなければ invalid_sheet のはず
      [{ reason: "invalid_sheet", ...seqs, orders: buy }, [run, src], at], // 注文と「読めない」の両方
    ];
    for (const [i, [p, refs, t]] of bad.entries()) expect(await admitAll(await withUnreadable(log.events, t, p, refs)), String(i)).toMatch(/order_sheet\.rejected/);
  });
});
