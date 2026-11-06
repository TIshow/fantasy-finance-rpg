// docs/EVENT_LOG.md §3・§4 の追記の処理を、架空のAIと銘柄の1日の流れで確かめる。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import type { HolidayTable } from "../../src/holidays/index";
import { verifyChain } from "../../src/events/chain";
import { cutoffOf, newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Order } from "../../src/ledger/types";

/** 日本時間の日時を UNIXミリ秒にする */
const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const H = "a".repeat(64);
const buy: Order[] = [{ symbol: "AAA", side: "buy", qty: 100 }];

const table = (dates: string[], sha = H): HolidayTable => ({ firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: sha, dates: new Set(dates) });

async function ok(log: EventLog, d: Draft) {
  const r = await log.append(d);
  if (!r.ok) throw new Error(r.reason);
  return r.event.seq;
}

const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });
const op = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt, actor: "operator:owner", refs: [], payload });
const reason = async (p: Promise<{ ok: boolean; reason?: string }>) => {
  const r = await p;
  return r.ok ? "ok" : r.reason;
};

/** 11/9（月）の夜に登録し、11/10（火）から売買できるAI。注文の判断の agent.run の seq を返す */
/** 祝日の一覧（版 H）を採用し、取引対象を AAA にしたログ */
async function newLog(holidays: string[] = [], tables: HolidayTable[] = []) {
  const log = new EventLog({ holidayTables: new Map([table(holidays), ...tables].map((t) => [t.contentSha256, t])), accountOf: () => newAccount() });
  await ok(log, op("holidays.adopted", 0, { holidaysSha256: H }));
  await ok(log, op("universe.set", 0, { symbols: ["AAA"] }));
  return log;
}

async function setup(given?: EventLog) {
  const log = given ?? (await newLog());
  await ok(log, op("agent.registered", jst("2026-11-09", 20), { agentId: "alpha", startDate: "2026-11-10", initialCash: INITIAL_CASH }));
  const src = await ok(log, sys("source.captured", jst("2026-11-09", 21), { publishedAt: jst("2026-11-09", 15, 30), fetchedAt: jst("2026-11-09", 21) }));
  const run = await ok(log, sys("agent.run", jst("2026-11-09", 22), { agentId: "alpha", purpose: "order", inputSeqs: [src], ok: true }, [src]));
  return { log, src, run };
}

const sheet = (run: number, inputSeqs: number[], tradingDate = "2026-11-10", orders = buy) => ({ tradingDate, orders, runSeq: run, inputSeqs });

async function commit(log: EventLog, at: number, s: ReturnType<typeof sheet>) {
  const r = await log.commitSheet(at, "alpha", s);
  expect(r.ok && r.event.type).toBe("order_sheet.committed");
  return r.ok ? r.event.seq : -1;
}

/** date の始値・約定・終値・評価・引け後処理をすべて書く */
async function finishDay(log: EventLog, date: string, next: string, sheetSeq: number | null) {
  if (sheetSeq !== null) {
    const open = await ok(log, sys("prices.open", jst(date, 9, 5), { date }));
    await ok(log, sys("fills.executed", jst(date, 9, 6), { agentId: "alpha", tradingDate: date, sheetSeq, openSeq: open }, [sheetSeq, open]));
  }
  const close = await ok(log, sys("prices.close", jst(date, 15, 40), { date }));
  await ok(log, sys("valuation.recorded", jst(date, 15, 41), { agentId: "alpha", date, closeSeq: close }, [close]));
  await ok(log, sys("corporate_actions.applied", jst(date, 15, 42), { agentId: "alpha", asOf: date, exDate: next, announcedSeqs: [] }));
  return close;
}

describe("1日の流れ（§3.3）", () => {
  it("確定 → 始値 → 約定 → 終値 → 評価 → 分割・配当 → 翌日の確定、の順に書け、連鎖も正しい", async () => {
    const { log, src, run } = await setup();
    const sheetSeq = await commit(log, jst("2026-11-10", 8), sheet(run, [src]));
    const close = await finishDay(log, "2026-11-10", "2026-11-11", sheetSeq);
    const run2 = await ok(log, sys("agent.run", jst("2026-11-10", 21), { agentId: "alpha", purpose: "order", inputSeqs: [close], ok: true }, [close]));
    await commit(log, jst("2026-11-10", 22), sheet(run2, [close], "2026-11-11"));
    expect(await verifyChain(log.events)).toEqual([]);
  });

  it("祝日をまたいで、評価と引け後処理は次の営業日へ進む", async () => {
    const { log } = await setup(await newLog(["2026-11-11"]));
    await finishDay(log, "2026-11-10", "2026-11-12", null);
    expect(await reason(log.append(sys("prices.close", jst("2026-11-11", 15, 40), { date: "2026-11-11" })))).toBe("market was closed");
    const close = await ok(log, sys("prices.close", jst("2026-11-12", 15, 40), { date: "2026-11-12" }));
    expect(await reason(log.append(sys("valuation.recorded", jst("2026-11-12", 15, 41), { agentId: "alpha", date: "2026-11-12", closeSeq: close }, [close])))).toBe("ok");
  });

  it("引け後処理の前に翌日の注文票は確定できず、理由と受け取った注文票を残す", async () => {
    const { log, src, run } = await setup();
    const r = await log.commitSheet(jst("2026-11-09", 23), "alpha", sheet(run, [src], "2026-11-11"));
    expect(r.rejected).toBe("wrong_trading_date");
    expect(r.ok && r.event.payload).toEqual({ agentId: "alpha", tradingDate: "2026-11-11", reason: "wrong_trading_date", runSeq: run, inputSeqs: [src], orders: buy });
  });

  it("締めちょうど（8:30）の注文票は受け付けない", async () => {
    const { log, src, run } = await setup();
    expect((await log.commitSheet(cutoffOf("2026-11-10") - 1, "alpha", sheet(run, [src]))).rejected).toBeUndefined();
    const { log: log2, src: src2, run: run2 } = await setup();
    expect((await log2.commitSheet(cutoffOf("2026-11-10"), "alpha", sheet(run2, [src2]))).rejected).toBe("after_cutoff");
  });

  it("同じ日の2枚目の注文票、同じ注文票の2回目の約定、同じ日の2回目の引け後処理は書けない", async () => {
    const { log, src, run } = await setup();
    const sheetSeq = await commit(log, jst("2026-11-10", 8), sheet(run, [src]));
    expect((await log.commitSheet(jst("2026-11-10", 8, 1), "alpha", sheet(run, [src]))).rejected).toBe("already_committed");
    const open = await ok(log, sys("prices.open", jst("2026-11-10", 9), { date: "2026-11-10" }));
    const fills = sys("fills.executed", jst("2026-11-10", 9, 1), { agentId: "alpha", tradingDate: "2026-11-10", sheetSeq, openSeq: open }, [sheetSeq, open]);
    await ok(log, fills);
    expect(await reason(log.append({ ...fills, recordedAt: jst("2026-11-10", 9, 2) }))).not.toBe("ok");
    const close = await ok(log, sys("prices.close", jst("2026-11-10", 15, 40), { date: "2026-11-10" }));
    await ok(log, sys("valuation.recorded", jst("2026-11-10", 15, 41), { agentId: "alpha", date: "2026-11-10", closeSeq: close }, [close]));
    const post = sys("corporate_actions.applied", jst("2026-11-10", 15, 42), { agentId: "alpha", asOf: "2026-11-10", exDate: "2026-11-11", announcedSeqs: [] });
    await ok(log, post);
    expect(await reason(log.append({ ...post, recordedAt: jst("2026-11-10", 15, 43) }))).not.toBe("ok");
  });

  it("始値のない約定、終値のない評価、約定前の評価・引け後処理、注文票のない約定は書けない", async () => {
    const { log, src, run } = await setup();
    const sheetSeq = await commit(log, jst("2026-11-10", 8), sheet(run, [src]));
    const noOpen = sys("fills.executed", jst("2026-11-10", 8, 10), { agentId: "alpha", tradingDate: "2026-11-10", sheetSeq }, [sheetSeq]);
    expect(await reason(log.append(noOpen))).toBe("openSeq must be prices.open of the trading date");
    const close = await ok(log, sys("prices.close", jst("2026-11-10", 15, 40), { date: "2026-11-10" }));
    expect(await reason(log.append(sys("valuation.recorded", jst("2026-11-10", 15, 41), { agentId: "alpha", date: "2026-11-10", closeSeq: close }, [close])))).toBe("the committed sheet is not filled yet");
    expect(await reason(log.append(sys("corporate_actions.applied", jst("2026-11-10", 15, 42), { agentId: "alpha", asOf: "2026-11-10", exDate: "2026-11-11", announcedSeqs: [] })))).toBe("the committed sheet is not filled yet");
    expect(await reason(log.append(sys("fills.executed", jst("2026-11-10", 15, 43), { agentId: "alpha", tradingDate: "2026-11-11", sheetSeq }, [sheetSeq])))).toBe("no committed sheet for this trading date");
  });

  it("終値のない評価は書けず、評価のあとに同じ日の注文票は確定できない", async () => {
    const { log, src, run } = await setup();
    expect(await reason(log.append(sys("valuation.recorded", jst("2026-11-09", 23), { agentId: "alpha", date: "2026-11-10" })))).toBe("closeSeq must be prices.close of the date");
    expect(await reason(log.append(sys("prices.close", jst("2026-11-10", 7), { date: "2026-11-10" })))).toBe("close prices recorded before 15:30");
    await finishDay(log, "2026-11-10", "2026-11-11", null);
    expect((await log.commitSheet(jst("2026-11-10", 20), "alpha", sheet(run, [src]))).rejected).toBe("after_cutoff");
  });

  it("引け後処理に渡す公表は、権利落ち日が翌営業日のものを seq の昇順で", async () => {
    const { log } = await setup();
    const a1 = await ok(log, sys("corporate_action.announced", jst("2026-11-09", 23), { symbol: "AAA", kind: "dividend", exDate: "2026-11-11" }));
    const a2 = await ok(log, sys("corporate_action.announced", jst("2026-11-09", 23, 1), { symbol: "AAA", kind: "split", exDate: "2026-11-11" }));
    const other = await ok(log, sys("corporate_action.announced", jst("2026-11-09", 23, 2), { symbol: "AAA", kind: "dividend", exDate: "2026-11-12" }));
    const close = await ok(log, sys("prices.close", jst("2026-11-10", 15, 40), { date: "2026-11-10" }));
    await ok(log, sys("valuation.recorded", jst("2026-11-10", 15, 41), { agentId: "alpha", date: "2026-11-10", closeSeq: close }, [close]));
    const post = (announcedSeqs: number[]) => sys("corporate_actions.applied", jst("2026-11-10", 15, 42), { agentId: "alpha", asOf: "2026-11-10", exDate: "2026-11-11", announcedSeqs }, announcedSeqs);
    expect(await reason(log.append(post([a1, other])))).toBe("announcedSeqs must be announcements with exDate 2026-11-11");
    expect(await reason(log.append(post([close])))).toBe("announcedSeqs must be announcements with exDate 2026-11-11");
    expect(await reason(log.append(post([a2, a1])))).toBe("announcedSeqs must be in ascending order");
    expect(await reason(log.append(post([a1, a2])))).toBe("ok");
  });
});

describe("時点（§3.1・§3.2）", () => {
  it("始値は約定日の締め（8:30）より前と、休場日には記録できない", async () => {
    const log = await newLog();
    expect(await reason(log.append(sys("prices.open", jst("2026-11-10", 8, 29), { date: "2026-11-10" })))).toBe("open prices recorded before the cutoff");
    expect(await reason(log.append(sys("prices.open", jst("2026-11-10", 8, 30), { date: "2026-11-10" })))).toBe("ok");
    expect(await reason(log.append(sys("prices.open", jst("2026-11-14", 9), { date: "2026-11-14" })))).toBe("market was closed");
  });

  it("出典は publishedAt <= fetchedAt <= recordedAt でなければ記録できない", async () => {
    const log = await newLog();
    const t = jst("2026-11-10", 7);
    expect(await reason(log.append(sys("source.captured", t, { publishedAt: t + 1, fetchedAt: t + 1 })))).not.toBe("ok");
    expect(await reason(log.append(sys("source.captured", t, { publishedAt: t - 2, fetchedAt: t + 1 })))).not.toBe("ok");
    expect(await reason(log.append(sys("source.captured", t, { publishedAt: t - 2, fetchedAt: t - 1 })))).toBe("ok");
  });

  it("締めの後に公開された情報は、締めより前に記録できないので、その日の注文票の入力にできない", async () => {
    const { log } = await setup();
    // 公開時刻より前には取得できず、取得時刻より前には記録できない。注文票の確定は締めより前なので、入力の seq はそれより前に限られる
    expect(await reason(log.append(sys("source.captured", jst("2026-11-10", 8), { publishedAt: jst("2026-11-10", 8, 30), fetchedAt: jst("2026-11-10", 8) })))).not.toBe("ok");
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

  it("前の営業日の終値は、翌営業日の注文票の入力に使える（約定日以後の価格は、記録の時刻の決まりで確定より前に書けない）", async () => {
    const { log, src } = await setup();
    await finishDay(log, "2026-11-10", "2026-11-11", null);
    const close = log.events.find((e) => e.type === "prices.close")!.seq;
    const run = await ok(log, sys("agent.run", jst("2026-11-10", 21), { agentId: "alpha", purpose: "order", inputSeqs: [src, close], ok: true }, [src, close]));
    await commit(log, jst("2026-11-10", 22), sheet(run, [src], "2026-11-11"));
  });
});

describe("書ける者と入力の形（§3・§4）", () => {
  it("種類ごとの書ける者以外と、別のAIのIDを書いたAIは拒み、注文票は commitSheet からだけ書ける", async () => {
    const { log, src, run } = await setup();
    expect(await reason(log.append({ ...sys("prices.open", jst("2026-11-10", 9), { date: "2026-11-10" }), actor: "agent:alpha" }))).toBe("prices.open must be written by system");
    expect(await reason(log.append({ ...op("agent.resumed", jst("2026-11-10", 9), { agentId: "alpha", scope: "both", reason: "x" }), actor: "agent:alpha" }))).toBe("agent.resumed must be written by operator");
    expect(await reason(log.append({ type: "post.published", recordedAt: jst("2026-11-10", 9), actor: "agent:beta", refs: [run], payload: { agentId: "alpha", runSeq: run } }))).toBe("agentId does not match the actor");
    expect(await reason(log.append({ type: "order_sheet.committed", recordedAt: jst("2026-11-10", 8), actor: "agent:alpha", refs: [run, src], payload: { agentId: "alpha", ...sheet(run, [src]), holidaysSha256: "b".repeat(64) } }))).toBe("use commitSheet");
  });

  it("中身で指すイベントは refs にもなければならない", async () => {
    const { log, run } = await setup();
    expect(await reason(log.append(sys("agent.run", jst("2026-11-10", 7), { agentId: "alpha", purpose: "order", inputSeqs: [run], ok: true })))).toBe(`payload refers to ${run} outside refs`);
  });

  it("形の違う注文票や中身は、例外にせず拒否として残す", async () => {
    const { log, src, run } = await setup();
    const r1 = await log.commitSheet(jst("2026-11-10", 8), "alpha", sheet(run, [src], "2026-11-10", [null] as unknown as Order[]));
    expect(r1.rejected).toBe("invalid_order");
    const r2 = await log.commitSheet(jst("2026-11-10", 8), "alpha", { ...sheet(run, [src]), inputSeqs: null as unknown as number[] });
    expect(r2.rejected).toBe("invalid_sheet");
    const r3 = await log.commitSheet(jst("2026-11-10", 8), "alpha", sheet(run, [src], "2026-11-10", [{ symbol: "AAA", side: "buy", qty: 1.5 }]));
    expect(r3.ok && r3.event.payload).toMatchObject({ reason: "invalid_qty", ordersUnreadable: true });
    expect(await reason(log.append({ ...sys("prices.open", jst("2026-11-10", 9), {}), payload: null as unknown as Record<string, unknown> }))).toBe("payload must be an object");
    expect(await reason(log.append(op("ledger.adjusted", jst("2026-11-10", 9), { agentId: "alpha" })))).toBe("invalid correctionSeq");
    // NUL 文字は Postgres に保存できないので、保存の前に、追記の拒否として返す（#110 PR-2d）
    expect(await reason(log.append(op("agent.suspended", jst("2026-11-10", 9), { agentId: "*", scope: "orders", reason: "点検\u0000" })))).toBe("NUL character at $.payload.reason");
  });
});

describe("停止と臨時休場（§3.3・§6.3）", () => {
  it("全体の注文の停止中は理由 suspended で残し、再開すれば確定できる", async () => {
    const { log, src, run } = await setup();
    await ok(log, op("agent.suspended", jst("2026-11-10", 7), { agentId: "*", scope: "orders", reason: "test" }));
    expect((await log.commitSheet(jst("2026-11-10", 7, 1), "alpha", sheet(run, [src]))).rejected).toBe("suspended");
    expect(await reason(log.append(op("agent.resumed", jst("2026-11-10", 7, 2), { agentId: "alpha", scope: "orders", reason: "test" })))).toContain("not suspended");
    await ok(log, op("agent.resumed", jst("2026-11-10", 7, 2), { agentId: "*", scope: "orders", reason: "test" }));
    await commit(log, jst("2026-11-10", 7, 3), sheet(run, [src]));
  });

  it("特定のAIの投稿の停止は、そのAIの投稿だけを止める。範囲と理由のない停止は拒む", async () => {
    const { log, src, run } = await setup();
    const postRun = await ok(log, sys("agent.run", jst("2026-11-10", 6), { agentId: "alpha", purpose: "post", inputSeqs: [src], ok: true }, [src]));
    expect(await reason(log.append(op("agent.suspended", jst("2026-11-10", 7), { agentId: "alpha", scope: "order", reason: "x" })))).toBe("scope must be posts, orders or both");
    expect(await reason(log.append(op("agent.suspended", jst("2026-11-10", 7), { agentId: "alpha", scope: "posts" })))).toBe("reason is required");
    await ok(log, op("agent.suspended", jst("2026-11-10", 7), { agentId: "alpha", scope: "posts", reason: "test" }));
    expect(await reason(log.append({ type: "post.published", recordedAt: jst("2026-11-10", 7, 1), actor: "agent:alpha", refs: [postRun], payload: { agentId: "alpha", runSeq: postRun } }))).toBe("suspended");
    await commit(log, jst("2026-11-10", 7, 2), sheet(run, [src]));
  });

  it("臨時休場の日は始値なしで注文票を閉じ、評価は次の営業日へ進む", async () => {
    const { log, src, run } = await setup();
    const sheetSeq = await commit(log, jst("2026-11-10", 8), sheet(run, [src]));
    await ok(log, op("market.closed", jst("2026-11-10", 8, 40), { date: "2026-11-10" }));
    expect(await reason(log.append(sys("prices.open", jst("2026-11-10", 9), { date: "2026-11-10" })))).toBe("market was closed");
    await ok(log, sys("fills.executed", jst("2026-11-10", 9), { agentId: "alpha", tradingDate: "2026-11-10", sheetSeq }, [sheetSeq]));
    const close = await ok(log, sys("prices.close", jst("2026-11-11", 15, 40), { date: "2026-11-11" }));
    await ok(log, sys("valuation.recorded", jst("2026-11-11", 15, 41), { agentId: "alpha", date: "2026-11-11", closeSeq: close }, [close]));
  });

  it("始値・終値のあとや、AIがもう評価した日は臨時休場にできない", async () => {
    const { log } = await setup();
    await finishDay(log, "2026-11-10", "2026-11-11", null);
    expect(await reason(log.append(op("market.closed", jst("2026-11-10", 20), { date: "2026-11-10" })))).toBe("close prices already recorded");
    await ok(log, sys("prices.open", jst("2026-11-11", 9), { date: "2026-11-11" }));
    expect(await reason(log.append(op("market.closed", jst("2026-11-11", 9, 1), { date: "2026-11-11" })))).toBe("open prices already recorded");
  });

  it("開始日は登録時点の次の約定日だけ。先の日のAIで臨時休場が書けなくなることはない", async () => {
    const log = await newLog();
    const reg = (startDate: string) => op("agent.registered", jst("2026-11-09", 20), { agentId: "beta", startDate, initialCash: INITIAL_CASH });
    expect(await reason(log.append(reg("2026-12-01")))).toBe("startDate must be the next trading date");
    expect(await reason(log.append(reg("2026-11-09")))).toBe("startDate must be the next trading date");
    expect(await reason(log.append(reg("2026-11-10")))).toBe("ok");
    expect(await reason(log.append(op("market.closed", jst("2026-11-10", 8, 40), { date: "2026-11-10" })))).toBe("ok");
  });

  it("時計が戻った記録は拒む", async () => {
    const { log } = await setup();
    expect(await reason(log.append(sys("source.captured", jst("2026-11-09", 19), { publishedAt: jst("2026-11-09", 15), fetchedAt: jst("2026-11-09", 19) })))).toContain("recordedAt goes backwards");
  });
});

describe("祝日の一覧の版と取引対象（§3.5）", () => {
  it("一覧を採用する前は営業日を使うイベントを書けず、知らない版と同じ版は採用できない", async () => {
    const log = new EventLog({ holidayTables: new Map([[H, table([])]]), accountOf: () => newAccount() });
    expect(await reason(log.append(sys("prices.open", jst("2026-11-10", 9), { date: "2026-11-10" })))).toBe("no holiday table adopted");
    expect(await reason(log.append(op("agent.registered", jst("2026-11-09", 20), { agentId: "alpha", startDate: "2026-11-10", initialCash: INITIAL_CASH })))).toBe("no holiday table adopted");
    expect(await reason(log.append(op("holidays.adopted", 0, { holidaysSha256: "b".repeat(64) })))).toBe(`unknown holiday table ${"b".repeat(64)}`);
    await ok(log, op("holidays.adopted", 0, { holidaysSha256: H }));
    expect(await reason(log.append(op("holidays.adopted", 0, { holidaysSha256: H })))).toBe("this holiday table is already adopted");
  });

  it("一覧を替えても、ログが使った日付までの休場日は変えられない。その後の日付は直せ、以後の判定は新しい一覧による", async () => {
    const [B, C, D] = ["b", "c", "d"].map((x) => x.repeat(64)) as [string, string, string];
    const log = await newLog([], [table(["2026-11-11"], B), table(["2026-11-10"], C), { ...table([], D), firstYear: 2027 }]);
    const { src, run } = await setup(log); // 開始日 11/10 まで使った
    const adopt = (sha: string) => reason(log.append(op("holidays.adopted", jst("2026-11-09", 23), { holidaysSha256: sha })));
    expect(await adopt(C)).toBe("holiday table changes 2026-11-10, which the log already used");
    expect(await adopt(D)).toBe("holiday table must cover 2026-2026");
    expect(await adopt(B)).toBe("ok");
    const sheetSeq = await commit(log, jst("2026-11-10", 8), sheet(run, [src]));
    expect(log.events.at(-1)!.payload).toMatchObject({ holidaysSha256: B });
    // 11/11 が休場になったので、11/10 の引け後処理の権利落ち日は 11/12
    await finishDay(log, "2026-11-10", "2026-11-12", sheetSeq);
  });

  it("ログが使った日付は、営業日の判定を通した日付だけで進む（公表の権利落ち日・臨時休場の日・拒否した注文票の約定日では進まない）", async () => {
    const [G, G2, OLD] = ["e", "f", "0"].map((x) => x.repeat(64)) as [string, string, string];
    const later = ["2026-11-20", "2026-11-30", "2026-12-01"];
    const log = await newLog([], [table(["2026-11-11", ...later], G), table(later, G2), { ...table([], OLD), firstYear: 2020, lastYear: 2025 }]);
    const { src, run } = await setup(log); // 開始日 11/10 まで使った
    await ok(log, sys("corporate_action.announced", jst("2026-11-09", 22, 10), { symbol: "AAA", kind: "dividend", exDate: "2026-12-01" }));
    await ok(log, op("market.closed", jst("2026-11-09", 22, 20), { date: "2026-11-20" }));
    expect((await log.commitSheet(jst("2026-11-09", 22, 30), "alpha", sheet(run, [src], "2026-11-30"))).rejected).toBe("wrong_trading_date");
    const adopt = (sha: string, at: number) => reason(log.append(op("holidays.adopted", at, { holidaysSha256: sha })));
    expect(await adopt(OLD, jst("2026-11-09", 23))).toBe("holiday table must cover 2026-2026");
    // 11/10 の翌日から後は直せる
    expect(await adopt(G, jst("2026-11-09", 23))).toBe("ok");
    const sheetSeq = await commit(log, jst("2026-11-10", 8), sheet(run, [src]));
    await finishDay(log, "2026-11-10", "2026-11-12", sheetSeq); // 引け後処理の権利落ち日 11/12 まで使った
    expect(await adopt(G2, jst("2026-11-10", 16))).toBe("holiday table changes 2026-11-11, which the log already used");
  });

  it("取引対象にない銘柄は注文できず、取引対象は重複のない昇順で替え、約定待ちの注文票があれば銘柄を外せない", async () => {
    const { log, src, run } = await setup();
    const set = (symbols: unknown) => reason(log.append(op("universe.set", jst("2026-11-09", 23), { symbols })));
    expect((await log.commitSheet(jst("2026-11-09", 22, 30), "alpha", sheet(run, [src], "2026-11-10", [{ symbol: "BBB", side: "buy", qty: 100 }]))).rejected).toBe("unknown_symbol");
    expect(await set(["BBB", "AAA"])).toBe("symbols must be distinct symbol codes in ascending order");
    expect(await set(["AAA"])).toBe("symbols are the same as the current universe");
    expect(await set(["AAA", "BBB"])).toBe("ok");
    await commit(log, jst("2026-11-10", 8), sheet(run, [src]));
    expect(await reason(log.append(op("universe.set", jst("2026-11-10", 8, 1), { symbols: ["AAA", "BBB", "CCC"] })))).toBe("ok");
    expect(await reason(log.append(op("universe.set", jst("2026-11-10", 8, 2), { symbols: ["BBB"] })))).toBe("agent alpha has a committed sheet that is not filled yet");
  });
});
