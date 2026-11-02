// docs/EVENT_LOG.md §3・§4 の追記の処理を、架空のAIと銘柄の1日の流れで確かめる。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { verifyChain } from "../../src/events/chain";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH } from "../../src/ledger/types";

/** 日本時間の日時を UNIXミリ秒にする */
const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const H = "a".repeat(64);
const buy = [{ symbol: "AAA", side: "buy" as const, qty: 100 }];

const newLog = () => new EventLog({ universe: new Set(["AAA"]), holidays: new Set(), holidaysSha256: H, accountOf: () => newAccount() });

async function ok(log: EventLog, d: Draft) {
  const r = await log.append(d);
  if (!r.ok) throw new Error(r.reason);
  return r.event.seq;
}

const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });

/** 11/9（月）の夜に登録し、11/10（火）から売買できるAI。注文の判断の agent.run の seq を返す */
async function setup() {
  const log = newLog();
  await ok(log, { type: "agent.registered", recordedAt: jst("2026-11-09", 20), actor: "operator:owner", refs: [], payload: { agentId: "alpha", startDate: "2026-11-10", initialCash: INITIAL_CASH } });
  const src = await ok(log, sys("source.captured", jst("2026-11-09", 21), { publishedAt: jst("2026-11-09", 15, 30), fetchedAt: jst("2026-11-09", 21) }));
  const run = await ok(log, sys("agent.run", jst("2026-11-09", 22), { agentId: "alpha", purpose: "order", inputSeqs: [src], ok: true }, [src]));
  return { log, src, run };
}

const sheet = (run: number, inputSeqs: number[], tradingDate = "2026-11-10") => ({ tradingDate, orders: buy, runSeq: run, inputSeqs });

describe("1日の流れ（§3.3）", () => {
  it("確定 → 始値 → 約定 → 終値 → 評価 → 分割・配当 → 翌日の確定、の順に書け、連鎖も正しい", async () => {
    const { log, src, run } = await setup();
    const c = await log.commitSheet(jst("2026-11-10", 8), "alpha", sheet(run, [src]));
    expect(c.ok && c.event.type).toBe("order_sheet.committed");
    const sheetSeq = c.ok ? c.event.seq : 0;
    const open = await ok(log, sys("prices.open", jst("2026-11-10", 9, 5), { date: "2026-11-10" }));
    await ok(log, sys("fills.executed", jst("2026-11-10", 9, 6), { agentId: "alpha", tradingDate: "2026-11-10", sheetSeq, openSeq: open }, [sheetSeq, open]));
    const close = await ok(log, sys("prices.close", jst("2026-11-10", 15, 40), { date: "2026-11-10" }));
    await ok(log, sys("valuation.recorded", jst("2026-11-10", 15, 41), { agentId: "alpha", date: "2026-11-10", closeSeq: close }, [close]));
    await ok(log, sys("corporate_actions.applied", jst("2026-11-10", 15, 42), { agentId: "alpha", asOf: "2026-11-10", exDate: "2026-11-11", announcedSeqs: [] }));
    const run2 = await ok(log, sys("agent.run", jst("2026-11-10", 21), { agentId: "alpha", purpose: "order", inputSeqs: [close], ok: true }, [close]));
    const c2 = await log.commitSheet(jst("2026-11-10", 22), "alpha", sheet(run2, [close], "2026-11-11"));
    expect(c2.ok && c2.event.type).toBe("order_sheet.committed");
    expect(await verifyChain(log.events)).toEqual([]);
  });

  it("引け後処理の前に翌日の注文票は確定できず、理由を残す", async () => {
    const { log, src, run } = await setup();
    const r = await log.commitSheet(jst("2026-11-09", 23), "alpha", sheet(run, [src], "2026-11-11"));
    expect(r.ok && r.event.type).toBe("order_sheet.rejected");
    expect(r.rejected).toBe("wrong_trading_date");
  });

  it("同じ日の2枚目の注文票、同じ注文票の2回目の約定、同じ日の2回目の引け後処理は書けない", async () => {
    const { log, src, run } = await setup();
    const c = await log.commitSheet(jst("2026-11-10", 8), "alpha", sheet(run, [src]));
    const sheetSeq = c.ok ? c.event.seq : 0;
    const again = await log.commitSheet(jst("2026-11-10", 8, 1), "alpha", sheet(run, [src]));
    expect(again.rejected).toBe("already_committed");
    const open = await ok(log, sys("prices.open", jst("2026-11-10", 9), { date: "2026-11-10" }));
    const fills = sys("fills.executed", jst("2026-11-10", 9, 1), { agentId: "alpha", tradingDate: "2026-11-10", sheetSeq, openSeq: open }, [sheetSeq, open]);
    await ok(log, fills);
    expect(await log.append({ ...fills, recordedAt: jst("2026-11-10", 9, 2) })).toMatchObject({ ok: false });
    const close = await ok(log, sys("prices.close", jst("2026-11-10", 15, 40), { date: "2026-11-10" }));
    await ok(log, sys("valuation.recorded", jst("2026-11-10", 15, 41), { agentId: "alpha", date: "2026-11-10", closeSeq: close }, [close]));
    const post = sys("corporate_actions.applied", jst("2026-11-10", 15, 42), { agentId: "alpha", asOf: "2026-11-10", exDate: "2026-11-11", announcedSeqs: [] });
    await ok(log, post);
    expect(await log.append({ ...post, recordedAt: jst("2026-11-10", 15, 43) })).toMatchObject({ ok: false });
  });

  it("約定の前の評価、評価の前の引け後処理、注文票のない約定は書けない", async () => {
    const { log, src, run } = await setup();
    const c = await log.commitSheet(jst("2026-11-10", 8), "alpha", sheet(run, [src]));
    const sheetSeq = c.ok ? c.event.seq : 0;
    const close = await ok(log, sys("prices.close", jst("2026-11-10", 15, 40), { date: "2026-11-10" }));
    expect(await log.append(sys("valuation.recorded", jst("2026-11-10", 15, 41), { agentId: "alpha", date: "2026-11-10", closeSeq: close }, [close]))).toEqual({ ok: false, reason: "the committed sheet is not filled yet" });
    expect(await log.append(sys("corporate_actions.applied", jst("2026-11-10", 15, 42), { agentId: "alpha", asOf: "2026-11-10", exDate: "2026-11-11", announcedSeqs: [] }))).toMatchObject({ ok: false });
    expect(await log.append(sys("fills.executed", jst("2026-11-10", 15, 43), { agentId: "alpha", tradingDate: "2026-11-11", sheetSeq }, [sheetSeq]))).toEqual({ ok: false, reason: "no committed sheet for this trading date" });
  });

  it("同じ公表を2つの日の引け後処理で渡すと、口座を変える前に拒む", async () => {
    const { log } = await setup();
    const ann = await ok(log, sys("corporate_action.announced", jst("2026-11-09", 23), { symbol: "AAA" }));
    for (const [date, next] of [["2026-11-10", "2026-11-11"], ["2026-11-11", "2026-11-12"]] as const) {
      const close = await ok(log, sys("prices.close", jst(date, 15, 40), { date }));
      await ok(log, sys("valuation.recorded", jst(date, 15, 41), { agentId: "alpha", date, closeSeq: close }, [close]));
      const r = await log.append(sys("corporate_actions.applied", jst(date, 15, 42), { agentId: "alpha", asOf: date, exDate: next, announcedSeqs: [ann] }, [ann]));
      expect(r.ok).toBe(date === "2026-11-10");
      if (!r.ok) expect(r.reason).toContain("duplicate key ca:alpha:");
    }
  });
});

describe("時点（§3.1・§3.2）", () => {
  it("始値は約定日の締め（8:30）より前には記録できない", async () => {
    const log = newLog();
    expect(await log.append(sys("prices.open", jst("2026-11-10", 8, 29), { date: "2026-11-10" }))).toEqual({ ok: false, reason: "open prices recorded before the cutoff" });
    expect((await log.append(sys("prices.open", jst("2026-11-10", 8, 30), { date: "2026-11-10" }))).ok).toBe(true);
  });

  it("出典は publishedAt <= fetchedAt <= recordedAt でなければ記録できない", async () => {
    const log = newLog();
    const t = jst("2026-11-10", 7);
    expect((await log.append(sys("source.captured", t, { publishedAt: t + 1, fetchedAt: t + 1 }))).ok).toBe(false);
    expect((await log.append(sys("source.captured", t, { publishedAt: t - 2, fetchedAt: t + 1 }))).ok).toBe(false);
    expect((await log.append(sys("source.captured", t, { publishedAt: t - 2, fetchedAt: t - 1 }))).ok).toBe(true);
  });

  it("締めの後に公開された情報は、締めより前に記録できないので、その日の注文票の入力にできない", async () => {
    const { log } = await setup();
    // 公開時刻より前には取得できず、取得時刻より前には記録できない。注文票の確定は締めより前なので、入力の seq はそれより前に限られる
    expect((await log.append(sys("source.captured", jst("2026-11-10", 8), { publishedAt: jst("2026-11-10", 8, 30), fetchedAt: jst("2026-11-10", 8) }))).ok).toBe(false);
    const late = await ok(log, sys("source.captured", jst("2026-11-10", 8, 31), { publishedAt: jst("2026-11-10", 8, 30), fetchedAt: jst("2026-11-10", 8, 31) }));
    const run = await ok(log, sys("agent.run", jst("2026-11-10", 8, 32), { agentId: "alpha", purpose: "order", inputSeqs: [late], ok: true }, [late]));
    expect((await log.commitSheet(jst("2026-11-10", 8, 33), "alpha", sheet(run, [late]))).rejected).toBe("invalid_sheet");
  });

  it("注文票の入力は、同じAIの成功した注文の agent.run の入力の一部に限る", async () => {
    const { log, src, run } = await setup();
    const other = await ok(log, sys("source.captured", jst("2026-11-09", 22, 30), { publishedAt: jst("2026-11-09", 16), fetchedAt: jst("2026-11-09", 22, 30) }));
    const postRun = await ok(log, sys("agent.run", jst("2026-11-10", 7), { agentId: "alpha", purpose: "post", inputSeqs: [src], ok: true }, [src]));
    expect((await log.commitSheet(jst("2026-11-10", 8), "alpha", sheet(run, [src, other]))).rejected).toBe("invalid_sheet");
    expect((await log.commitSheet(jst("2026-11-10", 8), "alpha", sheet(postRun, [src]))).rejected).toBe("invalid_sheet");
  });
});

describe("書ける者（§3）", () => {
  it("種類ごとの書ける者以外と、別のAIのIDを書いたAIは拒む", async () => {
    const { log, src, run } = await setup();
    expect(await log.append({ type: "prices.open", recordedAt: jst("2026-11-10", 9), actor: "agent:alpha", refs: [], payload: { date: "2026-11-10" } })).toEqual({ ok: false, reason: "prices.open must be written by system" });
    expect(await log.append({ type: "agent.resumed", recordedAt: jst("2026-11-10", 9), actor: "agent:alpha", refs: [], payload: { agentId: "alpha", scope: "both" } })).toMatchObject({ ok: false });
    expect(await log.append({ type: "order_sheet.committed", recordedAt: jst("2026-11-10", 8), actor: "agent:beta", refs: [run, src], payload: { agentId: "alpha", ...sheet(run, [src]) } })).toEqual({ ok: false, reason: "agentId does not match the actor" });
  });

  it("中身で指すイベントは refs にもなければならない", async () => {
    const { log, run } = await setup();
    expect(await log.append(sys("agent.run", jst("2026-11-10", 7), { agentId: "alpha", purpose: "order", inputSeqs: [run], ok: true }))).toEqual({ ok: false, reason: `payload refers to ${run} outside refs` });
  });
});

describe("停止と臨時休場（§3.3・§6.3）", () => {
  it("注文を止めたAIの注文票は、理由 suspended で残し、再開すれば確定できる", async () => {
    const { log, src, run } = await setup();
    await ok(log, { type: "agent.suspended", recordedAt: jst("2026-11-10", 7), actor: "operator:owner", refs: [], payload: { agentId: "*", scope: "orders" } });
    expect((await log.commitSheet(jst("2026-11-10", 7, 1), "alpha", sheet(run, [src]))).rejected).toBe("suspended");
    await ok(log, { type: "agent.resumed", recordedAt: jst("2026-11-10", 7, 2), actor: "operator:owner", refs: [], payload: { agentId: "*", scope: "orders" } });
    expect((await log.commitSheet(jst("2026-11-10", 7, 3), "alpha", sheet(run, [src]))).rejected).toBeUndefined();
  });

  it("臨時休場の日は始値なしで注文票を閉じ、評価は次の営業日へ進む。始値のあとの休場は拒む", async () => {
    const { log, src, run } = await setup();
    const c = await log.commitSheet(jst("2026-11-10", 8), "alpha", sheet(run, [src]));
    const sheetSeq = c.ok ? c.event.seq : 0;
    await ok(log, { type: "market.closed", recordedAt: jst("2026-11-10", 8, 40), actor: "operator:owner", refs: [], payload: { date: "2026-11-10" } });
    expect((await log.append(sys("prices.open", jst("2026-11-10", 9), { date: "2026-11-10" }))).ok).toBe(false);
    await ok(log, sys("fills.executed", jst("2026-11-10", 9), { agentId: "alpha", tradingDate: "2026-11-10", sheetSeq }, [sheetSeq]));
    const close = await ok(log, sys("prices.close", jst("2026-11-11", 15, 40), { date: "2026-11-11" }));
    await ok(log, sys("valuation.recorded", jst("2026-11-11", 15, 41), { agentId: "alpha", date: "2026-11-11", closeSeq: close }, [close]));
    const open = await ok(log, sys("prices.open", jst("2026-11-12", 9), { date: "2026-11-12" }));
    expect(await log.append({ type: "market.closed", recordedAt: jst("2026-11-12", 9, 1), actor: "operator:owner", refs: [], payload: { date: "2026-11-12" } })).toEqual({ ok: false, reason: "open prices already recorded" });
    expect(open).toBeGreaterThan(0);
  });

  it("時計が戻った記録は拒む", async () => {
    const { log } = await setup();
    const r = await log.append(sys("source.captured", jst("2026-11-09", 19), { publishedAt: jst("2026-11-09", 15), fetchedAt: jst("2026-11-09", 19) }));
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain("recordedAt goes backwards");
  });
});
