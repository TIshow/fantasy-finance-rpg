// 非表示にした投稿の本文を消す手続き（#25 PR-3。db/003_erase_body.sql、EVENT_LOG §5.2・§6.1）の試験。PGlite（Docker なし）。
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyDatabase } from "../../scripts/daily-lib";
import { verifyChain } from "../../src/events/chain";
import { PgEventStore, readAllEvents } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate, type SqlDb } from "../../src/store/sql";
import { FakeClock } from "../contracts/fakes";
import { buildGoldenLog, FIXTURE_HOLIDAYS } from "../fixtures/golden";
import { openPglite, resetSchema } from "./pglite";

let pg: PGlite;
let db: SqlDb;
beforeAll(async () => {
  ({ pg, db } = await openPglite());
  await pg.exec("CREATE ROLE ffr_app");
}, 60_000);
afterAll(() => db.close());

const g = await buildGoldenLog(20261104);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const posts = g.events.filter((e) => e.type === "post.published");
const bodyOf = (seq: number) => (g.events[seq - 1]!.payload as { bodyHash: string }).bodyHash;
const has = async (hash: string) => (await db.query("SELECT 1 FROM stored_values WHERE hash = $1", [hash])).rows.length === 1;
const erase = async (seq: number) => (await db.query<{ h: string | null }>("SELECT erase_withdrawn_body($1) AS h", [seq])).rows[0]!.h;

/** ゴールデンログの行・値・本文を DB に入れ、post[0] を本文ごと非表示、post[1] を本文は残して非表示にする */
async function setUp() {
  await resetSchema(pg);
  await migrate(db);
  for (const e of g.events) {
    await db.query("INSERT INTO events (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) VALUES ($1, 1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)", [e.seq, e.type, e.recordedAt, e.actor, JSON.stringify(e.keys), JSON.stringify(e.refs), JSON.stringify(e.payload), e.prevHash, e.hash]);
  }
  const fx = g.values as unknown as { values: Map<string, { salt: Uint8Array; value: unknown }> };
  for (const [hash, { salt, value }] of fx.values) await db.query("INSERT INTO stored_values VALUES ($1, 'value', $2, $3::jsonb)", [hash, hex(salt), JSON.stringify(value)]);
  for (const [hash, { salt, value }] of g.bodies) await db.query("INSERT INTO stored_values VALUES ($1, 'body', $2, $3::jsonb)", [hash, hex(salt), JSON.stringify(value)]);
  const open = async () => PgEventStore.open(db, { values: await PgValueStore.open(db), holidayTables: g.holidayTables, clock: new FakeClock(g.events.at(-1)!.recordedAt) });
  const store = await open();
  for (const [p, bodyErased] of [[posts[0]!, true], [posts[1]!, false]] as const) {
    const r = await store.append({ type: "content.withdrawn", actor: "operator:owner", refs: [p.seq], payload: { targetSeq: p.seq, reason: "権利者からの申し出", bodyErased } });
    expect(r.ok).toBe(true);
  }
  return { open, erased: posts[0]!.seq, kept: posts[1]!.seq, untouched: posts[2]!.seq };
}

describe("erase_withdrawn_body", () => {
  it("bodyErased が真の投稿の本文と乱数だけを消し、連鎖は壊れず、保管を開き直せて照合も通る", async () => {
    const { open, erased } = await setUp();
    const before = await readAllEvents(db);
    const values = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM stored_values")).rows[0]!.n;
    expect(await erase(erased)).toBe(bodyOf(erased));
    expect(await has(bodyOf(erased))).toBe(false);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM stored_values")).rows[0]!.n).toBe(values - 1);
    // イベントは1行も変わらず、本文のハッシュはイベントに残る
    const after = await readAllEvents(db);
    expect(after).toEqual(before);
    expect(await verifyChain(after)).toEqual([]);
    // 開き直し：消えた本文は引けない（画面では非表示として扱う）。ほかの本文は残る
    const reopened = await PgValueStore.open(db);
    expect(reopened.body(bodyOf(erased))).toBeUndefined();
    for (const p of posts.slice(1)) expect(reopened.body(bodyOf(p.seq))?.value).toBe(g.bodies.get(bodyOf(p.seq))!.value);
    expect((await (await open()).last())?.hash).toBe(after.at(-1)!.hash);
    expect((await verifyDatabase(db, FIXTURE_HOLIDAYS)).lastHash).toBe(after.at(-1)!.hash);
    // 何度呼んでも同じ結果。migrate を流し直しても戻らない
    expect(await erase(erased)).toBeNull();
    await migrate(db);
    expect(await has(bodyOf(erased))).toBe(false);
  }, 60_000);

  it("bodyErased が偽・非表示の記録がない・投稿でない seq は、例外にして何も消さない", async () => {
    const { kept, untouched } = await setUp();
    await expect(erase(kept)).rejects.toThrow("may not be erased");
    await expect(erase(untouched)).rejects.toThrow("may not be erased");
    await expect(erase(1)).rejects.toThrow("is not a post.published");
    expect(await has(bodyOf(kept))).toBe(true);
    expect(await has(bodyOf(untouched))).toBe(true);
  }, 60_000);

  it("関数を通らない削除は、持ち主でも断る（消してよい本文・値・設定を自分で入れた削除を含む）", async () => {
    const { erased } = await setUp();
    const valueHash = (await db.query<{ hash: string }>("SELECT hash FROM stored_values WHERE kind = 'value' LIMIT 1")).rows[0]!.hash;
    await expect(db.query("DELETE FROM stored_values WHERE hash = $1", [bodyOf(erased)])).rejects.toThrow(/stored_values is append-only/);
    for (const h of [valueHash, bodyOf(posts[1]!.seq)]) {
      await expect(db.transaction(async (tx) => {
        await tx.query("SELECT set_config('ffr.erase_body', $1, true)", [h]);
        await tx.query("DELETE FROM stored_values WHERE hash = $1", [h]);
      })).rejects.toThrow(/stored_values is append-only/);
      expect(await has(h)).toBe(true);
    }
    await expect(pg.exec("UPDATE stored_values SET kind = 'body'")).rejects.toThrow(/stored_values is append-only/);
    await expect(pg.exec("TRUNCATE stored_values")).rejects.toThrow(/stored_values is append-only/);
  }, 60_000);

  it("アプリの役割（ffr_app）は関数を呼べず、表から削除もできない", async () => {
    const { erased } = await setUp();
    try {
      await pg.exec("SET ROLE ffr_app");
      await expect(erase(erased)).rejects.toThrow(/permission denied/);
      await expect(db.query("DELETE FROM stored_values WHERE hash = $1", [bodyOf(erased)])).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec("RESET ROLE");
    }
    expect(await has(bodyOf(erased))).toBe(true);
  }, 60_000);

  it("運営者の手順の SQL（db/ops/erase_body.sql）の確かめる文は、消してよい本文が残っている投稿だけを返す", async () => {
    const { erased } = await setUp();
    const sql = readFileSync(new URL("../../db/ops/erase_body.sql", import.meta.url), "utf8");
    const check = sql.slice(sql.indexOf("SELECT p.seq"), sql.indexOf(";", sql.indexOf("SELECT p.seq")));
    expect((await db.query<{ seq: number }>(check)).rows.map((r) => Number(r.seq))).toEqual([erased]);
    await db.query(sql.slice(sql.lastIndexOf("SELECT erase_withdrawn_body")).replace("<seq>", String(erased)));
    expect((await db.query(check)).rows).toEqual([]);
  }, 60_000);
});
