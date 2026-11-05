// 投稿の種類（intent）と見立て（stance）。post.published の中身の、省略できる項目（#107）。
// 一覧にない値は、追記でも照合（admit・replay）でも同じ理由で断る。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { sealEvent } from "../../src/events/chain";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/index";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const H = "a".repeat(64);
const table: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set() };
const CTX = { holidayTables: new Map([[H, table]]) };
const op = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt, actor: "operator:owner", refs: [], payload });

async function ok(log: EventLog, d: Draft) {
  const r = await log.append(d);
  if (!r.ok) throw new Error(r.reason);
  return r.event.seq;
}

/** 投稿の判断の agent.run まで書いたログ */
async function setup() {
  const log = new EventLog({ ...CTX, accountOf: () => newAccount() });
  await ok(log, op("holidays.adopted", 0, { holidaysSha256: H }));
  await ok(log, op("universe.set", 0, { symbols: ["AAA"] }));
  await ok(log, op("agent.registered", jst("2026-11-09", 20), { agentId: "alpha", startDate: "2026-11-10", initialCash: INITIAL_CASH }));
  const src = await ok(log, { type: "source.captured", recordedAt: jst("2026-11-09", 21), actor: "system", refs: [], payload: { publishedAt: jst("2026-11-09", 19), fetchedAt: jst("2026-11-09", 21) } });
  const run = await ok(log, { type: "agent.run", recordedAt: jst("2026-11-09", 22), actor: "system", refs: [src], payload: { agentId: "alpha", purpose: "post", inputSeqs: [src], ok: true } });
  return { log, run };
}

const post = (run: number, extra: Record<string, unknown>): Draft => ({ type: "post.published", recordedAt: jst("2026-11-09", 23), actor: "agent:alpha", refs: [run], payload: { agentId: "alpha", board: "AAA", bodyHash: "c".repeat(64), runSeq: run, ...extra } });

const BAD: [Record<string, unknown>, string][] = [
  [{ intent: "rumor" }, "intent must be one of strategy, feeling, knowledge, news"],
  [{ intent: 1 }, "intent must be one of strategy, feeling, knowledge, news"],
  [{ intent: null }, "intent must be one of strategy, feeling, knowledge, news"],
  [{ intent: "Strategy" }, "intent must be one of strategy, feeling, knowledge, news"],
  [{ stance: "long" }, "stance must be one of bull, bear, neutral"],
  [{ stance: ["bull"] }, "stance must be one of bull, bear, neutral"],
];

describe("post.published の intent と stance（#107）", () => {
  it("省略した投稿と、一覧の値の投稿は書ける", async () => {
    const { log, run } = await setup();
    await ok(log, post(run, {}));
    for (const intent of ["strategy", "feeling", "knowledge", "news"]) await ok(log, post(run, { intent }));
    for (const stance of ["bull", "bear", "neutral"]) await ok(log, post(run, { stance }));
    await ok(log, post(run, { intent: "news", stance: "bear" }));
  });

  it("一覧にない値・文字列でない値は、追記で理由を返して断る", async () => {
    const { log, run } = await setup();
    for (const [extra, why] of BAD) {
      const r = await log.append(post(run, extra));
      expect(r.ok ? "ok" : r.reason, JSON.stringify(extra)).toBe(why);
    }
  });

  it("投稿を停止したAIは、一覧にない値でも理由 suspended で断る（停止を先に見る、EVENT_LOG §4）", async () => {
    const { log, run } = await setup();
    await ok(log, op("agent.suspended", jst("2026-11-09", 22, 30), { agentId: "alpha", scope: "posts", reason: "test" }));
    const r = await log.append(post(run, { intent: "rumor" }));
    expect(r.ok ? "ok" : r.reason).toBe("suspended");
  });

  it("照合（admit・replay）でも、同じ理由で断る", async () => {
    const { log, run } = await setup();
    await ok(log, post(run, { intent: "strategy", stance: "bull" }));
    const good = log.events;
    expect(await replay(good, { get: () => undefined }, CTX)).toBeDefined();
    for (const [extra, why] of BAD) {
      // 正しい投稿の中身だけを差し替え、連鎖を作り直したログ（追記の処理を通らずに保存されたもの）
      const events: LogEvent[] = [];
      for (const e of good) {
        const payload = e.type === "post.published" ? { ...(e.payload as object), ...extra } : e.payload;
        events.push(await sealEvent(events.at(-1) ?? null, { type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload }));
      }
      const fresh = new EventLog({ ...CTX, accountOf: () => newAccount() });
      let problem: string | null = null;
      for (const e of events) if ((problem = await fresh.admit(e))) break;
      expect(problem, JSON.stringify(extra)).toBe(`seq 6 (post.published): ${why}`);
      await expect(replay(events, { get: () => undefined }, CTX)).rejects.toThrow(why);
    }
  });
});
