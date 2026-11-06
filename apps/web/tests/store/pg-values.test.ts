// ログの外の値と本文の保管（#25 PR-2）の試験。PGlite（Docker なし）。
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyHash } from "../../src/events/hash";
import { checkAppendOnlyRole, PgEventStore } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate, type SqlDb } from "../../src/store/sql";
import { FakeClock } from "../contracts/fakes";
import { buildGoldenLog } from "../fixtures/golden";
import { openPglite, resetSchema } from "./pglite";

let pg: PGlite;
let db: SqlDb;
beforeAll(async () => {
  ({ pg, db } = await openPglite());
  await pg.exec("CREATE ROLE ffr_app");
}, 60_000);
afterAll(() => db.close());

/** 空の表を作り直す。salt は呼ぶたびに変わる決まった並び */
async function fresh() {
  await resetSchema(pg);
  await migrate(db);
  let n = 0;
  return PgValueStore.open(db, () => Uint8Array.from({ length: 16 }, (_, i) => (i + ++n) % 256));
}
const count = async () => (await db.query("SELECT count(*)::int AS n FROM stored_values")).rows;

describe("PgValueStore", () => {
  it("置いた値と本文は、ハッシュで引けて、開き直しても同じ。ハッシュは salt つきの SHA-256", async () => {
    const store = await fresh();
    const v = await store.putValue({ NEO1: 10_000, NEO2: null, nested: [1, { a: "あ" }] });
    const b = await store.putBody("今日は静かな相場だった");
    expect(store.get(v)?.value).toEqual({ NEO1: 10_000, NEO2: null, nested: [1, { a: "あ" }] });
    expect(store.body(b)?.value).toBe("今日は静かな相場だった");
    expect(await bodyHash(store.get(v)!.salt, { value: store.get(v)!.value })).toBe(v);
    expect(store.get(b)).toBeUndefined(); // 本文は値の口からは引けない
    const reopened = await PgValueStore.open(db);
    expect(reopened.get(v)).toEqual(store.get(v));
    expect(reopened.body(b)).toEqual(store.body(b));
  });

  it("同じハッシュを二重に置いても何も起きない。別の処理が置いた分は refresh で見える", async () => {
    await resetSchema(pg);
    await migrate(db);
    const fixed = () => new Uint8Array(16).fill(7);
    const a = await PgValueStore.open(db, fixed);
    const b = await PgValueStore.open(db, fixed);
    const h = await a.putValue({ x: 1 });
    expect(await b.putValue({ x: 1 })).toBe(h);
    expect(await count()).toEqual([{ n: 1 }]);
    const c = await PgValueStore.open(db);
    const later = await a.putBody("later");
    expect(c.body(later)).toBeUndefined();
    await c.refresh();
    expect(c.body(later)?.value).toBe("later");
  });

  it("U+0000 や JSON にできない値は、書かずに例外にする", async () => {
    const store = await fresh();
    await expect(store.putBody("a\u0000b")).rejects.toThrow("U+0000");
    await expect(store.putValue({ "k\u0000": 1 })).rejects.toThrow("U+0000");
    await expect(store.putValue(undefined)).rejects.toThrow();
    await expect(store.putValue({ n: 1.5 })).rejects.toThrow();
    expect(await count()).toEqual([{ n: 0 }]);
  });

  it("書き換えられた行（持ち主が無理にトリガを外した場合）は、開くときのハッシュの照合で止まる", async () => {
    const store = await fresh();
    const h = await store.putValue({ NEO1: 10_000 });
    await store.putBody("本文");
    await pg.exec("ALTER TABLE stored_values DISABLE TRIGGER USER");
    await db.query("UPDATE stored_values SET content = $1::jsonb WHERE hash = $2", [JSON.stringify({ NEO1: 99_999 }), h]);
    await expect(PgValueStore.open(db)).rejects.toThrow(`stored value ${h} does not match its hash`);
  });
});

describe("stored_values は追記だけ", () => {
  it("持ち主でも、更新・削除・TRUNCATE はトリガが断る。形の違う行は制約が断る", async () => {
    const store = await fresh();
    await store.putValue({ a: 1 });
    for (const sql of ["UPDATE stored_values SET kind = 'body'", "DELETE FROM stored_values", "TRUNCATE stored_values"]) await expect(pg.exec(sql)).rejects.toThrow(/stored_values is append-only/);
    await expect(db.query("INSERT INTO stored_values VALUES ($1, 'body', $2, '{}'::jsonb)", ["a".repeat(64), "b".repeat(32)])).rejects.toThrow(); // body は文字列だけ
    await expect(db.query("INSERT INTO stored_values VALUES ($1, 'value', $2, '1'::jsonb)", ["A".repeat(64), "b".repeat(32)])).rejects.toThrow(); // ハッシュは小文字の16進
    expect(await count()).toEqual([{ n: 1 }]);
  });

  it("アプリの役割（ffr_app）は、読むことと足すことだけができ、権限の確認も通る", async () => {
    await fresh();
    try {
      await pg.exec("SET ROLE ffr_app");
      expect(await checkAppendOnlyRole(db)).toEqual([]);
      const store = await PgValueStore.open(db);
      const h = await store.putValue({ a: 1 });
      expect(store.get(h)).toBeDefined();
      for (const sql of ["UPDATE stored_values SET kind = 'body'", "DELETE FROM stored_values", "TRUNCATE stored_values"]) await expect(pg.exec(sql)).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec("RESET ROLE");
    }
  });

  it("migrate を続けて流しても同じ結果になる", async () => {
    const store = await fresh();
    await store.putBody("残る");
    await migrate(db);
    expect(await count()).toEqual([{ n: 1 }]);
  });
});

describe("データベースだけから台帳を作り直せる", async () => {
  const g = await buildGoldenLog(20261104);
  const fx = g.values as unknown as { values: Map<string, { salt: Uint8Array; value: unknown }> };
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

  it("ゴールデンログの行と値を DB に入れて開き直すと、同じ最後のハッシュと本文になる", async () => {
    await resetSchema(pg);
    await migrate(db);
    for (const e of g.events) {
      await db.query("INSERT INTO events (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) VALUES ($1, 1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)", [e.seq, e.type, e.recordedAt, e.actor, JSON.stringify(e.keys), JSON.stringify(e.refs), JSON.stringify(e.payload), e.prevHash, e.hash]);
    }
    for (const [hash, { salt, value }] of fx.values) await db.query("INSERT INTO stored_values VALUES ($1, 'value', $2, $3::jsonb)", [hash, hex(salt), JSON.stringify(value)]);
    for (const [hash, { salt, value }] of g.bodies) await db.query("INSERT INTO stored_values VALUES ($1, 'body', $2, $3::jsonb)", [hash, hex(salt), JSON.stringify(value)]);

    const values = await PgValueStore.open(db);
    const store = await PgEventStore.open(db, { values, holidayTables: g.holidayTables, clock: new FakeClock(g.events.at(-1)!.recordedAt) });
    expect((await store.last())?.hash).toBe(g.events.at(-1)!.hash);
    for (const [hash, { value }] of g.bodies) expect(values.body(hash)?.value).toBe(value);
  });
});
