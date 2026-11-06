// Postgres の EventStore（#25 PR-1）の試験。PGlite（Postgres を Node の中で動かす）で、Docker なしで動く。
// 本物のドライバ（pg）の試験は、環境変数 TEST_DATABASE_URL があるときだけ動く（なければスキップして、その旨を出す）。
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DraftInput } from "../../src/contracts";
import { verifyChain } from "../../src/events/chain";
import type { ValueStore } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { pgDb, pgDbFromEnv } from "../../src/store/pg-db";
import { PgEventStore, checkAppendOnlyRole, type PgStoreDeps } from "../../src/store/pg-store";
import { migrate, type SqlDb } from "../../src/store/sql";
import { describeEventStoreContract, holidayTable, seedAgent } from "../contracts/conformance";
import { FakeClock, jst } from "../contracts/fakes";
import { buildGoldenLog } from "../fixtures/golden";
import { openPglite, resetSchema } from "./pglite";

const noValues: ValueStore = { get: () => undefined };
const tables = new Map([[holidayTable.contentSha256, holidayTable]]);
const source = (at: number): DraftInput => ({ type: "source.captured", actor: "system", refs: [], payload: { publishedAt: jst("2026-11-09", 15, 30), fetchedAt: at } });
const insertSql = "INSERT INTO events (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) VALUES ($1, 1, $2, $3, $4, '[]', '[]', '{}', $5, $6)";
const row = (e: LogEvent) => [e.seq, e.type, e.recordedAt, e.actor, e.prevHash, e.hash];

let pg: PGlite;
let db: SqlDb;
beforeAll(async () => {
  ({ pg, db } = await openPglite());
  await pg.exec("CREATE ROLE ffr_app"); // アプリの役割（運営者が作る前提。migrate が権限を与える）
}, 60_000);
afterAll(() => db.close());

/** 空の表を作り直して、保管を開く */
async function fresh(deps: Partial<PgStoreDeps> = {}) {
  await resetSchema(pg);
  await migrate(db);
  return PgEventStore.open(db, { values: noValues, holidayTables: tables, clock: new FakeClock(0), ...deps });
}

describeEventStoreContract("PgEventStore（PGlite）", async (env) => {
  await resetSchema(pg);
  await migrate(db);
  return PgEventStore.open(db, { values: noValues, holidayTables: env.holidayTables, clock: env.clock });
});

describe("PgEventStore の作り直しと複数の処理", async () => {
  const g = await buildGoldenLog(20261104);
  const lastAt = g.events.at(-1)!.recordedAt;

  it("ゴールデンログの行から開き、同じイベントを返す。続けて追記できる", async () => {
    await resetSchema(pg);
    await migrate(db);
    for (const e of g.events) {
      await db.query(insertSql.replace("'{}'", "$7::jsonb").replace("'[]', '[]'", "$8::jsonb, $9::jsonb"), [...row(e), JSON.stringify(e.payload), JSON.stringify(e.keys), JSON.stringify(e.refs)]);
    }
    const clock = new FakeClock(lastAt);
    const store = await PgEventStore.open(db, { values: g.values, holidayTables: g.holidayTables, clock, readMax: 7 });
    expect((await store.last())?.hash).toBe(g.events.at(-1)!.hash);
    const all: LogEvent[] = [];
    for (let page = await store.read(); page.length > 0; page = await store.read(all.at(-1)!.seq)) all.push(...page);
    expect(all).toEqual(g.events);
    expect(await verifyChain(all)).toEqual([]);
    clock.set(lastAt + 1_000);
    const r = await store.append({ type: "source.captured", actor: "system", refs: [], payload: { publishedAt: lastAt, fetchedAt: lastAt + 1_000 } });
    expect(r.ok && r.event.seq).toBe(g.events.length + 1);
  });

  it("書き換えた行や、ログの外の値がないログからは開けない", async () => {
    await resetSchema(pg);
    await migrate(db);
    for (const e of g.events) await db.query(insertSql.replace("'{}'", "$7::jsonb").replace("'[]', '[]'", "$8::jsonb, $9::jsonb"), [...row(e), JSON.stringify(e.payload), JSON.stringify(e.keys), JSON.stringify(e.refs)]);
    const clock = new FakeClock(lastAt);
    await expect(PgEventStore.open(db, { values: noValues, holidayTables: g.holidayTables, clock })).rejects.toThrow("values are not available");
    await pg.exec("ALTER TABLE events DISABLE TRIGGER USER"); // 持ち主が無理に書き換えた場合
    await pg.exec("UPDATE events SET recorded_at = recorded_at + 1 WHERE seq = 11");
    await expect(PgEventStore.open(db, { values: g.values, holidayTables: g.holidayTables, clock })).rejects.toThrow(/^seq 11 /);
  });

  it("時計が最後のイベントより前なら開かない", async () => {
    await resetSchema(pg);
    await migrate(db);
    for (const e of g.events) await db.query(insertSql.replace("'{}'", "$7::jsonb").replace("'[]', '[]'", "$8::jsonb, $9::jsonb"), [...row(e), JSON.stringify(e.payload), JSON.stringify(e.keys), JSON.stringify(e.refs)]);
    await expect(PgEventStore.open(db, { values: g.values, holidayTables: g.holidayTables, clock: new FakeClock(lastAt - 1) })).rejects.toThrow(RangeError);
  });
});

describe("PgEventStore の失敗と同時の書き込み", () => {
  it("DB への書き込みが失敗したら例外にして、次の操作は DB から作り直して続けられる", async () => {
    let failNext = false;
    const flaky: SqlDb = { ...db, transaction: (fn) => db.transaction((tx) => fn({ ...tx, query: (t, p) => (failNext && t.startsWith("INSERT") ? ((failNext = false), Promise.reject(new Error("disk full"))) : tx.query(t, p)) })) };
    await resetSchema(pg);
    await migrate(db);
    const clock = new FakeClock(0);
    const store = await PgEventStore.open(flaky, { values: noValues, holidayTables: tables, clock });
    await seedAgent(store, clock);
    clock.set(jst("2026-11-09", 23));
    failNext = true;
    await expect(store.append(source(jst("2026-11-09", 23)))).rejects.toThrow("disk full");
    expect((await store.last())?.seq).toBe(5); // 書かれていない
    const r = await store.append(source(jst("2026-11-09", 23)));
    expect(r.ok && r.event.seq).toBe(6); // 失敗した分の seq を飛ばさず、連鎖が続く
    expect(await verifyChain(await store.read())).toEqual([]);
  });

  it("同じ表を2つの保管が同時に書いても、別の処理の分に追いついて、seq と連鎖が崩れない", async () => {
    const clock = new FakeClock(0);
    const a = await fresh({ clock });
    await seedAgent(a, clock);
    const b = await PgEventStore.open(db, { values: noValues, holidayTables: tables, clock });
    clock.set(jst("2026-11-09", 23));
    const results = await Promise.all([a, b, a, b, a, b].map((s) => s.append(source(jst("2026-11-09", 23)))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => (r.ok ? r.event.seq : 0)).sort((x, y) => x - y)).toEqual([6, 7, 8, 9, 10, 11]);
    const all = await a.read();
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    expect(await verifyChain(all)).toEqual([]);
  });

  it("連鎖は続いていても検査に通らない行（ハッシュが違う）が DB にあれば、読む側も止まる", async () => {
    const clock = new FakeClock(0);
    const store = await fresh({ clock });
    await seedAgent(store, clock);
    const last = (await store.last())!;
    await db.query(insertSql, [6, "source.captured", last.recordedAt, "system", last.hash, "e".repeat(64)]);
    await expect(store.read()).rejects.toThrow(/^seq 6 /);
    await expect(store.last()).rejects.toThrow(/^seq 6 /);
  });

  it("jsonb に書けない U+0000 を含む中身は、書かずに理由を返す（例外にしない）", async () => {
    const clock = new FakeClock(0);
    const store = await fresh({ clock });
    const run = await seedAgent(store, clock);
    clock.set(jst("2026-11-10", 8));
    expect(await store.append({ ...source(clock.now()), payload: { publishedAt: 1, fetchedAt: 2, note: "a\u0000b" } })).toMatchObject({ ok: false, reason: expect.stringContaining("U+0000") });
    const order = { symbol: "TSTA\u0000", side: "buy", qty: 1, limit: 100 } as never;
    expect(await store.commitSheet("ai-a", { tradingDate: "2026-11-10", orders: [order], runSeq: run, inputSeqs: [4] })).toMatchObject({ ok: false, reason: expect.stringContaining("U+0000") });
    expect((await store.last())?.seq).toBe(5);
  });

  it("別の処理が書いたあとの追記は、その分を含めた検査にかける（二重の登録を断る）", async () => {
    const clock = new FakeClock(jst("2026-11-09", 20));
    const a = await fresh({ clock });
    const b = await PgEventStore.open(db, { values: noValues, holidayTables: tables, clock });
    await seedAgent(a, clock);
    const again: DraftInput = { type: "agent.registered", actor: "operator:owner", refs: [], payload: { agentId: "ai-a", startDate: "2026-11-10", initialCash: 10_000_000 } };
    expect((await b.append(again)).ok).toBe(false);
  });
});

describe("追記だけであること（DB が守る）", () => {
  const seeded = async () => {
    const clock = new FakeClock(0);
    const store = await fresh({ clock });
    await seedAgent(store, clock);
    return store;
  };

  it("持ち主でも、更新・削除・TRUNCATE はトリガが断る", async () => {
    await seeded();
    for (const sql of ["UPDATE events SET type = 'x' WHERE seq = 1", "DELETE FROM events WHERE seq = 1", "TRUNCATE events"]) await expect(pg.exec(sql)).rejects.toThrow(/append-only/);
    expect((await db.query("SELECT count(*)::int AS n FROM events")).rows).toEqual([{ n: 5 }]);
  });

  it("連鎖が続かない行（seq の飛び・prev_hash の違い・時刻の戻り）は、直接書いても断る", async () => {
    const store = await seeded();
    const last = (await store.last())!;
    const base = { ...last, seq: 6 };
    for (const bad of [{ ...base, seq: 7 }, { ...base, prevHash: "f".repeat(64) }, { ...base, recordedAt: last.recordedAt - 1 }, { ...base, seq: 5 }]) {
      await expect(db.query(insertSql.replace("'{}'", "$7::jsonb"), [...row(bad), "{}"])).rejects.toThrow();
    }
    expect((await store.last())?.seq).toBe(5);
  });

  it("アプリの役割（ffr_app）は、読むことと追記だけができ、更新・削除・TRUNCATE は権限で断られる", async () => {
    const store = await seeded();
    expect(await checkAppendOnlyRole(db)).toEqual(expect.arrayContaining(["the role is a superuser", "the role can UPDATE events"])); // 持ち主・スーパーユーザーは不可
    await expect(PgEventStore.open(db, { values: noValues, holidayTables: tables, clock: new FakeClock(jst("2026-11-09", 22)), requireAppendOnlyRole: true })).rejects.toThrow("not append-only");
    try {
      await pg.exec("SET ROLE ffr_app");
      expect(await checkAppendOnlyRole(db)).toEqual([]);
      // 運営者の手順に入れる確認の SQL（db/ops/check_app_role.sql）も、想定の結果を返す
      const check = (await pg.query(readFileSync(new URL("../../db/ops/check_app_role.sql", import.meta.url), "utf8"))).rows[0];
      expect(check).toEqual({ who: "ffr_app", superuser: false, write_all_data: false, can_select: true, can_insert: true, can_update: false, can_delete: false, can_truncate: false, values_can_select: true, values_can_insert: true, values_can_update: false, values_can_delete: false, values_can_truncate: false });
      expect((await store.read()).length).toBe(5);
      for (const sql of ["UPDATE events SET type = 'x'", "DELETE FROM events", "TRUNCATE events", "DROP TABLE events"]) await expect(pg.exec(sql)).rejects.toThrow(/permission denied|must be owner/);
      const clock = new FakeClock(jst("2026-11-09", 23));
      const writer = await PgEventStore.open(db, { values: noValues, holidayTables: tables, clock });
      const r = await writer.append(source(jst("2026-11-09", 23)));
      expect(r.ok && r.event.seq).toBe(6);
    } finally {
      await pg.exec("RESET ROLE");
    }
  });

  it("アプリの役割が一時テーブルで events を装っても、トリガは本物の表の末尾を見て、連鎖が続かない行を断る", async () => {
    const store = await seeded();
    const last = (await store.last())!;
    try {
      await pg.exec("SET ROLE ffr_app");
      await pg.exec("CREATE TEMP TABLE events (seq bigint, hash text, recorded_at bigint); INSERT INTO events VALUES (99, 'x', 0)");
      await expect(db.query(insertSql.replace("INTO events", "INTO public.events"), [100, "x.y", 0, "system", "f".repeat(64), "e".repeat(64)])).rejects.toThrow(/does not continue the log/);
      await pg.exec("DROP TABLE pg_temp.events");
      await expect(db.query(insertSql, [6, "source.captured", last.recordedAt - 1, "system", last.hash, "d".repeat(64)])).rejects.toThrow(/does not continue the log/);
    } finally {
      await pg.exec("RESET ROLE");
    }
    expect((await store.last())?.seq).toBe(5);
  });

  it("migrate は何度流しても同じ結果になり、中身を消さない", async () => {
    await seeded();
    await migrate(db);
    expect((await db.query("SELECT count(*)::int AS n FROM events")).rows).toEqual([{ n: 5 }]);
  });
});

describe("pgDbFromEnv", () => {
  it("DATABASE_URL がなければ、値を出さずに例外にする。schema 名は検査する", () => {
    expect(() => pgDbFromEnv({})).toThrow("DATABASE_URL is not set");
    expect(() => pgDb({ connectionString: "postgres://u:p@localhost/db", schema: "x; DROP TABLE events" })).toThrow("invalid schema name");
  });
});

// 本物のドライバ（pg）で、ローカルの Postgres につなぐ試験。壊してよい試験用のデータベースを TEST_DATABASE_URL に指定する。
// 作る schema は使い捨て（試験の終わりに消す）。DATABASE_URL（本番の接続）は使わない。
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) console.info("[skip] pg driver tests: TEST_DATABASE_URL is not set");
describe.skipIf(!testUrl)("PgEventStore（pg ドライバ・TEST_DATABASE_URL）", () => {
  const schema = `ffr_test_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
  const admin = () => pgDb({ connectionString: testUrl!, max: 1 });
  beforeAll(async () => {
    const a = admin();
    await a.exec(`CREATE SCHEMA ${schema}`);
    await a.close();
  });
  afterAll(async () => {
    const a = admin();
    await a.exec(`DROP SCHEMA ${schema} CASCADE`);
    await a.close();
  });

  it("別々の接続を持つ2つの保管が同時に書いても、advisory lock で直列になり、seq と連鎖が崩れない", async () => {
    const [d1, d2] = [pgDb({ connectionString: testUrl!, schema, max: 3 }), pgDb({ connectionString: testUrl!, schema, max: 3 })];
    try {
      await d1.exec("DROP TABLE IF EXISTS events CASCADE");
      await migrate(d1);
      const clock = new FakeClock(0);
      const a = await PgEventStore.open(d1, { values: noValues, holidayTables: tables, clock });
      await seedAgent(a, clock);
      const b = await PgEventStore.open(d2, { values: noValues, holidayTables: tables, clock });
      clock.set(jst("2026-11-09", 23));
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).append(source(jst("2026-11-09", 23)))));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.map((r) => (r.ok ? r.event.seq : 0)).sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i + 6));
      expect(await verifyChain(await a.read())).toEqual([]);
    } finally {
      await Promise.all([d1.close(), d2.close()]);
    }
  });

  describeEventStoreContract("PgEventStore（pg）", async (env) => {
    const d = pgDb({ connectionString: testUrl!, schema, max: 2 });
    env.cleanup(() => d.close());
    await d.exec(`DROP TABLE IF EXISTS events CASCADE`);
    await migrate(d);
    return PgEventStore.open(d, { values: noValues, holidayTables: env.holidayTables, clock: env.clock });
  });
});
