// pg（node-postgres）で Postgres につなぐ SqlDb。接続の情報は環境変数 DATABASE_URL だけから読む。
// 接続文字列（パスワードを含む）をコード・ログ・エラー文に出さない。
import pg from "pg";
import type { SqlDb, SqlRunner } from "./sql";

export interface PgDbOptions {
  connectionString: string;
  /** 使う schema（既定は DB の既定）。作業ごとに分けるときに使う（ffr_platform_<issue番号> など）。直接つなぐときだけ使える */
  schema?: string;
  /** 同時につなぐ数の上限。Neon の無料枠のために小さくしておく */
  max?: number;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const runner = (c: pg.PoolClient | pg.Pool): SqlRunner => ({
  query: async (text, params) => ({ rows: (await c.query(text, params as unknown[] | undefined)).rows }),
  exec: async (text) => void (await c.query(text)),
});

export function pgDb({ connectionString, schema, max = 4 }: PgDbOptions): SqlDb {
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) throw new Error("invalid schema name");
  // schema は接続の開始時に指定する（Neon の pooler 経由の接続は開始時の指定を受け付けないので、schema は試験・作業ごとの分離用）
  const pool = new pg.Pool({ connectionString, max, ...(schema !== undefined && { options: `-c search_path=${schema}` }) });
  // 待機中の接続が切れても、プロセスを落とさない（次に使うときに新しくつなぐ）
  pool.on("error", () => undefined);
  return {
    ...runner(pool),
    async transaction(fn) {
      const c = await pool.connect();
      let failed = false;
      try {
        await c.query("BEGIN");
        const r = await fn(runner(c));
        await c.query("COMMIT");
        return r;
      } catch (err) {
        failed = true;
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        c.release(failed); // 失敗した接続は捨てて、状態が残らないようにする
      }
    },
    close: () => pool.end(),
  };
}

/** DATABASE_URL（と、あれば DATABASE_SCHEMA）から作る。なければ、値を出さずに例外 */
export function pgDbFromEnv(env: Readonly<Record<string, string | undefined>> = process.env, options: Omit<PgDbOptions, "connectionString" | "schema"> = {}): SqlDb {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return pgDb({ ...options, connectionString, schema: env.DATABASE_SCHEMA || undefined });
}
