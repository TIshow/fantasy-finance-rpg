// 検証（verifier、#139）：毎日の実行のコマンドの本体（scripts/daily-lib.ts の runDaily）を、本番の準備（productionSetup：
// 架空の6社の上場・取引対象・売買役とAI投資家の登録と最初の配分）のまま、PGlite（Node の中で動く Postgres）に対して回す。
// 実装の試験（tests/store/daily.test.ts）は、外の銘柄の世界で通しを確かめているので、ここでは架空の6社だけの世界を確かめる。
// 確かめること：
// - 同じ日を2回回しても記録が増えない。記録だけから作り直した台帳（replay）が、保管を開き直した口座と一致する
// - 途中で落ちても（DB への追記の失敗・COMMIT の返事が届かない）、回し直せば、落ちなかった場合と同じ並びの記録になる
// - 決算の発表が、判断の記録（agent.run）より前に記録された分だけ入力に入り、その時点で発表済みの直近4四半期がそろう
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDaily, verifyDatabase, WORLD_SEED } from "../../scripts/daily-lib";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { holidayTable } from "../../src/holidays";
import { cutoffOf } from "../../src/ledger/ledger";
import { scheduleOf } from "../../src/runner/day";
import { COMPANIES } from "../../src/runner/world/companies";
import { discloseDue } from "../../src/runner/world/disclosure";
import { PgEventStore, readAllEvents } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate, type SqlDb, type SqlRunner } from "../../src/store/sql";
import { FakeClock, jst } from "../contracts/fakes";
import { openPglite, resetSchema } from "../store/pglite";

let pg: PGlite;
let db: SqlDb;
beforeAll(async () => {
  ({ pg, db } = await openPglite());
}, 60_000);
afterAll(() => db.close());

const fresh = async () => {
  await resetSchema(pg);
  await migrate(db);
};
const p = (e: LogEvent) => e.payload as Record<string, unknown>;
const holidayTables = new Map([[holidayTable.contentSha256, holidayTable]]);

/** 祝日のない5営業日（同梱の祝日の一覧で営業日） */
const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];

function world() {
  const clock = new FakeClock(jst(DAYS[0]!, 6, 50));
  const waitUntil = async (at: number) => {
    if (at > clock.now()) clock.set(at);
  };
  return { clock, waitUntil };
}
const opts = (w: ReturnType<typeof world>, over: Partial<Parameters<typeof runDaily>[1]> = {}) => ({ db, clock: w.clock, waitUntil: w.waitUntil, holidayTable, ...over });

/** 種類と、ハッシュ（乱数の salt で毎回変わる）を除いた中身の並び */
const shape = (events: readonly LogEvent[]) =>
  events.map((e) => {
    const { valuesHash: _v, outputHash: _o, bodyHash: _b, requestHash: _r, ...rest } = p(e);
    return `${e.type} ${e.actor} ${JSON.stringify(rest)}`;
  });

const accountsOf = async (events: readonly LogEvent[]) => {
  const values = await PgValueStore.open(db);
  const ledger = await replay(events, values, { holidayTables });
  const ids = [...new Set(events.filter((e) => e.type === "agent.registered").map((e) => p(e).agentId as string))].sort();
  return Object.fromEntries(ids.map((id) => [id, ledger.account(id)]));
};

/** 決算の発表（runDaily は発表しないので、引け後に別に呼ぶ。quarterDays を小さくして5日で2回目の発表を起こす） */
async function disclose(clock: FakeClock, quarterDays: number) {
  const values = await PgValueStore.open(db);
  const store = await PgEventStore.open(db, { values, holidayTables, clock });
  return discloseDue(store, WORLD_SEED, clock, COMPANIES, quarterDays);
}

async function runAll(w: ReturnType<typeof world>, o: { quarterDays?: number; twice?: boolean } = {}) {
  for (const d of DAYS) {
    await runDaily(d, opts(w));
    if (o.twice) {
      const n = (await readAllEvents(db)).length;
      await runDaily(d, opts(w));
      expect((await readAllEvents(db)).length).toBe(n);
    }
    if (o.quarterDays) await disclose(w.clock, o.quarterDays);
  }
  return readAllEvents(db);
}

describe("本番の準備のまま、架空の6社だけの世界で毎日の実行を回す", () => {
  it("同じ日を2回回しても記録が増えず、記録だけから作り直した口座が、保管を開き直した口座と一致する", async () => {
    await fresh();
    const w = world();
    const events = await runAll(w, { twice: true });
    const report = await verifyDatabase(db, holidayTable);
    expect(report.events).toBe(events.length);
    // 6社すべてに板寄せが毎日あり、外の始値・終値は取り込まない
    for (const d of DAYS) expect(events.filter((e) => e.type === "auction.cleared" && p(e).date === d).map((e) => p(e).symbol)).toEqual(COMPANIES.map((c) => c.symbol).sort());
    expect(events.filter((e) => e.type === "prices.open" || e.type === "prices.close")).toEqual([]);
    // 最後の日の引け後まで進んでいる（全員の評価と引け後の処理）
    const ids = report.agents;
    expect(ids.length).toBe(3 + COMPANIES.length + 1);
    for (const id of ids) expect(events.some((e) => e.type === "corporate_actions.applied" && p(e).agentId === id && p(e).asOf === DAYS.at(-1))).toBe(true);
    // 台帳（Ledger）を使わずに、登録の現金・最初の配分・約定の金額だけから足し引きした口座（手数料0円。この5日に配当・分割はない）が、
    // 記録だけから作り直した口座と、最後の評価の記録（保存した現金と株数）に一致し、負にならない
    expect(events.filter((e) => e.type === "corporate_action.announced")).toEqual([]);
    const replayed = await accountsOf(events);
    for (const id of ids) {
      let cash = p(events.find((e) => e.type === "agent.registered" && p(e).agentId === id)!).initialCash as number;
      const qty: Record<string, number> = {};
      for (const e of events.filter((x) => p(x).agentId === id)) {
        if (e.type === "shares.allotted") qty[p(e).symbol as string] = (qty[p(e).symbol as string] ?? 0) + (p(e).qty as number);
        if (e.type !== "fills.executed") continue;
        for (const f of p(e).fills as { symbol: string; side: string; qty: number; amount: number }[]) {
          cash += f.side === "sell" ? f.amount : -f.amount;
          qty[f.symbol] = (qty[f.symbol] ?? 0) + (f.side === "sell" ? -f.qty : f.qty);
          expect(cash, `${id} seq ${e.seq}`).toBeGreaterThanOrEqual(0);
          expect(qty[f.symbol], `${id} seq ${e.seq}`).toBeGreaterThanOrEqual(0);
        }
      }
      const held = Object.fromEntries(Object.entries(qty).filter(([, q]) => q > 0));
      expect(replayed[id]!.cash, id).toBe(cash);
      expect(Object.fromEntries(Object.entries(replayed[id]!.holdings).map(([s, h]) => [s, h.qty])), id).toEqual(held);
      const v = events.filter((e) => e.type === "valuation.recorded" && p(e).agentId === id).at(-1)!;
      expect(p(v).date).toBe(DAYS.at(-1));
      expect(p(v).cash, id).toBe(cash);
      expect(Object.fromEntries((p(v).positions as { symbol: string; qty: number }[]).map((x) => [x.symbol, x.qty])), id).toEqual(held);
    }
  }, 120_000);

  // 欠陥（宛先 platform）：scripts/daily-lib.ts の runDaily も productionSetup も discloseDue を呼ばないので、
  // 毎日の実行のコマンドだけでは、上場の日の発表（上場の前の四半期）も、20営業日ごとの発表も記録されない。
  // 大枠 #139 の通しの確認（決算の発表が1回以上ある）は、コマンドだけでは満たせない
  it.fails("毎日の実行のコマンドだけで、上場の日に、6社の上場の前の四半期を発表する", async () => {
    await fresh();
    const w = world();
    await runDaily(DAYS[0]!, opts(w));
    const events = await readAllEvents(db);
    expect(events.filter((e) => e.type === "company.disclosed").map((e) => p(e).symbol)).toEqual(COMPANIES.map((c) => c.symbol));
  }, 60_000);

  it("決算の発表は、判断の記録より前に記録された分だけが入力に入り、その時点の直近4四半期がそろう（先読みがない）", async () => {
    await fresh();
    const w = world();
    // 上場の日の発表（index 0）は、最初の runDaily のあと（判断のあと）になる。2日ごとに次の四半期を発表する
    const events = await runAll(w, { quarterDays: 2 });
    const disclosures = events.filter((e) => e.type === "company.disclosed");
    expect(disclosures.length).toBeGreaterThan(COMPANIES.length);
    const runs = events.filter((e) => e.type === "agent.run");
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      const inputs = new Set(p(run).inputSeqs as number[]);
      const used = disclosures.filter((e) => inputs.has(e.seq));
      // 入力に入った発表は、判断の記録より前に記録され、判断の日の締めより前
      const sheet = events.find((e) => e.type === "order_sheet.committed" && p(e).runSeq === run.seq);
      const date = sheet ? (p(sheet).tradingDate as string) : null;
      for (const e of used) {
        expect(e.seq).toBeLessThan(run.seq);
        expect(e.recordedAt).toBeLessThanOrEqual(p(run).startedAt as number);
        if (date) expect(e.recordedAt).toBeLessThan(cutoffOf(date));
      }
      // 判断の時点で発表済みだった分（銘柄ごとに直近4つ）が、すべて入力に入っている
      for (const c of COMPANIES) {
        const known = disclosures.filter((e) => p(e).symbol === c.symbol && e.seq < run.seq).slice(-4);
        for (const e of known) expect(inputs.has(e.seq), `run ${run.seq} misses disclosure ${e.seq}`).toBe(true);
      }
    }
    await verifyDatabase(db, holidayTable);
  }, 120_000);
});

/** n 回目の「イベントの INSERT」で落ちる DB。after が true なら、COMMIT まで通したあとで落ちる（返事が届かなかった場合） */
function crashingAt(n: number, after: boolean): { db: SqlDb; fired: () => boolean } {
  let count = 0;
  let fired = false;
  const wrap = (tx: SqlRunner, onInsert: () => void): SqlRunner => ({
    ...tx,
    query: (t, params) => {
      if (t.startsWith("INSERT INTO events")) {
        count++;
        if (count === n) onInsert();
      }
      return tx.query(t, params);
    },
  });
  const crashing: SqlDb = {
    ...db,
    transaction: async (fn) => {
      let armed = false;
      const r = await db.transaction((tx) =>
        fn(
          wrap(tx, () => {
            if (fired) return;
            fired = true;
            if (!after) throw new Error("crash before commit");
            armed = true;
          }),
        ),
      );
      if (armed) throw new Error("crash after commit");
      return r;
    },
  };
  return { db: crashing, fired: () => fired };
}

describe("途中で落ちても、回し直せば落ちなかった場合と同じ記録になる（架空の6社だけの世界）", () => {
  it("最初の2日のどの追記で落ちても（COMMIT の前・後）、回し直した記録は同じ並びで、作り直した口座も同じ", async () => {
    const days = DAYS.slice(0, 2);
    await fresh();
    const a = world();
    for (const d of days) await runDaily(d, opts(a));
    const expectedEvents = await readAllEvents(db);
    const expected = shape(expectedEvents);
    const expectedAccounts = await accountsOf(expectedEvents);
    const total = expectedEvents.length;
    // すべての位置を試すと遅いので、固定の間隔で選ぶ（最初・最後を含む）
    const points = [...new Set([1, 2, 3, ...Array.from({ length: 6 }, (_, i) => Math.ceil(((i + 1) * total) / 6))])].filter((n) => n <= total);
    for (const after of [false, true]) {
      for (const n of points) {
        await fresh();
        const b = world();
        const c = crashingAt(n, after);
        for (const d of days) {
          for (let tries = 0; ; tries++) {
            if (tries > 3) throw new Error(`no progress on ${d} (crash at insert ${n}, after commit: ${after})`);
            try {
              await runDaily(d, opts(b, { db: c.db }));
              break;
            } catch (err) {
              if (!(err instanceof Error) || !err.message.startsWith("crash")) throw new Error(`crash at insert ${n} (after commit: ${after}) on ${d}: ${String(err)}`);
            }
          }
        }
        expect(c.fired(), `insert ${n}`).toBe(true);
        const events = await readAllEvents(db);
        expect(shape(events), `crash at insert ${n}, after commit: ${after}`).toEqual(expected);
        expect(await accountsOf(events)).toEqual(expectedAccounts);
        await verifyDatabase(db, holidayTable);
      }
    }
  }, 600_000);

  it("寄り付き・引けの時刻で落ちても、回し直せば続きから進む", async () => {
    const days = DAYS.slice(0, 2);
    await fresh();
    const a = world();
    for (const d of days) await runDaily(d, opts(a));
    const expected = shape(await readAllEvents(db));
    for (const at of ["openAt", "closeAt"] as const) {
      await fresh();
      const b = world();
      for (const d of days) {
        const stop = (t: number) => (t === scheduleOf(d)[at] ? Promise.reject(new Error("crash")) : b.waitUntil(t));
        await expect(runDaily(d, opts(b, { waitUntil: stop }))).rejects.toThrow("crash");
        await runDaily(d, opts(b));
      }
      expect(shape(await readAllEvents(db)), at).toEqual(expected);
    }
  }, 120_000);
});
