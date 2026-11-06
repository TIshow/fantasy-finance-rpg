// 検証役（大枠 #139：#30 の毎日の実行のコマンド・#113 PR-3b・#138 の確認）。本番の準備（productionSetup）で、
// PGlite（試験用の Postgres）の保管に対して runDaily を回し、記録・照合・二重の記録の穴を突く。
// 成り立つはずのこと（#30・#113 の lead コメント、PAPER_TRADING_RULES §1、MARKET_DESIGN §5）：
// (1) 同じ日を何度回しても、あとから前の日を回し直しても、休日に回しても、記録は増えない
// (2) GitHub Actions の形（待たずに 06:50・07:20・09:35・16:35 に回す）でも、待つ形で回したのと同じ台帳になる
// (3) 評価（valuation.recorded）と引け後の処理は、その日の 15:30 より後に書く
// (4) 毎日の実行は、上場の日に上場の前の四半期の決算を発表する（「引けのあとの評価と決算の発表」まで進める）
// (5) verify（verifyDatabase）は、連鎖のハッシュを作り直した改ざん（数字の書き換え・1件の抜き取り）も、
//     ログの外の値の書き換えも見逃さない
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventHash } from "../../src/events/hash";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { holidayTable } from "../../src/holidays";
import { cutoffOf } from "../../src/ledger/ledger";
import { readAllEvents } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate, type SqlDb } from "../../src/store/sql";
import { productionSetup, runDaily, verifyDatabase } from "../../scripts/daily-lib";
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
const HOUR = 3_600_000;
/** 3営業日（11/9〜11/11。祝日なし） */
const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11"];
const holidayTables = new Map([[holidayTable.contentSha256, holidayTable]]);

/** 待つ形：1日1回、決まった時刻まで時計を進めながら回す（--wait） */
async function runWaiting(days: readonly string[]) {
  const clock = new FakeClock(jst(days[0]!, 6, 50));
  const waitUntil = async (at: number) => void (at > clock.now() && clock.set(at));
  for (const d of days) {
    if (clock.now() < jst(d, 6, 50)) clock.set(jst(d, 6, 50));
    await runDaily(d, { db, clock, prepare: productionSetup, holidayTable, waitUntil });
  }
  return clock;
}

/** GitHub Actions の形：待たずに、決まった時刻に何度も回す（#30 の platform コメントの時刻） */
async function runLikeActions(days: readonly string[], afterEach?: () => Promise<void>) {
  const clock = new FakeClock(jst(days[0]!, 6, 50));
  for (const d of days) {
    for (const [hh, mm] of [[6, 50], [7, 20], [9, 35], [16, 35]] as const) {
      clock.set(Math.max(clock.now(), jst(d, hh, mm)));
      await runDaily(d, { db, clock, prepare: productionSetup, holidayTable });
      await afterEach?.();
    }
  }
  return clock;
}

const accountsOf = async (events: readonly LogEvent[]) => {
  const ledger = await replay(events, await PgValueStore.open(db), { holidayTables });
  const ids = events.filter((e) => e.type === "agent.registered").map((e) => p(e).agentId as string);
  return Object.fromEntries(ids.map((id) => [id, ledger.account(id)]));
};

describe("毎日の実行のコマンドを、本番の準備で3営業日回す（PGlite）", () => {
  it("同じ日を2回・前の日をあとから・休日に回しても、記録は1件も増えない", async () => {
    await fresh();
    const clock = await runWaiting(DAYS);
    const before = await readAllEvents(db);
    for (const d of [...DAYS, ...DAYS.slice().reverse(), "2026-11-14", "2026-11-15"]) await runDaily(d, { db, clock, prepare: productionSetup, holidayTable });
    clock.set(jst("2026-11-11", 23));
    for (const d of DAYS) await runDaily(d, { db, clock, prepare: productionSetup, holidayTable });
    expect(await readAllEvents(db)).toEqual(before);
    // 1日の記録の形：参加者10者 × 3日の注文票・約定・評価・引け後、6社 × 3日の板寄せ
    const n = (t: LogEvent["type"]) => before.filter((e) => e.type === t).length;
    expect([n("order_sheet.committed"), n("fills.executed"), n("valuation.recorded"), n("corporate_actions.applied"), n("auction.cleared")]).toEqual([30, 30, 30, 30, 18]);
    expect([n("company.listed"), n("universe.set"), n("holidays.adopted"), n("agent.registered")]).toEqual([6, 1, 1, 10]);
    await verifyDatabase(db, holidayTable);
  }, 120_000);

  it("GitHub Actions の形（待たずに1日4回）で回しても、毎回の照合が通り、待つ形と同じ口座になる", async () => {
    await fresh();
    await runWaiting(DAYS);
    const waited = await accountsOf(await readAllEvents(db));
    await fresh();
    await runLikeActions(DAYS, async () => void (await verifyDatabase(db, holidayTable)));
    expect(await accountsOf(await readAllEvents(db))).toEqual(waited);
  }, 180_000);

  // 欠陥（宛先：platform、src/runner/day.ts の afterClose）：取引対象が架空の6社だけのとき、引け後の処理は終値を待たない。
  // そのため、09:35 の実行（Actions の寄り付きの回）が、その日の評価と引け後の処理を 09:35 に書く。
  // PAPER_TRADING_RULES §1 は、評価を 15:30 以降とする。引け後の処理を済ませたあとは、翌日が権利落ち日の公表も書けない（EVENT_LOG §2）
  it.fails("Actions の形で回しても、評価と引け後の処理は、その日の 15:30 より前には書かない", async () => {
    await fresh();
    await runLikeActions(DAYS.slice(0, 1));
    const events = await readAllEvents(db);
    const early = events.filter((e) => (e.type === "valuation.recorded" || e.type === "corporate_actions.applied") && e.recordedAt < cutoffOf((p(e).date ?? p(e).asOf) as string) + 7 * HOUR);
    expect(early.map((e) => `${e.type} ${String(p(e).agentId)} ${new Date(e.recordedAt).toISOString()}`)).toEqual([]);
  }, 120_000);

  // 欠陥（宛先：platform、scripts/daily-lib.ts）：runDaily と productionSetup は discloseDue を呼ばない。
  // 毎日の実行のコマンドだけで動かすと、決算の発表（company.disclosed）が1件も書かれず、マーケットメイカーはずっと上場の価格で注文する。
  // #30 の lead の指示は「判断 → 締め切り → 板寄せ → 約定 → 引けのあとの評価と決算の発表」、#139 の通しの確認は「決算の発表が1回以上」
  it.fails("毎日の実行のコマンドは、上場の日に6社の上場の前の四半期の決算を発表する", async () => {
    await fresh();
    await runWaiting(DAYS.slice(0, 1));
    const disclosed = (await readAllEvents(db)).filter((e) => e.type === "company.disclosed");
    expect(disclosed.length).toBe(6);
  }, 120_000);
});

/** 書き換えた記録を、連鎖のハッシュを先頭から作り直して DB に入れ直す（表の持ち主がトリガを外した場合） */
async function forge(events: readonly LogEvent[]): Promise<void> {
  const out: LogEvent[] = [];
  for (const [i, e] of events.entries()) {
    const { hash: _, ...rest } = { ...e, seq: i + 1, prevHash: i === 0 ? "0".repeat(64) : out[i - 1]!.hash };
    out.push({ ...rest, hash: await eventHash(rest) });
  }
  await pg.exec("ALTER TABLE events DISABLE TRIGGER USER; DELETE FROM events;");
  for (const e of out) {
    await pg.query("INSERT INTO events (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)", [
      e.seq, e.schema, e.type, e.recordedAt, e.actor, JSON.stringify(e.keys), JSON.stringify(e.refs), JSON.stringify(e.payload), e.prevHash, e.hash,
    ]);
  }
  await pg.exec("ALTER TABLE events ENABLE TRIGGER USER;");
}

/**
 * 抜いたあと、refs と payload の中の seq（名前が Seq・Seqs で終わる項目）を、新しい番号に付け替える。
 * 抜いた先を指す数は、並びからは捨て、1つの値ならその直前の記録を指させる
 */
function drop(events: readonly LogEvent[], pick: (e: LogEvent) => boolean): LogEvent[] {
  const kept = events.filter((e) => !pick(e));
  expect(kept.length).toBe(events.length - 1);
  const to = new Map(kept.map((e, i) => [e.seq, i + 1]));
  const one = (v: number) => to.get(v) ?? kept.filter((e) => e.seq < v).length;
  const seqs = (v: unknown): unknown => (Array.isArray(v) ? v.flatMap((x) => (typeof x === "number" ? (to.has(x) ? [to.get(x)] : []) : [walk(x)])) : typeof v === "number" ? one(v) : walk(v));
  const walk = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(walk) : typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /Seqs?$/.test(k) ? seqs(x) : walk(x)])) : v;
  return kept.map((e) => ({ ...e, refs: seqs(e.refs) as number[], payload: walk(e.payload) as LogEvent["payload"] }));
}

describe("verify：連鎖を作り直した改ざんも見逃さない（PGlite）", () => {
  let original: LogEvent[] = [];
  const edit = (pick: (e: LogEvent) => boolean, change: (payload: Record<string, unknown>) => void) =>
    original.map((e) => {
      if (!pick(e)) return e;
      const payload = structuredClone(e.payload) as Record<string, unknown>;
      change(payload);
      return { ...e, payload };
    });

  beforeAll(async () => {
    await fresh();
    await runWaiting(DAYS);
    original = await readAllEvents(db);
    // 作り直しの手順そのものが正しいこと：変えずに作り直せば、照合は通る
    await forge(original);
    await verifyDatabase(db, holidayTable);
  }, 120_000);

  const lastDay = DAYS.at(-1)!;
  const cases: [string, () => LogEvent[]][] = [
    ["評価の合計を10（1円）増やす", () => edit((e) => e.type === "valuation.recorded" && p(e).agentId === "ai-hold" && p(e).date === lastDay, (x) => void ((x.total as number) += 10))],
    ["評価の現金を10増やす", () => edit((e) => e.type === "valuation.recorded" && p(e).agentId === "noise" && p(e).date === DAYS[0], (x) => void ((x.cash as number) += 10))],
    ["板寄せの価格を1段ずらす", () => edit((e) => e.type === "auction.cleared" && p(e).price !== null && p(e).date === DAYS[1], (x) => void ((x.price as number) += 10))],
    ["約定の株数を100増やす", () => edit((e) => e.type === "fills.executed" && (p(e).fills as { qty: number }[]).some((f) => f.qty > 0), (x) => void ((x.fills as { qty: number }[]).find((f) => f.qty > 0)!.qty += 100))],
    ["最初の配分の株数を変える", () => edit((e) => e.type === "shares.allotted" && p(e).agentId === "noise", (x) => void ((x.qty as number) += 1))],
    ["引け後の処理を1件抜き、番号と参照をすべて詰め直す", () => drop(original, (e) => e.type === "corporate_actions.applied" && p(e).agentId === "ai-ma5" && p(e).asOf === DAYS[0])],
    ["板寄せの結果を1件抜き、番号と参照をすべて詰め直す", () => drop(original, (e) => e === original.find((x) => x.type === "auction.cleared" && p(x).date === DAYS[1]))],
    ["ある日の約定を1件抜き、番号と参照をすべて詰め直す", () => drop(original, (e) => e.type === "fills.executed" && p(e).agentId === "ai-hold" && p(e).tradingDate === DAYS[1])],
  ];
  for (const [name, make] of cases) {
    it(`${name}と、照合が止まる`, async () => {
      try {
        await forge(make());
        await expect(verifyDatabase(db, holidayTable)).rejects.toThrow();
      } finally {
        await forge(original);
      }
    }, 60_000);
  }

  it("ログの外に置いた判断の出力は、トリガを外しても表の制約が書き換えを断り、制約まで外して書き換えると照合が止まる", async () => {
    const run = original.find((e) => e.type === "agent.run" && p(e).ok === true)!;
    const tamper = () => pg.query("UPDATE stored_values SET content = to_jsonb($1::text) WHERE hash = $2", ['{"orders":[],"post":null,"note":"forged"}', p(run).outputHash]);
    await pg.exec("ALTER TABLE stored_values DISABLE TRIGGER USER;");
    try {
      await expect(tamper()).rejects.toThrow("check constraint");
      await pg.exec("ALTER TABLE stored_values DROP CONSTRAINT stored_values_check1;");
      await tamper();
      await expect(verifyDatabase(db, holidayTable)).rejects.toThrow("does not match its hash");
    } finally {
      await fresh();
      await runWaiting(DAYS);
      original = await readAllEvents(db);
    }
  }, 120_000);

  // 限界（指摘：低。宛先：lead）：末尾を消した記録や、何からも参照されない投稿を抜いて連鎖を作り直した記録は、連鎖も台帳も
  // 正しいので照合が通る。気づけるのは、前に外へ控えた最後のハッシュ・件数と比べたときだけ（verify は控えを受け取らない）
  for (const [name, make] of [
    ["末尾の1日分を消す", () => original.slice(0, original.findIndex((e) => e.type === "agent.run" && e.recordedAt >= jst(lastDay, 0)))],
    ["AIの投稿を1件抜き、番号と参照をすべて詰め直す", () => drop(original, (e) => e === original.find((x) => x.type === "post.published"))],
  ] as const) {
    it(`${name}と、照合は通ってしまう。verify が返す最後のハッシュは控えと食い違う`, async () => {
      const report = await verifyDatabase(db, holidayTable);
      try {
        await forge(make());
        const after = await verifyDatabase(db, holidayTable);
        expect(after.events).toBeLessThan(report.events);
        expect(after.lastHash).not.toBe(report.lastHash);
      } finally {
        await forge(original);
      }
    }, 60_000);
  }
});
