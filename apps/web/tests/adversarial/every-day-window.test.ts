// 検証役（#228、core の PR #230）：架空の市場の毎日の取引（D-047）と、判断の受け付けの時間（#228 の lead の決定）を壊しにいく。
// 文書と決定から書き出した「成り立つはずのこと」：
// (1) 取引日 D（11/10 以後）の注文票は、前の取引日の引け（16:30）から D の締め（8:30）の前まで確定できる。元の判断（agent.run）と
//     LLM の依頼（submittedAt）も、前の取引日の引けのあとだけ。夜（17:50・23:50・04:50）の判断の入力は、D の締めより前の記録だけ
// (2) 11/9 以後は土日・祝日・年末年始も取引日。休みは臨時休場（market.closed）だけ。11/9 より前の記録の意味は変わらない
// (3) 同じ日の注文票・同じ日の LLM の依頼は1回だけ。遅れて何度動いても、口座は1回分しか変わらない
// (4) 前の暦（金曜の次は月曜）で書いた記録は、11/13（金）の夜からは新しい照合で落ちる（大枠を main に入れる期限の根拠）
// 追記の処理（EventLog）・台帳（Ledger）・照合（admit・replay）を通す。欠陥の再現は it.fails。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { sealEvent } from "../../src/events/chain";
import { bodyHash } from "../../src/events/hash";
import { Ledger, replay, type ValueStore } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/table";
import { cutoffOf, decisionOpensAt, isTradingDay, marketClosedDays, nextTradingDay, previousTradingDay, upcomingTradingDay } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Order } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0, ss = 0, ms = 0) =>
  Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}+09:00`);
const SHA = "a".repeat(64);
/** 11/3（切り替えより前の祝日）、11/23（勤労感謝の日）、2027-01-11（成人の日）を祝日にした一覧 */
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: SHA, dates: new Set(["2026-11-03", "2026-11-23", "2027-01-11"]) };
const CTX = { holidayTables: new Map([[SHA, TABLE]]) };
const CLOSED = marketClosedDays(TABLE.dates);
const BUY: Order[] = [{ symbol: "AAA", side: "buy", qty: 100 }];
const SELL: Order[] = [{ symbol: "AAA", side: "sell", qty: 100 }];
const [THU, FRI, SAT, SUN, MON] = ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"];
const BODY = "b".repeat(64);

class Store implements ValueStore {
  readonly map = new Map<string, { salt: Uint8Array; value: unknown }>();
  async put(value: unknown) {
    const salt = new Uint8Array(16).fill(this.map.size + 7);
    const hash = await bodyHash(salt, { value });
    this.map.set(hash, { salt, value });
    return hash;
  }
  get(hash: string) {
    return this.map.get(hash);
  }
}

type Result = Awaited<ReturnType<EventLog["commitSheet"]>>;
const outcome = (r: Result) => (r.ok ? (r.rejected ?? r.event.type) : `error: ${r.reason}`);

/** alpha（と ids）を regAt に登録した、台帳つきのログ。書けた記録はすぐ台帳にも当てる */
async function world(regAt: number, ids = ["alpha"]) {
  const store = new Store();
  const ledger = new Ledger(store);
  const log = new EventLog({ ...CTX, accountOf: (id) => ledger.account(id) });
  const append = async (d: Draft) => {
    const r = await log.append(d);
    if (r.ok) await ledger.apply(r.event);
    return r;
  };
  const add = async (d: Draft) => {
    const r = await append(d);
    if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
    return r.event.seq;
  };
  const reason = async (d: Draft) => {
    const r = await append(d);
    return r.ok ? "ok" : r.reason;
  };
  const sys = (type: Draft["type"], at: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt: at, actor: "system", refs, payload });
  const op = (type: Draft["type"], at: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt: at, actor: "operator:owner", refs: [], payload });
  const run = (at: number, agentId = "alpha", inputSeqs: number[] = [], extra: Record<string, unknown> = {}, refs: number[] = inputSeqs) =>
    add(sys("agent.run", at, { agentId, purpose: "order", inputSeqs, ok: true, ...extra }, refs));
  const commit = async (at: number, tradingDate: string, runSeq: number, orders: Order[] = BUY, agentId = "alpha", inputSeqs: number[] = []) => {
    const r = await log.commitSheet(at, agentId, { tradingDate, orders, runSeq, inputSeqs });
    if (r.ok) await ledger.apply(r.event);
    return r;
  };
  /** 判断（run）と確定を続けて書く。確定できた注文票の seq を返す */
  const decide = async (at: number, tradingDate: string, orders: Order[] = BUY, agentId = "alpha", inputSeqs: number[] = []) => {
    const r = await commit(at, tradingDate, await run(at - 1, agentId, inputSeqs), orders, agentId, inputSeqs);
    if (!r.ok || r.rejected) throw new Error(`commit ${agentId} ${tradingDate} at ${new Date(at).toISOString()}: ${outcome(r)}`);
    return r.event.seq;
  };
  /** date の始値と、渡した注文票の約定 */
  const morning = async (date: string, price: number, sheets: [string, number][]) => {
    const open = await add(sys("prices.open", jst(date, 9, 5), { date, valuesHash: await store.put({ AAA: price }) }));
    for (const [i, [id, sheet]] of sheets.entries()) {
      const f = await ledger.computeFills(id, sheet, open);
      await add(sys("fills.executed", jst(date, 9, 6 + i), { agentId: id, tradingDate: date, sheetSeq: sheet, openSeq: open, ...f.payload }, [sheet, open]));
    }
    return open;
  };
  /** date の終値・評価・引け後処理（権利落ち日は次の取引日。その日が権利落ち日の公表を渡す） */
  const evening = async (date: string, price: number, agents: string[], announced: number[] = [], at = jst(date, 15, 40)) => {
    const close = await add(sys("prices.close", at, { date, valuesHash: await store.put({ AAA: price }) }));
    const next = nextTradingDay(date, log.holidays());
    for (const [i, id] of agents.entries()) {
      await add(sys("valuation.recorded", at + 60_000 * (2 * i + 1), { agentId: id, date, closeSeq: close, ...ledger.computeValuation(id, date) }, [close]));
      const ca = await ledger.computeCorporate(id, date, next, announced);
      await add(sys("corporate_actions.applied", at + 60_000 * (2 * i + 2), { agentId: id, asOf: date, exDate: next, announcedSeqs: announced, ...ca.payload }, announced));
    }
    return close;
  };
  await add(op("holidays.adopted", 0, { holidaysSha256: SHA }));
  await add(op("universe.set", 0, { symbols: ["AAA"] }));
  for (const [i, id] of ids.entries()) await add(op("agent.registered", regAt + i, { agentId: id, startDate: upcomingTradingDay(regAt + i, CLOSED), initialCash: INITIAL_CASH }));
  return { store, ledger, log, append, add, reason, sys, op, run, commit, decide, morning, evening };
}

/** 保存済みのログを、新しい追記の処理と台帳で先頭から照合する。最初の問題を返す */
async function admitAll(events: readonly LogEvent[], store: ValueStore): Promise<string | null> {
  const ledger = new Ledger(store);
  const log = new EventLog({ ...CTX, accountOf: (id) => ledger.account(id) });
  for (const e of events) {
    const p = await log.admit(e);
    if (p) return `seq ${e.seq} (${e.type}): ${p}`;
    await ledger.apply(e);
  }
  return null;
}
type Forge = Draft & { keys: string[] };
const draftOf = (e: LogEvent): Forge => ({ type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: e.payload as Record<string, unknown> });
async function forge(drafts: readonly Forge[]): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  for (const d of drafts) out.push(await sealEvent(out.at(-1) ?? null, d));
  return out;
}

/** LLM の依頼の記録（①）。submittedAt を変えられる */
const submitted = (recordedAt: number, tradingDate: string, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.submitted",
  recordedAt,
  actor: "system",
  refs: [],
  payload: {
    agentId: "alpha", provider: "anthropic", modelId: "m", promptVersion: "v1", sentBodyHash: BODY, maxCost: 150, tradingDate, submittedAt: recordedAt,
    yenPerUsd: 160, inputCentsPer10MTok: 1000, outputCentsPer10MTok: 5000, maxInputTokens: 50_000, maxOutputTokens: 8_000, bodyMaxOutputTokens: 8_000,
    customId: `alpha-${tradingDate.replaceAll("-", "")}-${BODY.slice(0, 16)}`,
    ...extra,
  },
});

describe("夜の判断（前の日の 17:50・23:50、当日の 04:50）の入力は、D の締めより前の記録だけ", () => {
  // 3つの時刻それぞれで、前の取引日の終値・評価・出典を入力にした判断が確定でき、締めより後の情報は入れられない
  for (const [label, at] of [["前の日の 17:50", jst(FRI, 17, 50)], ["前の日の 23:50", jst(FRI, 23, 50)], ["当日の 04:50", jst(SAT, 4, 50)]] as const) {
    it(`${label}：前の取引日の終値・評価・締め前の出典で、土曜の注文票を確定できる。土曜の値段は入力にできない`, async () => {
      const w = await world(jst(THU, 20));
      await w.morning(FRI, 10_000, [["alpha", await w.decide(jst(THU, 23, 50), FRI)]]);
      const close = await w.evening(FRI, 10_500, ["alpha"]);
      const valuation = w.log.events.find((e) => e.type === "valuation.recorded" && (e.payload as { date: string }).date === FRI)!.seq;
      const src = await w.add(w.sys("source.captured", at - 120_000, { publishedAt: at - 180_000, fetchedAt: at - 120_000 }));
      const inputs = [close, valuation, src];
      const sheet = await w.decide(at, SAT, SELL, "alpha", inputs);
      // 確定の時点で、土曜の締めより後の記録は1件もない
      expect(w.log.events.every((e) => e.recordedAt < cutoffOf(SAT))).toBe(true);
      // 土曜の始値を記録してから、それを入力にした判断で同じ日の注文票を出し直しても、締めのあとで断る
      const open = await w.morning(SAT, 10_400, [["alpha", sheet]]);
      const late = await w.commit(jst(SAT, 9, 30), SAT, await w.run(jst(SAT, 9, 29), "alpha", [open]), SELL, "alpha", [open]);
      // 入力の検査（土曜の値段は土曜の判断に使えない）が、締めの検査より先に断る
      expect(outcome(late)).toBe("invalid_sheet");
      expect(await admitAll(w.log.events, w.store)).toBeNull();
    });
  }

  it("並べ替え：締めのあとに公開した出典を、夜の判断の前に差し込んだログは、連鎖か入力の検査で落ちる", async () => {
    const w = await world(jst(THU, 20));
    await w.morning(FRI, 10_000, [["alpha", await w.decide(jst(THU, 23, 50), FRI)]]);
    await w.evening(FRI, 10_500, ["alpha"]);
    await w.decide(jst(FRI, 23, 50), SAT, SELL);
    const d = w.log.events.map(draftOf);
    const runIdx = d.length - 2; // 夜の agent.run
    // 土曜の 08:40 に公開した出典（締めのあと）を、夜の判断の直前に入れ、判断と注文票の入力に足す
    const leak: Forge = { type: "source.captured", recordedAt: jst(SAT, 8, 45), actor: "system", refs: [], keys: [], payload: { publishedAt: jst(SAT, 8, 40), fetchedAt: jst(SAT, 8, 45) } };
    const leakSeq = runIdx + 1;
    const shift = (s: number) => (s >= leakSeq ? s + 1 : s);
    const run = d[runIdx]!;
    const sheet = d[runIdx + 1]!;
    const runForged: Forge = { ...run, refs: [leakSeq], payload: { ...run.payload, inputSeqs: [leakSeq] } };
    const sheetForged: Forge = { ...sheet, refs: [leakSeq + 1, leakSeq], payload: { ...sheet.payload, runSeq: leakSeq + 1, inputSeqs: [leakSeq] } };
    expect(shift(runIdx + 1)).toBe(leakSeq + 1);
    // 出典の時刻をそのまま書くと、記録の時刻が戻るので、連鎖を作り直すこともできない
    await expect(forge([...d.slice(0, runIdx), leak, runForged, sheetForged])).rejects.toThrow(/recordedAt goes backwards/);
    // 出典の記録の時刻だけを夜に偽っても、公開時刻が記録より後になるので出典の検査で落ちる
    const leakEarly: Forge = { ...leak, recordedAt: jst(FRI, 23, 48) };
    expect(await admitAll(await forge([...d.slice(0, runIdx), leakEarly, runForged, sheetForged]), w.store)).toMatch(/publishedAt <= fetchedAt <= recordedAt/);
    // 公開時刻も夜に偽れば通る（記録からは見分けられない。出典の時刻は取り込み口が書く値）が、締めより前の情報としてしか入らない
    const leakAll: Forge = { ...leak, recordedAt: jst(FRI, 23, 48), payload: { publishedAt: jst(FRI, 23, 47), fetchedAt: jst(FRI, 23, 48) } };
    expect(await admitAll(await forge([...d.slice(0, runIdx), leakAll, runForged, sheetForged]), w.store)).toBeNull();
  });
});

describe("最初に受け付けの時間を当てる日（11/10）の境目", () => {
  it("11/10 の LLM の依頼：submittedAt が 11/9 16:30 の1ミリ秒前なら断り、16:30 ちょうどなら書ける（記録の時刻が後でも同じ）", async () => {
    const opens = jst("2026-11-09", 16, 30);
    expect(decisionOpensAt("2026-11-10", CLOSED)).toBe(opens);
    for (const recordedAt of [opens, opens + 30 * 60_000]) {
      const w = await world(jst("2026-11-08", 20));
      expect(await w.reason(submitted(Math.max(recordedAt, opens - 1), "2026-11-10", { submittedAt: opens - 1 })), String(recordedAt)).toBe("submittedAt must be after the close of the previous trading day");
      expect(await w.reason(submitted(recordedAt, "2026-11-10", { submittedAt: opens })), String(recordedAt)).toBe("ok");
    }
  });

  it("11/9 の取引日の依頼（切り替えの日まで）は、前の作りのまま、11/6（金）の日中でも書ける", async () => {
    const w = await world(jst("2026-11-05", 20));
    expect(await w.reason(submitted(jst("2026-11-06", 10), "2026-11-09"))).toBe("ok");
  });

  it("11/9 16:29 の判断で、16:30 ちょうどに 11/10 の注文票を確定すると invalid_sheet。16:30 の判断なら確定できる", async () => {
    const w = await world(jst("2026-11-08", 20));
    await w.morning("2026-11-09", 10_000, [["alpha", await w.decide(jst("2026-11-09", 6, 50), "2026-11-09")]]);
    await w.evening("2026-11-09", 10_000, ["alpha"]);
    const early = await w.run(jst("2026-11-09", 16, 29));
    // 1ミリ秒前の確定は wrong_trading_date
    expect(outcome(await w.commit(jst("2026-11-09", 16, 30) - 1, "2026-11-10", early, SELL))).toBe("wrong_trading_date");
    expect(outcome(await w.commit(jst("2026-11-09", 16, 30), "2026-11-10", early, SELL))).toBe("invalid_sheet");
    const onTime = await w.run(jst("2026-11-09", 16, 30));
    expect(outcome(await w.commit(jst("2026-11-09", 16, 30), "2026-11-10", onTime, SELL))).toBe("order_sheet.committed");
    expect(await admitAll(w.log.events, w.store)).toBeNull();
  });
});

describe("切り替えのあとの週末：金→土→日→月を、始値・約定・終値・評価・引け後処理まで回す", () => {
  it("土日も取引日として約定し、日曜が権利落ち日の配当は土曜の引け後処理で入る。口座は replay と一致し、照合を通る", async () => {
    const w = await world(jst(THU, 20), ["alpha", "beta"]);
    // 金曜：両方が買う（木曜の夜 23:50 に確定）
    const fa = await w.decide(jst(THU, 23, 50), FRI, BUY, "alpha");
    const fb = await w.decide(jst(THU, 23, 52), FRI, BUY, "beta");
    await w.morning(FRI, 10_000, [["alpha", fa], ["beta", fb]]);
    await w.evening(FRI, 10_100, ["alpha", "beta"]);
    // 土曜：alpha は金曜の 17:50 に確定、beta は土曜の 04:50 に確定（引け後処理は金曜の夜に済んでいる）
    const sa = await w.decide(jst(FRI, 17, 50), SAT, BUY, "alpha");
    const sb = await w.decide(jst(SAT, 4, 50), SAT, SELL, "beta");
    await w.morning(SAT, 10_200, [["alpha", sa], ["beta", sb]]);
    // 土曜の 15:31 に、日曜が権利落ち日の配当（1株 50円＝500）を公表する
    const div = await w.add(w.sys("corporate_action.announced", jst(SAT, 15, 31), { symbol: "AAA", kind: "dividend", exDate: SUN, valuesHash: await w.store.put({ kind: "dividend", perShare: 500 }) }));
    await w.evening(SAT, 10_300, ["alpha", "beta"], [div]);
    const afterSat = { alpha: w.ledger.account("alpha"), beta: w.ledger.account("beta") };
    expect(afterSat.alpha.holdings.AAA?.qty).toBe(200);
    expect(afterSat.beta.holdings.AAA).toBeUndefined();
    // 日曜：alpha は土曜の 23:50 に売りを確定
    const ua = await w.decide(jst(SAT, 23, 50), SUN, SELL, "alpha");
    await w.morning(SUN, 10_000, [["alpha", ua]]);
    await w.evening(SUN, 10_000, ["alpha", "beta"]);
    // 月曜：beta は日曜の 17:50 に買う
    const mb = await w.decide(jst(SUN, 17, 50), MON, BUY, "beta");
    await w.morning(MON, 9_900, [["beta", mb]]);
    await w.evening(MON, 9_900, ["alpha", "beta"]);

    // 板寄せ（始値）と評価が、金・土・日・月の4日すべてにある
    const dates = (t: string) => w.log.events.filter((e) => e.type === t).map((e) => (e.payload as { date: string }).date);
    expect(dates("prices.open")).toEqual([FRI, SAT, SUN, MON]);
    expect([...new Set(dates("valuation.recorded"))]).toEqual([FRI, SAT, SUN, MON]);
    // 配当は、土曜の引け後に持っていた alpha（200株）にだけ入る：200 × 500
    const applied = w.log.events.filter((e) => e.type === "corporate_actions.applied" && (e.payload as { exDate: string }).exDate === SUN);
    expect(applied.map((e) => [(e.payload as { agentId: string }).agentId, JSON.stringify((e.payload as { actions: unknown[] }).actions)])).toEqual([
      ["alpha", expect.stringContaining("100000")],
      ["beta", "[]"],
    ]);
    const replayed = await replay(w.log.events, w.store, CTX);
    for (const id of ["alpha", "beta"]) expect(replayed.account(id), id).toEqual(w.ledger.account(id));
    expect(await admitAll(w.log.events, w.store)).toBeNull();
  });

  it("切り替えより前の週末（11/7・11/8）は休みのまま：土曜の始値・終値は書けず、金曜の次の取引日は月曜", async () => {
    const w = await world(jst("2026-11-05", 20));
    await w.morning("2026-11-06", 10_000, [["alpha", await w.decide(jst("2026-11-06", 7), "2026-11-06")]]);
    await w.evening("2026-11-06", 10_000, ["alpha"]);
    expect(await w.reason(w.sys("prices.open", jst("2026-11-07", 9), { date: "2026-11-07", valuesHash: await w.store.put({ AAA: 1 }) }))).toBe("market was closed");
    expect(await w.reason(w.sys("prices.close", jst("2026-11-07", 15, 40), { date: "2026-11-07", valuesHash: await w.store.put({ AAA: 1 }) }))).toBe("market was closed");
    expect(nextTradingDay("2026-11-06", w.log.holidays())).toBe("2026-11-09");
    // 金曜の夜の確定は、月曜（11/9）の分
    await w.decide(jst("2026-11-06", 23, 50), "2026-11-09");
  });
});

describe("臨時休場（market.closed）と受け付けの時間", () => {
  it("土曜の注文票を金曜の夜に確定したあとで土曜を休場にすると、土曜は全件失効し、日曜の注文票は失効の記録のあとに確定できる", async () => {
    const w = await world(jst(THU, 20));
    await w.morning(FRI, 10_000, [["alpha", await w.decide(jst(THU, 23, 50), FRI)]]);
    await w.evening(FRI, 10_000, ["alpha"]);
    const sat = await w.decide(jst(FRI, 17, 50), SAT, BUY);
    await w.add(w.op("market.closed", jst(FRI, 20), { date: SAT, reason: "test" }));
    // 休場を記録すると、金曜の夜の「次の取引日」は日曜になり、受け付けは金曜の 16:30 から
    expect(upcomingTradingDay(jst(FRI, 23, 50), w.log.holidays())).toBe(SUN);
    expect(decisionOpensAt(SUN, w.log.holidays())).toBe(jst(FRI, 16, 30));
    // 土曜の注文票がまだ約定していないので、日曜の注文票は account_not_ready
    expect(outcome(await w.commit(jst(FRI, 23, 50), SUN, await w.run(jst(FRI, 23, 49)), BUY))).toBe("account_not_ready");
    // 土曜の朝に全件失効（market_closed）を記録する
    const f = await w.ledger.computeFills("alpha", sat, undefined);
    expect(f.payload.fills.map((x: { reason: string | null }) => x.reason)).toEqual(["market_closed"]);
    await w.add(w.sys("fills.executed", jst(SAT, 9), { agentId: "alpha", tradingDate: SAT, sheetSeq: sat, ...f.payload }, [sat]));
    // 休場の日中（土曜の 10:00）でも、日曜の受け付けの中。判断が金曜の引けより後なら確定できる
    await w.decide(jst(SAT, 10), SUN, BUY);
    // 土曜の始値・終値は書けない
    expect(await w.reason(w.sys("prices.open", jst(SAT, 10, 5), { date: SAT, valuesHash: await w.store.put({ AAA: 1 }) }))).toBe("market was closed");
    expect(await admitAll(w.log.events, w.store)).toBeNull();
  });

  it("休場の前の日の日中（金曜 12:00）の確定は、休場の次の取引日（日曜）にも受け付けない", async () => {
    const w = await world(jst(THU, 20));
    await w.add(w.op("market.closed", jst(THU, 21), { date: SAT, reason: "test" }));
    await w.morning(FRI, 10_000, [["alpha", await w.decide(jst(THU, 23, 50), FRI)]]);
    expect(outcome(await w.commit(jst(FRI, 12), SUN, await w.run(jst(FRI, 11, 59)), BUY))).toBe("wrong_trading_date");
    expect(outcome(await w.commit(jst(FRI, 12, 2), SAT, await w.run(jst(FRI, 12, 1)), BUY))).toBe("wrong_trading_date");
  });

  it("2日続けて休場（土・日）にすると、月曜の受け付けは金曜の 16:30 から。LLM の依頼も同じ", async () => {
    const w = await world(jst(THU, 20));
    await w.add(w.op("market.closed", jst(THU, 21), { date: SAT, reason: "test" }));
    await w.add(w.op("market.closed", jst(THU, 21, 1), { date: SUN, reason: "test" }));
    expect(decisionOpensAt(MON, w.log.holidays())).toBe(jst(FRI, 16, 30));
    await w.morning(FRI, 10_000, [["alpha", await w.decide(jst(THU, 23, 50), FRI)]]);
    expect(await w.reason(submitted(jst(FRI, 16, 30) - 1, MON))).toBe("submittedAt must be after the close of the previous trading day");
    expect(await w.reason(submitted(jst(FRI, 16, 30), MON))).toBe("ok");
  });
});

describe("切り替えのあとの年末年始（12/31〜1/3）と祝日は取引日", () => {
  it("12/31・1/1・1/2・1/3・1/11（成人の日）が取引日で、12/30 の夜から 1/4 まで毎日、約定と引け後処理が進む", async () => {
    for (const d of ["2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-11", "2026-11-23"]) expect(isTradingDay(d, CLOSED), d).toBe(true);
    expect(previousTradingDay("2027-01-04", CLOSED)).toBe("2027-01-03");
    const w = await world(jst("2026-12-30", 20));
    let sheet = await w.decide(jst("2026-12-30", 23, 50), "2026-12-31");
    const days = ["2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04"];
    for (const [i, d] of days.entries()) {
      await w.morning(d, 10_000 + i * 100, [["alpha", sheet]]);
      await w.evening(d, 10_000 + i * 100, ["alpha"]);
      if (i < days.length - 1) sheet = await w.decide(jst(d, 17, 50), days[i + 1]!, i % 2 === 0 ? SELL : BUY);
    }
    expect(w.log.events.filter((e) => e.type === "fills.executed").length).toBe(5);
    // 買い（12/31）→売り→買い→売り→買い（1/4）で、100株
    expect(w.ledger.account("alpha").holdings.AAA?.qty).toBe(100);
    expect(await admitAll(w.log.events, w.store)).toBeNull();
  });

  it("大みそかの 16:35 の LLM の依頼は、元日の取引日の分で、費用は12/31 に付く", async () => {
    const w = await world(jst("2026-12-30", 20));
    expect(await w.reason(submitted(jst("2026-12-31", 16, 35), "2027-01-04"))).toBe("tradingDate must be the next trading date");
    expect(await w.reason(submitted(jst("2026-12-31", 16, 35), "2027-01-01"))).toBe("ok");
  });
});

describe("11/13（金）の落とし穴：前の暦で書いた記録は、新しい照合で落ちる", () => {
  // main の今のコード（前の暦）は、11/13（金）16:35 に「次の営業日＝11/16（月）」として LLM の依頼を記録する。
  // 新しいコードでは 11/13 の次の取引日は 11/14（土）なので、追記でも、保存済みのログの照合でも落ちる。
  // 大枠を main に入れるのは 11/13 16:30 より前でなければならない（orchestrator のコメント）。この試験はその根拠を書き留める。
  it("11/13 16:35 の 11/16 の依頼は、追記で断る（正しい取引日は 11/14）", async () => {
    const w = await world(jst(THU, 20));
    expect(await w.reason(submitted(jst(FRI, 16, 35), MON))).toBe("tradingDate must be the next trading date");
    expect(await w.reason(submitted(jst(FRI, 16, 35), SAT))).toBe("ok");
  });

  it("前の暦で保存したログ（11/13 16:35 の 11/16 の依頼）は、照合（毎日の照合を含む）で落ちる", async () => {
    const w = await world(jst(THU, 20));
    const s = await w.add(submitted(jst(FRI, 16, 35), SAT));
    expect(s).toBeGreaterThan(0);
    const d = w.log.events.map(draftOf);
    const last = d.at(-1)!;
    const oldRule: Forge = { ...last, keys: [], payload: { ...last.payload, tradingDate: MON, customId: `alpha-${MON.replaceAll("-", "")}-${BODY.slice(0, 16)}` } };
    expect(await admitAll(await forge([...d.slice(0, -1), oldRule]), w.store)).toMatch(/tradingDate must be the next trading date/);
  });

  it("規則の AI が金曜の夜に 11/16 の分を確定した前の暦の記録も、照合で落ちる（新しい暦では wrong_trading_date）", async () => {
    const w = await world(jst(THU, 20));
    await w.morning(FRI, 10_000, [["alpha", await w.decide(jst(THU, 23, 50), FRI)]]);
    await w.evening(FRI, 10_000, ["alpha"]);
    expect(outcome(await w.commit(jst(FRI, 23, 50), MON, await w.run(jst(FRI, 23, 49)), BUY))).toBe("wrong_trading_date");
    // 前の暦で確定として保存した記録に書き換えると、照合で落ちる
    const d = w.log.events.map(draftOf);
    const last = d.at(-1)!;
    const p = last.payload as Record<string, unknown>;
    const committed: Forge = { type: "order_sheet.committed", recordedAt: last.recordedAt, actor: "agent:alpha", refs: last.refs, keys: [], payload: { agentId: "alpha", tradingDate: MON, orders: BUY, runSeq: p.runSeq, inputSeqs: p.inputSeqs, holidaysSha256: SHA } };
    expect(await admitAll(await forge([...d.slice(0, -1), committed]), w.store)).toMatch(/order_sheet\.committed/);
  });

  it("11/9〜11/12 の夜は、新旧の暦で次の取引日が同じ（その間の記録は新しい照合を通る）", async () => {
    for (const day of ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]) {
      const t = jst(day, 16, 35);
      expect(upcomingTradingDay(t, CLOSED), day).toBe(nextTradingDay(day, CLOSED));
      // 前の暦（土日を休みにする）の次の日と同じ
      const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      expect(upcomingTradingDay(t, CLOSED), day).toBe(next);
    }
    expect(upcomingTradingDay(jst(FRI, 16, 35), CLOSED)).toBe(SAT);
  });
});

describe("遅れて何度動いても二重に書かない", () => {
  it("17:50 に確定したあと、23:50・04:50 にもう一度確定しようとすると already_committed。確定は1件だけで、口座は1回分", async () => {
    const w = await world(jst(THU, 20));
    await w.morning(FRI, 10_000, [["alpha", await w.decide(jst(THU, 23, 50), FRI)]]);
    await w.evening(FRI, 10_000, ["alpha"]);
    const first = await w.decide(jst(FRI, 17, 50), SAT, BUY);
    for (const at of [jst(FRI, 23, 50), jst(SAT, 4, 50)]) {
      expect(outcome(await w.commit(at, SAT, await w.run(at - 1), BUY)), new Date(at).toISOString()).toBe("already_committed");
    }
    const sheets = w.log.events.filter((e) => e.type === "order_sheet.committed" && (e.payload as { tradingDate: string }).tradingDate === SAT);
    expect(sheets.map((e) => e.seq)).toEqual([first]);
    await w.morning(SAT, 10_000, [["alpha", first]]);
    // 約定は1回だけ書ける
    const f = await w.ledger.computeFills("alpha", first, w.log.events.find((e) => e.type === "prices.open" && (e.payload as { date: string }).date === SAT)!.seq);
    expect(await w.reason(w.sys("fills.executed", jst(SAT, 9, 30), { agentId: "alpha", tradingDate: SAT, sheetSeq: first, ...f.payload }, [first]))).not.toBe("ok");
    expect(w.ledger.account("alpha").holdings.AAA?.qty).toBe(200);
    expect(await admitAll(w.log.events, w.store)).toBeNull();
  });

  it("16:35 の依頼のあと、遅れた実行が 17:50 にもう一度依頼しても、同じ AI・同じ取引日の2件目は書けない", async () => {
    const w = await world(jst(THU, 20));
    expect(await w.reason(submitted(jst(FRI, 16, 35), SAT))).toBe("ok");
    expect(await w.reason(submitted(jst(FRI, 17, 50), SAT, { sentBodyHash: "c".repeat(64), customId: `alpha-20261114-${"c".repeat(16)}` }))).toMatch(/duplicate key llmbatch:alpha:2026-11-14$/);
    expect(w.log.events.filter((e) => e.type === "llm.batch.submitted").length).toBe(1);
  });
});
