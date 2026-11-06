// 試験用の SqlDb：PGlite（Postgres を Node の中で動かすライブラリ）。Docker も接続情報も要らない。本番のコードは import しない。
import { PGlite } from "@electric-sql/pglite";
import type { SqlDb } from "../../src/store/sql";

/** 起動に数秒かかるので、ファイルごとに1つ作って使い回す。表の初期化は resetSchema で */
export async function openPglite(): Promise<{ pg: PGlite; db: SqlDb }> {
  const pg = new PGlite();
  await pg.waitReady;
  const db: SqlDb = {
    query: async (text, params) => ({ rows: (await pg.query(text, params as unknown[] | undefined)).rows as never }),
    exec: async (text) => void (await pg.exec(text)),
    transaction: (fn) =>
      pg.transaction((tx) =>
        fn({
          query: async (text, params) => ({ rows: (await tx.query(text, params as unknown[] | undefined)).rows as never }),
          exec: async (text) => void (await tx.exec(text)),
        }),
      ),
    // 接続が1つだけなので、競合は起こらない（競合の試験は pg ドライバ側で行う）
    lock: async (key) => {
      const { rows } = await pg.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [key]);
      return rows[0]!.ok ? async () => void (await pg.query("SELECT pg_advisory_unlock($1)", [key])) : null;
    },
    close: () => pg.close(),
  };
  return { pg, db };
}

/** テストの間の後始末：持ち主の権限で schema ごと作り直す（TRUNCATE はトリガが断る） */
export const resetSchema = (pg: PGlite) => pg.exec("RESET ROLE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
