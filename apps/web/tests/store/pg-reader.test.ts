// 読むだけの口（src/store/pg-reader.ts。#106）の試験：本番と同じ入口（productionSetup・runDaily）で PGlite に数日分を書き、
// 読むだけの口で読んだ最後のハッシュと口座が、書いた側の台帳（保管と同じ InMemoryEventStore）と一致すること、
// SELECT だけの役割でも読めて、書く文・鍵を流さないこと、行が書き換えられていれば例外にすること、接続文字列を漏らさないことを確かめる。
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { holidayTable } from "../../src/holidays";
import { InMemoryEventStore } from "../../src/store/memory-store";
import { readSnapshot, readSnapshotFromEnv, readSnapshotWith } from "../../src/store/pg-reader";
import { readAllEvents } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate, type SqlDb, type SqlRunner } from "../../src/store/sql";
import { productionSetup, runDaily } from "../../scripts/daily-lib";
import { FakeClock, jst } from "../contracts/fakes";
import { openPglite, resetSchema } from "./pglite";

let pg: PGlite;
let db: SqlDb;
/** 2026-11-09（月）から3営業日を回す */
const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11"];

async function writeDays() {
  await resetSchema(pg);
  await migrate(db);
  const clock = new FakeClock(jst(DAYS[0]!, 7));
  const waitUntil = async (at: number) => void (at > clock.now() && clock.set(at));
  for (const d of DAYS) await runDaily(d, { db, clock, prepare: productionSetup, holidayTable, waitUntil });
  return clock;
}

beforeAll(async () => {
  ({ pg, db } = await openPglite());
}, 60_000);
afterAll(() => db.close());

/** 流した文をすべて残す DB。鍵を取ろうとしたら記録する */
function recording(): { db: SqlDb; log: string[] } {
  const log: string[] = [];
  const wrap = (r: SqlRunner): SqlRunner => ({
    query: (t, p) => (log.push(t), r.query(t, p)),
    exec: (t) => (log.push(t), r.exec(t)),
  });
  return {
    log,
    db: { ...db, ...wrap(db), transaction: (fn) => (log.push("BEGIN"), db.transaction((tx) => fn(wrap(tx)))), lock: async (k) => (log.push(`lock ${k}`), null) },
  };
}

// 数日分を書くので、混んだ機械でも既定の5秒で切れないようにする
describe("readSnapshot", { timeout: 60_000 }, () => {
  it("最後のハッシュと口座が、書いた側の台帳と一致し、返す値は凍結されている", async () => {
    const clock = await writeDays();
    const snap = await readSnapshot(db, { warn: () => undefined });

    const events = await readAllEvents(db);
    const writer = await InMemoryEventStore.fromEvents(events, await PgValueStore.open(db), new Map([[holidayTable.contentSha256, holidayTable]]), clock);
    expect(snap.events.length).toBe(events.length);
    expect(snap.lastHash).toBe((await writer.last())!.hash);
    expect(snap.events.at(-1)!.hash).toBe(snap.lastHash);

    const registered = events.filter((e) => e.type === "agent.registered").map((e) => (e.payload as { agentId: string }).agentId);
    expect([...snap.accounts.keys()]).toEqual(registered);
    for (const id of registered) expect(snap.accounts.get(id)).toEqual(writer.account(id));
    expect([...snap.kinds].filter(([, k]) => k === "investor").map(([id]) => id).sort()).toEqual(["ai-hold", "ai-ma5", "ai-reversal"]);
    // AI投資家のだれかは株を持ち、取得原価が入っている
    expect(registered.some((id) => Object.values(snap.accounts.get(id)!.holdings).some((h) => h.qty > 0 && h.cost > 0))).toBe(true);

    expect(Object.isFrozen(snap.events)).toBe(true);
    expect(Object.isFrozen(snap.events[0]!.payload)).toBe(true);
    const acc = snap.accounts.get(registered[0]!)!;
    expect(Object.isFrozen(acc) && Object.isFrozen(acc.holdings)).toBe(true);
    // Map も実行時に書き換えられない
    for (const m of [snap.accounts, snap.kinds] as unknown as Map<string, unknown>[]) {
      expect(m.set).toBeUndefined();
      expect(m.delete).toBeUndefined();
      expect(m.clear).toBeUndefined();
    }
    expect(Object.isFrozen(snap)).toBe(true);

    // 投稿の本文を、記録の bodyHash から引ける
    const post = events.find((e) => e.type === "post.published");
    expect(post).toBeDefined();
    expect(typeof snap.bodyOf((post!.payload as { bodyHash: string }).bodyHash)).toBe("string");
    expect(snap.bodyOf("0".repeat(64))).toBeUndefined();
  });

  it("書ける役割（表の持ち主）で読むと、標準エラー向けに警告を出す（断らない）。警告に接続文字列は入らない", async () => {
    await writeDays();
    const warnings: string[] = [];
    const snap = await readSnapshot(db, { warn: (m) => warnings.push(m) });
    expect(snap.lastHash).not.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/can write \(INSERT events, UPDATE events, DELETE events, INSERT stored_values/);
    expect(warnings[0]).not.toMatch(/postgres:\/\//);
  });

  it("SELECT だけの役割でも読め、警告を出さず、読み取り専用のトランザクションで読み、書く文・鍵・表を作る文を流さない", async () => {
    await writeDays();
    const expected = await readSnapshot(db, { warn: () => undefined });
    await pg.exec(`
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ffr_reader_test') THEN CREATE ROLE ffr_reader_test; END IF; END $$;
      GRANT USAGE ON SCHEMA public TO ffr_reader_test;
      GRANT SELECT ON events, stored_values TO ffr_reader_test;
      SET ROLE ffr_reader_test;`);
    try {
      const r = recording();
      const warnings: string[] = [];
      const snap = await readSnapshot(r.db, { warn: (m) => warnings.push(m) });
      expect(snap.lastHash).toBe(expected.lastHash);
      expect(warnings).toEqual([]);
      expect(r.log[0]).toBe("BEGIN");
      expect(r.log[1]).toMatch(/^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY$/);
      expect(r.log[2]).toBe("SET LOCAL statement_timeout = '30s'");
      expect(r.log.filter((t) => t === "BEGIN")).toHaveLength(1);
      // 権限を確かめる文（has_table_privilege）は、'INSERT' などの語を含むが書かない
      const statements = r.log.filter((t) => !t.startsWith("SELECT has_table_privilege"));
      expect(statements.filter((t) => /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT)\b|advisory|^lock /i.test(t))).toEqual([]);
    } finally {
      await pg.exec("RESET ROLE");
    }
  });

  it("記録の行や値が書き換えられていれば、途中までを返さずに例外にする", async () => {
    await writeDays();
    await pg.exec("ALTER TABLE events DISABLE TRIGGER USER");
    await pg.exec("UPDATE events SET recorded_at = recorded_at + 1 WHERE seq = 5");
    await expect(readSnapshot(db, { warn: () => undefined })).rejects.toThrow(/chain/);

    await writeDays();
    // 本文の行は DB の制約がハッシュを確かめるので、中身とハッシュの合わない値の行を足す
    await pg.exec(`INSERT INTO stored_values (hash, kind, salt, content) VALUES (repeat('a', 64), 'value', repeat('0', 32), '{"x":1}'::jsonb)`);
    await expect(readSnapshot(db, { warn: () => undefined })).rejects.toThrow(/does not match its hash/);
  });

  it("記録がなければ、空の結果を返す", async () => {
    await resetSchema(pg);
    await migrate(db);
    const snap = await readSnapshot(db, { warn: () => undefined });
    expect(snap.events).toEqual([]);
    expect(snap.lastHash).toBeNull();
    expect(snap.accounts.size).toBe(0);
  });
});

describe("画面のビルドで読み込める形", () => {
  it("pg-reader.ts と、それが読み込む pg-values.ts は、sql.ts（db/ をファイルとして読む）を型以外で読み込まない", () => {
    for (const f of ["pg-reader.ts", "pg-values.ts"]) {
      const src = readFileSync(new URL(`../../src/store/${f}`, import.meta.url), "utf8");
      const imports = src.split("\n").filter((l) => l.startsWith("import ") && !l.startsWith("import type "));
      expect(imports.filter((l) => /["']\.\/sql["']/.test(l)), f).toEqual([]);
    }
  });
});

describe("readSnapshotWith（接続を開いて読み、閉じる）", () => {
  const url = "postgres://reader:s3cret-pw@db.example.test:5432/ffr";
  /** 読むとき・閉じるときに、指定したエラーを投げる偽の接続 */
  const failing = (readErr: unknown, closeErr?: Error): SqlDb => ({
    ...db,
    transaction: () => Promise.reject(readErr),
    close: () => (closeErr ? Promise.reject(closeErr) : Promise.resolve()),
  });
  const text = (e: unknown): string => {
    if (!(e instanceof Error)) return String(e);
    const nested = [e.cause, ...(e instanceof AggregateError ? (e.errors as unknown[]) : [])].filter((x) => x !== undefined);
    return [e.message, e.stack ?? "", ...nested.map(text)].join("\n");
  };

  it("エラー文・cause・AggregateError の errors から、接続文字列とパスワードを伏せる", async () => {
    const inner = new Error(`password authentication failed: s3cret-pw`);
    const agg = new AggregateError([new Error(`connect to ${url} failed`), "s3cret-pw"], "all attempts failed", { cause: inner });
    const original = new Error(`cannot read ${url}`, { cause: agg });
    const err = await readSnapshotWith(() => failing(original), url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const all = text(err);
    expect(all).toContain("cannot read ***");
    expect(all).toContain("all attempts failed");
    expect(all).not.toContain("s3cret-pw");
    expect(all).not.toContain(url);
    expect((err as Error).cause).toBeInstanceOf(AggregateError);
  });

  it("閉じる失敗で元のエラーを上書きしない。読めたときに閉じるのに失敗しても結果を返す", async () => {
    const err = await readSnapshotWith(() => failing(new Error("read failed"), new Error("close failed")), url).catch((e: unknown) => e);
    expect((err as Error).message).toBe("read failed");

    await resetSchema(pg);
    await migrate(db);
    const snap = await readSnapshotWith(() => ({ ...db, close: () => Promise.reject(new Error("close failed")) }), url, { warn: () => undefined });
    expect(snap.lastHash).toBeNull();
  });
});

describe("readSnapshotFromEnv", () => {
  it("DATABASE_URL がなければ例外。つなげないときも、接続文字列とパスワードをエラー文に出さない", async () => {
    await expect(readSnapshotFromEnv({})).rejects.toThrow("DATABASE_URL is not set");
    const url = "postgres://reader:s3cret-pw@127.0.0.1:1/ffr";
    const err = (await readSnapshotFromEnv({ DATABASE_URL: url }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(`${err.message}\n${err.stack}`).not.toContain("s3cret-pw");
    expect(`${err.message}\n${err.stack}`).not.toContain(url);
  });
});
