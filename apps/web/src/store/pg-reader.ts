// 画面から使う、読むだけの口（#106）。Postgres の保管から、記録（events）とログの外の値・本文（stored_values）を読み、
// 記録だけから台帳を作り直して返す。照合は `daily verify`（scripts/daily-lib.ts の verifyDatabase）と同じ：
// ハッシュの連鎖（verifyChain）→ 値と本文のハッシュの照合（PgValueStore と同じ）→ 各イベントの検査と台帳への適用（replay）。
// どこかで食い違えば、途中までの結果を返さずに例外にする。
// 書く権限は使わない：INSERT をしない・advisory lock（書き手の鍵）を取らない・migrate を呼ばない。
// 読み取り専用で、1つの時点の内容だけを見るトランザクション（READ ONLY・REPEATABLE READ）で読むので、
// 読んでいる途中に毎日の実行が書き足しても、その分は見えない（値は記録より先に置かれるので、見える記録の値は必ず見える）。
import { verifyChain } from "../events/chain";
import { bodyHash } from "../events/hash";
import { replay, type ValueStore } from "../events/replay";
import type { LogEvent } from "../events/types";
import { holidayTable as bundledHolidays, type HolidayTable } from "../holidays";
import type { Account, ParticipantKind } from "../ledger/types";
import { pgDbFromEnv } from "./pg-db";
import { readAllEvents } from "./pg-store";
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
}

const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) for (const x of Object.values(Object.freeze(v))) deepFreeze(x);
  return v;
};

type Salted<T> = { salt: Uint8Array; value: T };
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/**
 * stored_values を全部読み、塩を足したハッシュを照合する（PgValueStore.refresh と同じ照合）。合わない行があれば例外。
 * PgValueStore を使わないのは、pg-values.ts が sql.ts（db/ をファイルとして読む migrate を含む）を読み込み、
 * Next.js の画面のビルドが db/ を解決できずに失敗するため
 */
async function readValues(tx: SqlRunner): Promise<ValueStore & { body(hash: string): Salted<string> | undefined }> {
  const values = new Map<string, Salted<unknown>>();
  const bodies = new Map<string, Salted<string>>();
  const { rows } = await tx.query<{ hash: string; kind: string; salt: string; content: unknown }>("SELECT hash, kind, salt, content FROM stored_values");
  for (const r of rows) {
    const salt = fromHex(r.salt);
    if (r.kind === "body" && typeof r.content !== "string") throw new Error(`stored value ${r.hash} is not text`);
    if ((await bodyHash(salt, r.kind === "body" ? (r.content as string) : { value: r.content })) !== r.hash) throw new Error(`stored value ${r.hash} does not match its hash`);
    if (r.kind === "body") bodies.set(r.hash, { salt, value: r.content as string });
    else values.set(r.hash, { salt, value: deepFreeze(r.content) });
  }
  return { get: (h) => values.get(h), body: (h) => bodies.get(h) };
}

/** 開いている接続から読む。接続は閉じない */
export async function readSnapshot(db: SqlDb, options: ReadOptions = {}): Promise<StoreSnapshot> {
  const tables = options.holidayTables ?? [bundledHolidays];
  const { events, values } = await db.transaction(async (tx) => {
    // トランザクションの最初の文で、読み取り専用と、1つの時点の内容だけを見ることを決める
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return { events: await readAllEvents(tx), values: await readValues(tx) };
  });
  const chain = await verifyChain(events);
  if (chain.length > 0) throw new Error(`chain: ${chain.join("; ")}`);
  const ledger = await replay(events, values, { holidayTables: new Map(tables.map((t) => [t.contentSha256, t])) });

  const accounts = new Map<string, Readonly<Account>>();
  const kinds = new Map<string, ParticipantKind>();
  for (const e of events) {
    if (e.type !== "agent.registered") continue;
    const id = (e.payload as { agentId: string }).agentId;
    accounts.set(id, deepFreeze(ledger.account(id)));
    kinds.set(id, ledger.kindOf(id));
  }
  return Object.freeze({
    events: Object.freeze([...events]),
    bodyOf: (hash: string) => values.body(hash)?.value,
    accounts,
    kinds,
    lastHash: events.at(-1)?.hash ?? null,
  });
}

/** 環境変数 DATABASE_URL（と、あれば DATABASE_SCHEMA）の保管から読み、接続を閉じる。DATABASE_URL の値はエラー文に出さない */
export async function readSnapshotFromEnv(env: Readonly<Record<string, string | undefined>> = process.env, options: ReadOptions = {}): Promise<StoreSnapshot> {
  const db = pgDbFromEnv(env, { max: 1 });
  try {
    return await readSnapshot(db, options);
  } catch (err) {
    throw scrub(err, env.DATABASE_URL!);
  } finally {
    await db.close();
  }
}

/** エラー文に接続文字列やパスワードが混じっていれば、伏せた新しいエラーにする（ドライバのエラー文は中身を選べないため） */
function scrub(err: unknown, url: string): unknown {
  if (!(err instanceof Error)) return err;
  let password = "";
  try {
    password = decodeURIComponent(new URL(url).password);
  } catch {
    // URL として読めなければ、全体だけを伏せる
  }
  const secrets = [url, password].filter((s) => s.length >= 4);
  if (!secrets.some((s) => err.message.includes(s) || (err.stack ?? "").includes(s))) return err;
  const hide = (t: string) => secrets.reduce((m, s) => m.split(s).join("***"), t);
  const safe = new Error(hide(err.message));
  safe.stack = hide(err.stack ?? safe.message);
  return safe;
}
