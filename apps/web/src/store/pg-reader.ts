// 画面から使う、読むだけの口（#106）。Postgres の保管から、記録（events）とログの外の値・本文（stored_values）を読み、
// 記録だけから台帳を作り直して返す。照合は `daily verify`（scripts/daily-lib.ts の verifyDatabase）と同じ：
// ハッシュの連鎖（verifyChain）→ 値と本文のハッシュの照合（PgValueStore）→ 各イベントの検査と台帳への適用（replay）。
// どこかで食い違えば、途中までの結果を返さずに例外にする。
// 書く権限は使わない：INSERT をしない・advisory lock（書き手の鍵）を取らない・migrate を呼ばない。
// 読み取り専用で、1つの時点の内容だけを見るトランザクション（READ ONLY・REPEATABLE READ）で読むので、
// 読んでいる途中に毎日の実行が書き足しても、その分は見えない（値は記録より先に置かれるので、見える記録の値は必ず見える）。
// READ ONLY は権限の守りではないので、接続の役割が書ける役割なら、標準エラーに警告を出す（断らない）。
// sql.ts（db/ をファイルとして読む migrate を含む）は型としてだけ読み込む。実行時に読み込むと、画面のビルドが失敗する。
import { verifyChain } from "../events/chain";
import { replay } from "../events/replay";
import type { LogEvent } from "../events/types";
import { holidayTable as bundledHolidays, type HolidayTable } from "../holidays";
import type { Account, ParticipantKind } from "../ledger/types";
import { pgDbFromEnv } from "./pg-db";
import { readAllEvents } from "./pg-store";
import { PgValueStore } from "./pg-values";
import type { SqlDb, SqlRunner } from "./sql";

export interface StoreSnapshot {
  /** 記録の列（seq の順。凍結済み）。buildView の第1引数にそのまま渡す */
  events: readonly LogEvent[];
  /** 本文のハッシュから本文を引く。buildView の第2引数にそのまま渡す。消された本文・ない本文は undefined */
  bodyOf: (hash: string) => string | undefined;
  /** 登録された参加者のIDごとの口座（現金と、銘柄ごとの株数・取得原価。凍結済みの写し）。登録の順 */
  accounts: ReadonlyMap<string, Readonly<Account>>;
  /** 参加者のIDごとの種類（"investor" が AI投資家。マーケットメイカーなどを画面から除くときに使う） */
  kinds: ReadonlyMap<string, ParticipantKind>;
  /** 最後の記録のハッシュ（記録がなければ null） */
  lastHash: string | null;
}

export interface ReadOptions {
  /** 記録の中の holidays.adopted が指す祝日の一覧。既定は同梱の一覧（毎日の実行と同じ） */
  holidayTables?: readonly HolidayTable[];
  /** 警告の出し先。既定は標準エラー（console.error） */
  warn?: (message: string) => void;
}

/** 1つの文にかけてよい時間の上限（DB が混んで止まったときに、画面の作り直しを待たせ続けない） */
const STATEMENT_TIMEOUT = "30s";
const TABLES = ["events", "stored_values"];

const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) for (const x of Object.values(Object.freeze(v))) deepFreeze(x);
  return v;
};

/** 読むだけの Map（実行時にも set・delete・clear を持たない） */
class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  readonly #m: Map<K, V>;
  constructor(entries: Iterable<readonly [K, V]>) {
    this.#m = new Map(entries);
    Object.freeze(this);
  }
  get size() {
    return this.#m.size;
  }
  get(k: K) {
    return this.#m.get(k);
  }
  has(k: K) {
    return this.#m.has(k);
  }
  forEach(fn: (v: V, k: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
    this.#m.forEach((v, k) => fn.call(thisArg, v, k, this));
  }
  entries() {
    return this.#m.entries();
  }
  keys() {
    return this.#m.keys();
  }
  values() {
    return this.#m.values();
  }
  [Symbol.iterator]() {
    return this.#m.entries();
  }
}

/**
 * 接続の役割が、events・stored_values に書ける（INSERT・UPDATE・DELETE。INSERT・UPDATE は列ごとの権限も見る）なら、その一覧を返す。
 * 書ける役割（表の持ち主・pg_write_all_data）に属していれば、NOINHERIT でも SET ROLE で書けるので、それも返す
 */
async function writablePrivileges(tx: SqlRunner): Promise<string[]> {
  const out: string[] = [];
  for (const table of TABLES) {
    const { rows } = await tx.query<Record<string, boolean>>(
      `SELECT has_any_column_privilege($1, 'INSERT') AS insert, has_any_column_privilege($1, 'UPDATE') AS update, has_table_privilege($1, 'DELETE') AS delete,
              (SELECT c.relowner <> r.oid AND pg_has_role(r.oid, c.relowner, 'MEMBER') FROM pg_class c, pg_roles r WHERE c.oid = $1::regclass AND r.rolname = current_user) AS owner`,
      [table],
    );
    for (const op of ["insert", "update", "delete"]) if (rows[0]?.[op]) out.push(`${op.toUpperCase()} ${table}`);
    if (rows[0]?.owner) out.push(`member of the owner of ${table}`);
  }
  const { rows } = await tx.query<{ m: boolean }>("SELECT pg_has_role(current_user, 'pg_write_all_data', 'MEMBER') AS m");
  if (rows[0]?.m) out.push("member of pg_write_all_data");
  return out;
}

/** 開いている接続から読む。接続は閉じない */
export async function readSnapshot(db: SqlDb, options: ReadOptions = {}): Promise<StoreSnapshot> {
  const tables = options.holidayTables ?? [bundledHolidays];
  const warn = options.warn ?? ((m: string) => console.error(m));
  const { events, values, writable } = await db.transaction(async (tx) => {
    // トランザクションの最初の文で、読み取り専用と、1つの時点の内容だけを見ることを決める
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await tx.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    return { writable: await writablePrivileges(tx), events: await readAllEvents(tx), values: await PgValueStore.open(tx) };
  });
  if (writable.length > 0) warn(`warning: the database role used by the screen can write (${writable.join(", ")}). Use a role that can only SELECT.`);
  const chain = await verifyChain(events);
  if (chain.length > 0) throw new Error(`chain: ${chain.join("; ")}`);
  const ledger = await replay(events, values, { holidayTables: new Map(tables.map((t) => [t.contentSha256, t])) });

  const accounts: [string, Readonly<Account>][] = [];
  const kinds: [string, ParticipantKind][] = [];
  for (const e of events) {
    if (e.type !== "agent.registered") continue;
    const id = (e.payload as { agentId: string }).agentId;
    accounts.push([id, deepFreeze(ledger.account(id))]);
    kinds.push([id, ledger.kindOf(id)]);
  }
  return Object.freeze({
    events: Object.freeze([...events]),
    bodyOf: (hash: string) => values.body(hash)?.value,
    accounts: new FrozenMap(accounts),
    kinds: new FrozenMap(kinds),
    lastHash: events.at(-1)?.hash ?? null,
  });
}

/** 環境変数 DATABASE_URL（と、あれば DATABASE_SCHEMA）の保管から読み、接続を閉じる。DATABASE_URL の値はエラー文に出さない */
export function readSnapshotFromEnv(env: Readonly<Record<string, string | undefined>> = process.env, options: ReadOptions = {}): Promise<StoreSnapshot> {
  return readSnapshotWith(() => pgDbFromEnv(env, { max: 1 }), env.DATABASE_URL, options);
}

/** open で接続を作って読み、閉じる。エラーから url とパスワードを伏せる（readSnapshotFromEnv の本体。試験では偽の接続を渡す） */
export async function readSnapshotWith(open: () => SqlDb, url: string | undefined, options: ReadOptions = {}): Promise<StoreSnapshot> {
  let db: SqlDb | undefined;
  try {
    db = open();
    return await readSnapshot(db, options);
  } catch (err) {
    throw url ? scrub(err, secretsOf(url)) : err;
  } finally {
    // 閉じる失敗で、元のエラー（または読めた結果）を上書きしない
    await db?.close().catch(() => undefined);
  }
}

function secretsOf(url: string): string[] {
  let password = "";
  try {
    password = decodeURIComponent(new URL(url).password);
  } catch {
    // URL として読めなければ、全体だけを伏せる
  }
  return [url, password].filter((s) => s.length >= 4);
}

const hide = (t: string, secrets: readonly string[]) => secrets.reduce((m, s) => m.split(s).join("***"), t);

/** エラー（cause と AggregateError の errors も）の文から、接続文字列とパスワードを伏せた新しいエラーを作る（ドライバのエラー文は中身を選べないため） */
function scrub(err: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof err === "string") return hide(err, secrets);
  if (!(err instanceof Error)) return err;
  if (depth > 5) return new Error("error hidden (nested too deeply)");
  const cause = err.cause === undefined ? undefined : scrub(err.cause, secrets, depth + 1);
  const message = hide(err.message, secrets);
  const safe =
    err instanceof AggregateError
      ? new AggregateError(Array.from(err.errors as unknown[], (e) => scrub(e, secrets, depth + 1)), message, cause === undefined ? undefined : { cause })
      : new Error(message, cause === undefined ? undefined : { cause });
  safe.name = err.name;
  safe.stack = hide(err.stack ?? message, secrets);
  return safe;
}
