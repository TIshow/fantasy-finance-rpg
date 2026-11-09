// 切り替えの日（2026-11-09。D-047）より前の記録は、毎日を取引日にする決まりを入れたあとも、同じ記録になり、照合を通る。
// 祝日（11/3）と週末をまたぐ、11/2（月）〜11/6（金）の4営業日と、土曜に確定した 11/9（月）の注文票のログを組み立てる。
// 前の取引日の日中（締めと引けの間）の登録・確定・拒否も入れる（判断の受け付けの時間の決まりは、11/9 以前の取引日に当てない）。
// 期待するハッシュは、毎日を取引日にする前の実装（origin/milestone/228-every-day の ae7663d）で、同じ手順を実行して得た値。
// このファイルは、前の実装でも動くように、前からある関数だけを使う。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { canonicalize } from "../../src/events/canonical";
import { sha256Hex } from "../../src/events/hash";
import type { HolidayTable } from "../../src/holidays/index";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Order } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const SHA = "a".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: SHA, dates: new Set(["2026-11-03", "2026-11-23"]) };
const CTX = { holidayTables: new Map([[SHA, TABLE]]), accountOf: () => newAccount() };
const buy: Order[] = [{ symbol: "AAA", side: "buy", qty: 100 }];
/** 毎日を取引日にする前の実装で得た、ログの正規化した JSON の sha256 */
const EXPECTED = "6d1f1f05576d3bea23c657020a71f2d0d10d1b41defdf42f4e91369342cd272b";

/** 取引日、注文票を確定する時刻、引け後処理の権利落ち日（次の営業日） */
const DAYS: [string, number, string][] = [
  ["2026-11-02", jst("2026-11-02", 7), "2026-11-04"], // 当日の朝（前の実行の時刻）。11/3 は祝日
  ["2026-11-04", jst("2026-11-03", 12), "2026-11-05"], // 祝日の昼
  ["2026-11-05", jst("2026-11-05", 6, 50), "2026-11-06"],
  ["2026-11-06", jst("2026-11-05", 23, 50), "2026-11-09"], // 前の日の夜。金曜の次は月曜
];

async function buildLog(): Promise<EventLog> {
  const log = new EventLog(CTX);
  const add = async (d: Draft) => {
    const r = await log.append(d);
    if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
    return r.event.seq;
  };
  const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });
  const op = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt, actor: "operator:owner", refs: [], payload });
  /** 注文票を確定する。want を渡すと、その理由で拒否の記録が残ることを確かめる */
  const commit = async (at: number, tradingDate: string, agentId = "alpha", runAt = at - 1000, want?: string) => {
    const run = await add(sys("agent.run", runAt, { agentId, purpose: "order", inputSeqs: [], ok: true }));
    const c = await log.commitSheet(at, agentId, { tradingDate, orders: buy, runSeq: run, inputSeqs: [] });
    if (!c.ok || c.rejected !== want) throw new Error(`commitSheet ${agentId} ${tradingDate}: ${c.ok ? String(c.rejected) : c.reason}`);
    return c.event.seq;
  };
  const register = (agentId: string, at: number, startDate: string) => add(op("agent.registered", at, { agentId, startDate, initialCash: INITIAL_CASH }));
  /** 寄り付きのあと、引けより前に書く記録（前の取引日の締めと引けの間の、登録・確定・拒否） */
  const midday: Record<string, () => Promise<unknown>> = {
    "2026-11-05": async () => {
      // 前の取引日の日中に登録し、その日のうちに翌営業日の注文票を確定する（11/5 10:00 に登録、12:00 に 11/6 の注文票。前の作りで受け付けた）
      await register("gamma", jst("2026-11-05", 10), "2026-11-06");
      await commit(jst("2026-11-05", 12), "2026-11-06", "gamma", jst("2026-11-05", 11, 59));
      // 引け後処理の前の alpha の、11/6 の注文票の拒否（前の作りの理由は account_not_ready）
      await commit(jst("2026-11-05", 12, 1), "2026-11-06", "alpha", jst("2026-11-05", 12), "account_not_ready");
    },
    "2026-11-06": async () => {
      // 金曜の日中に登録し、すぐに月曜（11/9）の注文票を確定する（11/6 10:00 に登録、10:05 に確定）
      await register("beta", jst("2026-11-06", 10), "2026-11-09");
      await commit(jst("2026-11-06", 10, 5), "2026-11-09", "beta", jst("2026-11-06", 10, 4));
    },
  };

  await add(op("holidays.adopted", 0, { holidaysSha256: SHA }));
  await add(op("universe.set", 0, { symbols: ["AAA"] }));
  // 金曜の夜に登録すると、開始日は月曜
  await register("alpha", jst("2026-10-30", 20), "2026-11-02");
  for (const [date, at, next] of DAYS) {
    const sheet = await commit(at, date);
    const open = await add(sys("prices.open", jst(date, 9, 5), { date }));
    await add(sys("fills.executed", jst(date, 9, 6), { agentId: "alpha", tradingDate: date, sheetSeq: sheet, openSeq: open }, [sheet, open]));
    await midday[date]?.();
    const close = await add(sys("prices.close", jst(date, 15, 40), { date }));
    await add(sys("valuation.recorded", jst(date, 15, 41), { agentId: "alpha", date, closeSeq: close }, [close]));
    await add(sys("corporate_actions.applied", jst(date, 15, 42), { agentId: "alpha", asOf: date, exDate: next, announcedSeqs: [] }));
  }
  // 土曜（11/7）に確定した、11/9（月）の注文票
  await commit(jst("2026-11-07", 10), "2026-11-09");
  return log;
}

describe("切り替えの日より前の記録の照合（D-047）", () => {
  it("同じ手順で同じ記録になり、保存した記録を1件ずつ照合しても通る", async () => {
    const log = await buildLog();
    expect(log.events.every((e) => e.recordedAt < jst("2026-11-09", 0))).toBe(true);
    expect(await sha256Hex(new TextEncoder().encode(canonicalize(log.events)))).toBe(EXPECTED);
    const again = new EventLog(CTX);
    for (const e of log.events) expect(await again.admit(e)).toBeNull();
  });
});
