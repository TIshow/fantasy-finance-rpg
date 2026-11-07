// 検証（verifier、大枠 #166・PR #170）：画面用の読むだけの役割 ffr_reader（db/ops/create_reader_role.sql、db/001〜003 の権限、
// 確認の SQL db/ops/check_reader_role.sql）を、実装とは別に確かめる。
// 文書（AGENTS.md の不変条件、EVENT_LOG §4、create_reader_role.sql の冒頭）から成り立つはずのこと：
// - ffr_reader の接続からは、events・stored_values を読むことしかできない。書く・書き換える・消す・TRUNCATE・本文を消す関数・COPY FROM・
//   一時テーブルや表・関数・schema を作る・別の役割になる・トリガを外す、のどれも断られ、記録とハッシュの連鎖は変わらない
// - 役割を migrate の前に作っても、後に作っても、migrate を流し直しても、同じく読むことしかできない
// - 表を別の schema（DATABASE_SCHEMA）に作ったときも同じ
// - 読むだけの口（src/store/pg-reader.ts の readSnapshot）は、ffr_reader で、書いた側と同じ最後のハッシュを返し、警告を出さない
// - 確認の SQL は、読む以外のことができる権限・所属があれば、想定の結果と違う値を返す（見落とさない）
// 欠陥の再現は it.fails にして、直ったら it に戻す。
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productionSetup, runDaily } from "../../scripts/daily-lib";
import { verifyChain } from "../../src/events/chain";
import { holidayTable } from "../../src/holidays";
import { readSnapshot } from "../../src/store/pg-reader";
import { readAllEvents } from "../../src/store/pg-store";
import { migrate, type SqlDb } from "../../src/store/sql";
import { FakeClock, jst } from "../contracts/fakes";
import { openPglite } from "../store/pglite";

let pg: PGlite;
let db: SqlDb;
const DAYS = ["2026-11-09", "2026-11-10"];
const OTHER = "ffr_s166";

beforeAll(async () => {
  ({ pg, db } = await openPglite());
  await pg.exec("CREATE ROLE ffr_app");
}, 60_000);
afterAll(() => db.close());

/** 持ち主に戻し、schema を作り直し、ffr_reader を消す */
async function reset() {
  await pg.exec(`RESET ROLE; RESET search_path; DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS ${OTHER} CASCADE`);
  await pg.exec("DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ffr_reader') THEN DROP OWNED BY ffr_reader; DROP ROLE ffr_reader; END IF; END $$");
}

/** 運営者の手順の SQL を流す（パスワードとデータベース名を置き換える）。search_path は呼ぶ側の設定のまま */
async function createReaderRole() {
  const dbName = (await pg.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d;
  const sql = readFileSync(new URL("../../db/ops/create_reader_role.sql", import.meta.url), "utf8");
  await pg.exec(sql.replace("<password>", "test-only-pw").replaceAll("<db>", `"${dbName}"`));
}

async function writeDays() {
  const clock = new FakeClock(jst(DAYS[0]!, 7));
  const waitUntil = async (at: number) => void (at > clock.now() && clock.set(at));
  for (const d of DAYS) await runDaily(d, { db, clock, prepare: productionSetup, holidayTable, waitUntil });
}

/** ffr_reader になって fn を動かし、必ず持ち主に戻す。schema を指定すれば、その schema を search_path にする */
async function asReader<T>(fn: () => Promise<T>, schema?: string): Promise<T> {
  await pg.exec(`SET ROLE ffr_reader${schema ? `; SET search_path = ${schema}` : ""}`);
  try {
    return await fn();
  } finally {
    await pg.exec("RESET ROLE; RESET search_path");
  }
}

const readerCheck = async (): Promise<Record<string, unknown>> =>
  (await pg.query<Record<string, unknown>>(readFileSync(new URL("../../db/ops/check_reader_role.sql", import.meta.url), "utf8"))).rows[0]!;
const EXPECTED_CHECK = {
  who: "ffr_reader",
  superuser: false,
  write_all_data: false,
  member_of_roles: 0,
  can_select: true,
  can_insert: false,
  can_update: false,
  can_delete: false,
  can_truncate: false,
  values_can_select: true,
  values_can_insert: false,
  values_can_update: false,
  values_can_delete: false,
  values_can_truncate: false,
  can_erase_body: false,
  can_create_temp: false,
  can_create_in_schema: false,
};

/** 記録の全行（連鎖の検査つき）と stored_values の全行を、持ち主の権限で文字列にする */
async function snapshot(schema = "public") {
  await pg.exec(`SET search_path = ${schema}`);
  try {
    const events = await readAllEvents(db);
    expect(await verifyChain(events)).toEqual([]);
    const values = (await pg.query(`SELECT hash, kind, salt, content FROM stored_values ORDER BY hash`)).rows;
    return { last: events.at(-1)?.hash ?? null, n: events.length, values: JSON.stringify(values) };
  } finally {
    await pg.exec("RESET search_path");
  }
}

/** ffr_reader から試して、すべて断られるべき文。表名は schema つきにできるよう s. を前に置く */
function deniedStatements(s: string, last: { seq: number; hash: string; recordedAt: number }): string[] {
  const ev = `${s}.events`;
  const sv = `${s}.stored_values`;
  return [
    `INSERT INTO ${ev} (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) VALUES (${last.seq + 1}, 1, 'source.captured', ${last.recordedAt}, 'system', '[]', '[]', '{}', '${last.hash}', '${"e".repeat(64)}')`,
    `INSERT INTO ${ev} SELECT * FROM ${ev} WHERE false`,
    `WITH x AS (DELETE FROM ${ev} RETURNING 1) SELECT count(*) FROM x`,
    `UPDATE ${ev} SET payload = '{}' WHERE seq = 1`,
    `DELETE FROM ${ev} WHERE seq = ${last.seq}`,
    `TRUNCATE ${ev}`,
    `TRUNCATE ${ev}, ${sv} CASCADE`,
    `COPY ${ev} FROM '/dev/blob'`,
    `COPY ${sv} FROM '/dev/blob'`,
    `SELECT * FROM ${ev} FOR UPDATE`,
    `SELECT * FROM ${sv} FOR SHARE`,
    `LOCK TABLE ${ev} IN EXCLUSIVE MODE`,
    `INSERT INTO ${sv} (hash, kind, salt, content) VALUES (repeat('a', 64), 'value', repeat('0', 32), '{}'::jsonb)`,
    `UPDATE ${sv} SET salt = repeat('1', 32)`,
    `DELETE FROM ${sv}`,
    `SELECT set_config('ffr.erase_body', (SELECT hash FROM ${sv} WHERE kind = 'body' LIMIT 1), true); DELETE FROM ${sv} WHERE kind = 'body'`,
    `SELECT ${s}.erase_withdrawn_body(1)`,
    `ALTER TABLE ${ev} DISABLE TRIGGER USER`,
    `ALTER TABLE ${sv} DISABLE TRIGGER ALL`,
    `DROP TRIGGER events_refuse_row_change ON ${ev}`,
    `DROP TRIGGER stored_values_guard_delete ON ${sv}`,
    `ALTER TABLE ${ev} OWNER TO ffr_reader`,
    `DROP TABLE ${sv}`,
    `CREATE INDEX ON ${ev} (type)`,
    `COMMENT ON TABLE ${ev} IS 'x'`,
    `CREATE TEMP TABLE t (x int)`,
    `CREATE TEMP VIEW v AS SELECT 1`,
    `CREATE TABLE ${s}.t (x int)`,
    `CREATE TABLE public.t2 (x int)`,
    `CREATE VIEW ${s}.v AS SELECT * FROM ${ev}`,
    `CREATE FUNCTION ${s}.f() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
    `CREATE SCHEMA ffr_evil`,
    `ALTER ROLE ffr_reader SUPERUSER`,
    `ALTER ROLE ffr_reader CREATEROLE`,
    `CREATE ROLE ffr_evil`,
  ];
}

/** 断られるべき文を1つずつ試し、通った文を返す。終わったあとに記録と値が変わっていないことを確かめる */
async function tryDenied(schema = "public"): Promise<string[]> {
  const before = await snapshot(schema);
  const last = (await pg.exec(`SET search_path = ${schema}`), (await readAllEvents(db)).at(-1)!);
  await pg.exec("RESET search_path");
  const passed: string[] = [];
  for (const sql of deniedStatements(schema, last)) {
    const ok = await asReader(async () => {
      // 1つの文ごとにトランザクションを分け、通っても取り消す（通ったこと自体を欠陥として返す）
      await pg.exec("BEGIN");
      try {
        await pg.exec(sql);
        return true;
      } catch (e) {
        // 文の誤りなどで落ちたのでは確かめにならないので、権限で断られたことを確かめる
        if (!/permission denied|must be owner/.test((e as Error).message)) throw new Error(`${sql}: ${(e as Error).message}`);
        return false;
      } finally {
        await pg.exec("ROLLBACK");
      }
    }, schema);
    if (ok) passed.push(sql);
  }
  expect(await snapshot(schema)).toEqual(before);
  return passed;
}

describe("ffr_reader は、どの順で作っても読むことしかできない", { timeout: 120_000 }, () => {
  const orders: [string, () => Promise<void>][] = [
    ["migrate の前に作る", async () => (await createReaderRole(), await migrate(db), await writeDays())],
    ["migrate と書き込みの後に作る", async () => (await migrate(db), await writeDays(), await createReaderRole())],
    ["後に作り、migrate を2回流し直す", async () => (await migrate(db), await writeDays(), await createReaderRole(), await migrate(db), await migrate(db))],
    ["前に作り、書いたあと migrate を流し直す", async () => (await createReaderRole(), await migrate(db), await writeDays(), await migrate(db))],
  ];
  for (const [label, setup] of orders) {
    it(`${label}：書く・消す・作る・別の役割になる文はすべて断られ、連鎖と値は変わらず、確認の SQL と読む口が想定どおり`, async () => {
      await reset();
      await setup();
      expect(await tryDenied()).toEqual([]);
      const expected = await readSnapshot(db, { warn: () => undefined });
      const warnings: string[] = [];
      const [check, snap] = await asReader(async () => [await readerCheck(), await readSnapshot(db, { warn: (m) => warnings.push(m) })] as const);
      expect(check).toEqual(EXPECTED_CHECK);
      expect(warnings).toEqual([]);
      expect(snap.lastHash).toBe(expected.lastHash);
      expect(snap.lastHash).toBe((await snapshot()).last);
      expect(snap.events.length).toBe(expected.events.length);
      // 別の役割になれない：ffr_reader が入っている役割はない（SET ROLE は入っている役割にしかなれない。
      // PGlite では接続の役割がいつも持ち主なので SET ROLE を直接は試せず、所属で確かめる）
      expect((await pg.query("SELECT rolname FROM pg_roles WHERE rolname <> 'ffr_reader' AND pg_has_role('ffr_reader', oid, 'MEMBER')")).rows).toEqual([]);
      // ffr_reader が自分に権限を与えようとしても、何も与えられない（警告だけで断られない文なので、結果で確かめる）
      await asReader(() => pg.exec("GRANT INSERT, UPDATE, DELETE, TRUNCATE ON events, stored_values TO ffr_reader"));
      expect(await asReader(readerCheck)).toEqual(EXPECTED_CHECK);
    });
  }

  it.fails("【欠陥・低】ffr_reader でも、ラージオブジェクト（DB の中の大きなデータ）を作って DB に書き込める（直れば断られる）", async () => {
    await reset();
    await createReaderRole();
    await migrate(db);
    await expect(asReader(() => pg.exec("SELECT lo_from_bytea(0, '\\x00')"))).rejects.toThrow(/permission denied/);
  });
});

describe("表を別の schema（DATABASE_SCHEMA）に作ったとき", { timeout: 120_000 }, () => {
  async function migrateInOther() {
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS ${OTHER}; SET search_path = ${OTHER}`);
    await migrate(db);
    await writeDays();
    await pg.exec("RESET search_path");
  }

  it("migrate の後に、その schema を search_path にして作ると、その schema でも読むことしかできない", async () => {
    await reset();
    await migrateInOther();
    await pg.exec(`SET search_path = ${OTHER}`);
    await createReaderRole();
    await pg.exec("RESET search_path");
    expect(await tryDenied(OTHER)).toEqual([]);
    await pg.exec(`SET search_path = ${OTHER}`);
    const expected = await readSnapshot(db, { warn: () => undefined });
    await pg.exec("RESET search_path");
    const warnings: string[] = [];
    const [check, snap] = await asReader(async () => [await readerCheck(), await readSnapshot(db, { warn: (m) => warnings.push(m) })] as const, OTHER);
    expect(check).toEqual(EXPECTED_CHECK);
    expect(warnings).toEqual([]);
    expect(snap.lastHash).toBe(expected.lastHash);
    expect(snap.lastHash).toBe((await snapshot(OTHER)).last);
  });

  it("schema を search_path に入れずに作ると読めず（手順どおり）、migrate を流し直すと読めるようになり、書けないまま", async () => {
    await reset();
    await migrateInOther();
    await createReaderRole(); // public には表がない：NOTICE だけ
    await expect(asReader(() => readSnapshot(db, { warn: () => undefined }), OTHER)).rejects.toThrow(/permission denied|does not exist/);
    await pg.exec(`SET search_path = ${OTHER}`);
    await migrate(db);
    await pg.exec("RESET search_path");
    expect(await tryDenied(OTHER)).toEqual([]);
    const check = await asReader(readerCheck, OTHER);
    expect(check).toEqual(EXPECTED_CHECK);
  });

  it("migrate の前に作り、別の schema に migrate すると、その schema でも読むことしかできない", async () => {
    await reset();
    await createReaderRole();
    await migrateInOther();
    expect(await tryDenied(OTHER)).toEqual([]);
    expect(await asReader(readerCheck, OTHER)).toEqual(EXPECTED_CHECK);
  });
});

describe("確認の SQL と読む口は、読む以外の権限を見落とさない", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await reset();
    await createReaderRole();
    await migrate(db);
    await writeDays();
  });

  /** 持ち主の権限で grant を流し、ffr_reader で確認の SQL と読む口の警告を取り、revoke で戻す */
  async function observe(grant: string, revoke: string) {
    await pg.exec(grant);
    try {
      const warnings: string[] = [];
      const [check] = await asReader(async () => [await readerCheck(), await readSnapshot(db, { warn: (m) => warnings.push(m) })] as const);
      return { check, warnings };
    } finally {
      await pg.exec(revoke);
    }
  }

  it("前提：列ごとの INSERT を与えると、ffr_reader は stored_values に行を足せる（書ける状態になる）", async () => {
    await pg.exec("GRANT INSERT (hash, kind, salt, content) ON stored_values TO ffr_reader");
    try {
      await asReader(async () => {
        await pg.exec("BEGIN");
        try {
          await pg.exec(`INSERT INTO stored_values (hash, kind, salt, content) VALUES (repeat('b', 64), 'value', repeat('0', 32), '{"x":1}'::jsonb)`);
        } finally {
          await pg.exec("ROLLBACK");
        }
      });
    } finally {
      await pg.exec("REVOKE INSERT (hash, kind, salt, content) ON stored_values FROM ffr_reader");
    }
  });

  it("migrate を流し直すと、列ごとの書く権限も外れる", async () => {
    await pg.exec("GRANT INSERT (hash, kind, salt, content) ON stored_values TO ffr_reader; GRANT INSERT (seq, payload) ON events TO ffr_reader");
    await migrate(db);
    const left = (
      await pg.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM information_schema.column_privileges WHERE grantee = 'ffr_reader' AND privilege_type <> 'SELECT' AND table_name IN ('events', 'stored_values')",
      )
    ).rows[0]!.n;
    expect(left).toBe(0);
  });

  it.fails("【欠陥・中】列ごとに INSERT を与えられていても、確認の SQL は想定の結果のまま（直れば想定と違う値になる）", async () => {
    const { check } = await observe(
      "GRANT INSERT (hash, kind, salt, content) ON stored_values TO ffr_reader",
      "REVOKE INSERT (hash, kind, salt, content) ON stored_values FROM ffr_reader",
    );
    expect(check).not.toEqual(EXPECTED_CHECK);
  });

  it.fails("【欠陥・中】列ごとに INSERT を与えられていても、読む口は警告を出さない（直れば警告が出る）", async () => {
    const { warnings } = await observe(
      "GRANT INSERT (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) ON events TO ffr_reader",
      "REVOKE INSERT (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) ON events FROM ffr_reader",
    );
    expect(warnings).toHaveLength(1);
  });

  it.fails("【欠陥・低】表の TRIGGER の権限を与えられていても、確認の SQL は想定の結果のまま", async () => {
    const { check } = await observe("GRANT TRIGGER ON events TO ffr_reader", "REVOKE TRIGGER ON events FROM ffr_reader");
    expect(check).not.toEqual(EXPECTED_CHECK);
  });

  it.fails("【欠陥・低】データベースに CREATE（schema を作る）の権限を与えられていても、確認の SQL は想定の結果のまま", async () => {
    const dbName = (await pg.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d;
    // 前提：この権限で ffr_reader は schema を作れる
    await pg.exec(`GRANT CREATE ON DATABASE "${dbName}" TO ffr_reader`);
    try {
      await asReader(async () => {
        await pg.exec("BEGIN");
        try {
          await pg.exec("CREATE SCHEMA ffr_reader_own; CREATE TABLE ffr_reader_own.t (x int)");
        } finally {
          await pg.exec("ROLLBACK");
        }
      });
    } finally {
      await pg.exec(`REVOKE CREATE ON DATABASE "${dbName}" FROM ffr_reader`);
    }
    const { check } = await observe(`GRANT CREATE ON DATABASE "${dbName}" TO ffr_reader`, `REVOKE CREATE ON DATABASE "${dbName}" FROM ffr_reader`);
    expect(check).not.toEqual(EXPECTED_CHECK);
  });

  it.fails("【欠陥・低】表の持ち主の役割に（NOINHERIT で）入れられていても、読む口は警告を出さない（SET ROLE で書ける。確認の SQL は気づく）", async () => {
    const owner = (await pg.query<{ o: string }>("SELECT tableowner AS o FROM pg_tables WHERE tablename = 'events' AND schemaname = 'public'")).rows[0]!.o;
    const { check, warnings } = await observe(`GRANT "${owner}" TO ffr_reader`, `REVOKE "${owner}" FROM ffr_reader`);
    expect(check).toMatchObject({ member_of_roles: 1 });
    expect(warnings).toHaveLength(1);
  });

  it("誤った権限・所属は、確認の SQL が気づく（表の SELECT 以外の権限、関数、一時テーブル、schema の CREATE、役割への所属）", async () => {
    const dbName = (await pg.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d;
    const cases: [string, string][] = [
      ["GRANT INSERT ON events TO ffr_reader", "REVOKE INSERT ON events FROM ffr_reader"],
      ["GRANT UPDATE ON stored_values TO ffr_reader", "REVOKE UPDATE ON stored_values FROM ffr_reader"],
      ["GRANT DELETE ON events TO PUBLIC", "REVOKE DELETE ON events FROM PUBLIC"],
      ["GRANT TRUNCATE ON stored_values TO PUBLIC", "REVOKE TRUNCATE ON stored_values FROM PUBLIC"],
      ["GRANT EXECUTE ON FUNCTION erase_withdrawn_body(bigint) TO PUBLIC", "REVOKE EXECUTE ON FUNCTION erase_withdrawn_body(bigint) FROM PUBLIC"],
      [`GRANT TEMP ON DATABASE "${dbName}" TO PUBLIC`, `REVOKE TEMP ON DATABASE "${dbName}" FROM PUBLIC`],
      ["GRANT CREATE ON SCHEMA public TO PUBLIC", "REVOKE CREATE ON SCHEMA public FROM PUBLIC"],
      ["GRANT ffr_app TO ffr_reader", "REVOKE ffr_app FROM ffr_reader"],
      ["GRANT pg_write_all_data TO ffr_reader", "REVOKE pg_write_all_data FROM ffr_reader"],
      ["ALTER ROLE ffr_reader SUPERUSER", "ALTER ROLE ffr_reader NOSUPERUSER"],
    ];
    for (const [grant, revoke] of cases) {
      const { check } = await observe(grant, revoke);
      expect(check, grant).not.toEqual(EXPECTED_CHECK);
    }
    expect(await asReader(readerCheck)).toEqual(EXPECTED_CHECK);
  });
});
