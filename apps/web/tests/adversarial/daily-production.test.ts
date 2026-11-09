// 検証（verifier、#139）：毎日の実行のコマンドの本体（scripts/daily-lib.ts の runDaily）を、本番の準備（productionSetup：
// 架空の6社の上場・取引対象・売買役とAI投資家の登録と最初の配分）のまま、PGlite（Node の中で動く Postgres）に対して回す。
// 実装の試験（tests/store/daily.test.ts）は、外の銘柄の世界で通しを確かめているので、ここでは架空の6社だけの世界を確かめる。
// 確かめること：
// - 同じ日を2回回しても記録が増えない。台帳を使わずに足し引きした口座が、記録だけから作り直した口座（replay）と、評価の記録に一致する
// - 途中で落ちても（DB への追記の失敗・COMMIT の返事が届かない）、回し直せば、落ちなかった場合と同じ並びの記録になる
// - 判断の入力に、判断の時点で発表済みの決算が、銘柄ごとに直近4四半期だけ入る。発表は、板寄せの日がたまった日の15:30より後
// （締めのあとに発表され、そのあと同じ日の判断が記録される状態は、判断が締めより前にしか動かないので作れない。
//  そのため、runner の「締めより前に記録した発表だけ」という条件そのものは、この試験では効いていない）
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDaily, verifyDatabase, WORLD_SEED } from "../../scripts/daily-lib";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { holidayTable } from "../../src/holidays";
import { cutoffOf, nextTradingDay } from "../../src/ledger/ledger";
import { scheduleOf } from "../../src/runner/day";
import { COMPANIES } from "../../src/runner/world/companies";
import { discloseDue, periodOf } from "../../src/runner/world/disclosure";
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

/**
 * 種類と中身の並び。ログの外の値を指すハッシュ（乱数の salt で毎回変わる）は、そのハッシュで引いた中身に置き換える
 * （引けなければ「missing」）。requestHash は salt を使わないので、そのまま比べる
 */
const shape = async (events: readonly LogEvent[]) => {
  const values = await PgValueStore.open(db);
  return events.map((e) => {
    const { valuesHash, outputHash, bodyHash, ...rest } = p(e);
    const looked = {
      ...rest,
      ...(valuesHash === undefined ? {} : { values: values.get(valuesHash as string)?.value ?? "missing" }),
      ...(outputHash === undefined ? {} : { output: values.body(outputHash as string)?.value ?? "missing" }),
      ...(bodyHash === undefined ? {} : { body: values.body(bodyHash as string)?.value ?? "missing" }),
    };
    return `${e.type} ${e.actor} ${JSON.stringify(looked)}`;
  });
};

const accountsOf = async (events: readonly LogEvent[]) => {
  const values = await PgValueStore.open(db);
  const ledger = await replay(events, values, { holidayTables });
  const ids = [...new Set(events.filter((e) => e.type === "agent.registered").map((e) => p(e).agentId as string))].sort();
  return Object.fromEntries(ids.map((id) => [id, ledger.account(id)]));
};

/**
 * 決算の発表を、引け後に別に呼ぶ。runDaily も発表する（#143。1四半期は板寄せの20日なので、5日では上場の日の分だけ）。
 * ここでは quarterDays を小さくして、5日で何度も発表を起こす（四半期の呼び名が同じなら二重には書かない）
 */
async function disclose(clock: FakeClock, quarterDays: number) {
  const values = await PgValueStore.open(db);
  const store = await PgEventStore.open(db, { values, holidayTables, clock });
  return discloseDue(store, WORLD_SEED, clock, COMPANIES, quarterDays);
}

async function runAll(w: ReturnType<typeof world>, o: { quarterDays?: number; twice?: boolean } = {}) {
  for (const d of DAYS) {
    await runDaily(d, opts(w));
    if (o.twice) {
      // 2回目は引けのあとに始まるので、次の取引日の判断だけを書く（#228。夜の実行と同じ）。3回目は何も書かない
      const n = (await readAllEvents(db)).length;
      await runDaily(d, opts(w));
      const extra = (await readAllEvents(db)).slice(n);
      const next = nextTradingDay(d, new Set());
      expect([...new Set(extra.map((e) => e.type))].filter((t) => t !== "agent.run" && t !== "order_sheet.committed" && t !== "post.published"), d).toEqual([]);
      for (const e of extra.filter((x) => x.type === "order_sheet.committed")) expect(p(e).tradingDate, d).toBe(next);
      const m = n + extra.length;
      await runDaily(d, opts(w));
      expect((await readAllEvents(db)).length, d).toBe(m);
    }
    if (o.quarterDays) await disclose(w.clock, o.quarterDays);
  }
  return readAllEvents(db);
}

describe("本番の準備のまま、架空の6社だけの世界で毎日の実行を回す", () => {
  it("同じ日を2回回しても記録が増えず、台帳を使わずに足し引きした口座が、記録だけから作り直した口座と、最後の評価の記録に一致する", async () => {
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
    const allFills = events.filter((e) => e.type === "fills.executed").flatMap((e) => p(e).fills as { side: string; qty: number }[]).filter((f) => f.qty > 0);
    expect(allFills.length).toBeGreaterThan(20);
    expect(allFills.some((f) => f.side === "buy")).toBe(true);
    expect(allFills.some((f) => f.side === "sell")).toBe(true);
    const replayed = await accountsOf(events);
    for (const id of ids) {
      let cash = p(events.find((e) => e.type === "agent.registered" && p(e).agentId === id)!).initialCash as number;
      const qty: Record<string, number> = {};
      for (const e of events.filter((x) => p(x).agentId === id)) {
        if (e.type === "shares.allotted") qty[p(e).symbol as string] = (qty[p(e).symbol as string] ?? 0) + (p(e).qty as number);
        if (e.type !== "fills.executed") continue;
        // 同じ記録の中では、売りの代金を先に足してから買いを引く（板寄せは1回で約定するので、記録の中の並びに頼らない）。
        // 株数は、売りを先に引いて、その記録の前の持ち株を超えて売っていないことを確かめる
        const fills = p(e).fills as { symbol: string; side: string; qty: number; amount: number }[];
        for (const f of fills.filter((x) => x.side === "sell")) {
          cash += f.amount;
          qty[f.symbol] = (qty[f.symbol] ?? 0) - f.qty;
          expect(qty[f.symbol], `${id} seq ${e.seq}`).toBeGreaterThanOrEqual(0);
        }
        for (const f of fills.filter((x) => x.side === "buy")) {
          cash -= f.amount;
          qty[f.symbol] = (qty[f.symbol] ?? 0) + f.qty;
        }
        expect(cash, `${id} seq ${e.seq}`).toBeGreaterThanOrEqual(0);
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

  // 直った（#143）：以前は、runDaily も productionSetup も discloseDue を呼ばず、毎日の実行のコマンドだけでは決算の発表が
  // 記録されなかった（verifier が #139 で報告）
  it("毎日の実行のコマンドだけで、上場の日に、6社の上場の前の四半期を発表する", async () => {
    await fresh();
    const w = world();
    await runDaily(DAYS[0]!, opts(w));
    const events = await readAllEvents(db);
    const listedAt = events.find((e) => e.type === "company.listed")!.recordedAt;
    const got = events.filter((e) => e.type === "company.disclosed").map((e) => `${String(p(e).symbol)}:${String(p(e).period)}`).sort();
    // 各銘柄に1件ずつ、上場の前の四半期（index 0）
    expect(got).toEqual(COMPANIES.map((c) => `${c.symbol}:${periodOf(listedAt, 0)}`).sort());
  }, 60_000);

  // 15:30 より前には発表しない、という判定そのもの（時計を15:30の前後に置いて確かめる）は tests/runner/world/market.test.ts が確かめる。
  // ここでは、毎日の実行の流れの中で記録された発表の時刻が、その条件に合っていることだけを確かめる
  it("判断の入力には、判断の時点で発表済みの決算が、銘柄ごとに直近4四半期だけ入る。発表は、板寄せの日がたまった日の15:30より後", async () => {
    await fresh();
    const w = world();
    // 1四半期を板寄せの1日にする。上場の日の分（index 0）と、毎日1つずつで、5日で銘柄ごとに6件の発表になる
    const quarterDays = 1;
    const events = await runAll(w, { quarterDays });
    const disclosures = events.filter((e) => e.type === "company.disclosed");
    const listedAt = events.find((e) => e.type === "company.listed")!.recordedAt;
    for (const c of COMPANIES) {
      const mine = disclosures.filter((e) => p(e).symbol === c.symbol);
      expect(mine.length, c.symbol).toBe(6);
      // index k（k ≥ 1）の発表は、その銘柄の k × quarterDays 日目の板寄せの日の15:30以後に記録される
      const auctions = events.filter((e) => e.type === "auction.cleared" && p(e).symbol === c.symbol).map((e) => p(e).date as string);
      for (const e of mine) {
        const k = Array.from({ length: 64 }, (_, i) => i).find((i) => periodOf(listedAt, i) === p(e).period);
        expect(k, `${c.symbol} ${String(p(e).period)}`).toBeDefined();
        if (k! === 0) continue;
        const day = auctions[k! * quarterDays - 1];
        expect(day, `${c.symbol} index ${k}`).toBeDefined();
        expect(e.recordedAt, `${c.symbol} index ${k}`).toBeGreaterThanOrEqual(cutoffOf(day!) + 7 * 3_600_000);
      }
    }
    const runs = events.filter((e) => e.type === "agent.run");
    expect(runs.length).toBeGreaterThan(0);
    let sawFour = false;
    for (const run of runs) {
      const inputs = new Set(p(run).inputSeqs as number[]);
      for (const c of COMPANIES) {
        // 判断の記録より前に記録された発表のうち、直近4件だけが入力に入る（それより古い発表は入らない）
        const before = disclosures.filter((e) => p(e).symbol === c.symbol && e.seq < run.seq);
        const used = disclosures.filter((e) => p(e).symbol === c.symbol && inputs.has(e.seq));
        expect(used.map((e) => e.seq), `run ${run.seq} ${c.symbol}`).toEqual(before.slice(-4).map((e) => e.seq));
        if (before.length > 4) sawFour = true;
        for (const e of used) expect(e.recordedAt).toBeLessThanOrEqual(p(run).startedAt as number);
      }
    }
    // 5件以上が発表済みの時点の判断があり、4件に絞る動きを確かめた
    expect(sawFour).toBe(true);
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
  it("最初の2日のうち、選んだ位置の追記で落ちても（COMMIT の前・後）、回し直した記録は同じ並びで、作り直した口座も同じ", async () => {
    const days = DAYS.slice(0, 2);
    await fresh();
    const a = world();
    for (const d of days) await runDaily(d, opts(a));
    // 落ちて回し直した実行は、引けのあとに始まると次の取引日の判断も書く（#228）。そろえるため、最後の日をもう一度回す
    await runDaily(days.at(-1)!, opts(a));
    const expectedEvents = await readAllEvents(db);
    const expected = await shape(expectedEvents);
    // ハッシュで引いた中身がそろっている（引けずに両方とも「missing」で一致する、ということがない）
    expect(expected.filter((x) => x.includes('"missing"'))).toEqual([]);
    expect(expected.filter((x) => x.includes('"output":')).length).toBeGreaterThan(0);
    const expectedAccounts = await accountsOf(expectedEvents);
    const total = expectedEvents.length;
    // すべての位置を試すと遅いので、固定の間隔で選ぶ（最初・最後を含む）
    const points = [...new Set([1, 2, 3, ...Array.from({ length: 6 }, (_, i) => Math.ceil(((i + 1) * total) / 6))])].filter((n) => n <= total);
    for (const after of [false, true]) {
      for (const n of points) {
        await fresh();
        const b = world();
        const c = crashingAt(n, after);
        for (const d of [...days, days.at(-1)!]) {
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
        expect(await shape(events), `crash at insert ${n}, after commit: ${after}`).toEqual(expected);
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
    const expected = await shape(await readAllEvents(db));
    for (const at of ["openAt", "closeAt"] as const) {
      await fresh();
      const b = world();
      for (const d of days) {
        const stop = (t: number) => (t === scheduleOf(d)[at] ? Promise.reject(new Error("crash")) : b.waitUntil(t));
        await expect(runDaily(d, opts(b, { waitUntil: stop }))).rejects.toThrow("crash");
        await runDaily(d, opts(b));
      }
      expect(await shape(await readAllEvents(db)), at).toEqual(expected);
    }
  }, 120_000);
});
