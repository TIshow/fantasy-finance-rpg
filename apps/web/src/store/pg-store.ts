// Postgres の EventStore（#25 PR-1。契約は src/contracts/event-store.ts、規則は D-034・D-040・EVENT_LOG §4）。
// 検査と台帳の計算は、メモリ上の保管（InMemoryEventStore）にそのまま任せる。この保管は、その結果を DB に書く。
// 追記は、プロセスの中で1件ずつ直列にし、DB でもトランザクションの先頭で advisory lock（同時に1つだけ書かせる鍵）を取る。
// 別のプロセスが書いた分は、鍵を取ったあとに読んで追いついてから、検査にかける。
// read・last も、追いついて検査（EventLog.admit）を終えたイベントだけを返す。検査に通らない行が DB にあれば、読む側も止まる。
// 追記だけであることは DB でも守る（db/001_events.sql。アプリの役割から UPDATE・DELETE を外し、トリガでも断る）。
import type { Clock, CommitResult, DraftInput, EventStore, SheetInput } from "../contracts";
import type { AppendResult } from "../events/append";
import type { ValueStore } from "../events/replay";
import { SCHEMA, type LogEvent } from "../events/types";
import type { HolidayTable } from "../holidays/table";
import { ADOPT, InMemoryEventStore, READ_MAX } from "./memory-store";
import { hasNul, type SqlDb, type SqlRunner } from "./sql";

/** advisory lock の番号。この表への追記だけが使う */
const LOCK_KEY = 25_000_001;
const COLUMNS = "seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash";

interface Row {
  seq: number | string;
  schema_ver: number;
  type: LogEvent["type"];
  recorded_at: number | string;
  actor: LogEvent["actor"];
  keys: string[];
  refs: number[];
  payload: unknown;
  prev_hash: string;
  hash: string;
}

const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) for (const x of Object.values(Object.freeze(v))) deepFreeze(x);
  return v;
};

function toEvent(r: Row): LogEvent {
  if (r.schema_ver !== SCHEMA) throw new Error(`unsupported event schema ${r.schema_ver} at seq ${r.seq}`);
  // bigint の列は、ドライバによって文字列で返るので Number にする（どちらも安全な整数の範囲）
  return deepFreeze({ seq: Number(r.seq), schema: SCHEMA, type: r.type, recordedAt: Number(r.recorded_at), actor: r.actor, keys: r.keys, refs: r.refs, payload: r.payload, prevHash: r.prev_hash, hash: r.hash });
}

async function readRows(db: SqlRunner, afterSeq: number, limit: number): Promise<LogEvent[]> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM events WHERE seq > $1 ORDER BY seq LIMIT $2`, [afterSeq, limit]);
  return rows.map(toEvent);
}

export interface PgStoreDeps {
  /** ログの外の値（価格など）。作り直しに要るので、追記より前に入れておく */
  values: ValueStore;
  holidayTables: ReadonlyMap<string, HolidayTable>;
  /** 時計の権威（recordedAt はここから決める。呼び出し側の値は無視する） */
  clock: Clock;
  readMax?: number;
  /** true なら、開くときに checkAppendOnlyRole を確かめ、問題があれば例外にする（本番の接続はこれを付ける） */
  requireAppendOnlyRole?: boolean;
}

/** 追記だけの表（db/001・002） */
const APPEND_ONLY_TABLES = ["events", "stored_values"];

/**
 * いまの接続の役割が、追記だけの約束を権限で守られているかを確かめ、問題の一覧を返す（空なら問題なし）。
 * 表の持ち主・スーパーユーザーは、トリガを外せるので、アプリの接続には使わない。
 */
export async function checkAppendOnlyRole(db: SqlRunner): Promise<string[]> {
  const problems: string[] = [];
  for (const table of APPEND_ONLY_TABLES) {
    const { rows } = await db.query<Record<string, boolean>>(
      `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
              pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE tablename = $1 AND schemaname = current_schema()), 'USAGE') AS owner,
              has_table_privilege($1, 'INSERT') AS can_insert,
              has_table_privilege($1, 'UPDATE') AS can_update,
              has_table_privilege($1, 'DELETE') AS can_delete,
              has_table_privilege($1, 'TRUNCATE') AS can_truncate`,
      [table],
    );
    const r = rows[0] ?? {};
    if (r.superuser) problems.push("the role is a superuser");
    if (r.owner) problems.push(`the role is (or is a member of) the owner of ${table}`);
    if (!r.can_insert) problems.push(`the role cannot INSERT into ${table}`);
    for (const [k, op] of [["can_update", "UPDATE"], ["can_delete", "DELETE"], ["can_truncate", "TRUNCATE"]] as const) if (r[k]) problems.push(`the role can ${op} ${table}`);
  }
  return [...new Set(problems)];
}

const NUL_REASON = "contains U+0000, which the database cannot store";

export class PgEventStore implements EventStore {
  private mem: InMemoryEventStore | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly readMax: number;

  /** 表は migrate（sql.ts）で作っておく。保存済みのイベントを先頭から読み、検査し直して状態を作る */
  static async open(db: SqlDb, deps: PgStoreDeps): Promise<PgEventStore> {
    const store = new PgEventStore(db, deps);
    if (deps.requireAppendOnlyRole) {
      const problems = await checkAppendOnlyRole(db);
      if (problems.length > 0) throw new Error(`database role is not append-only: ${problems.join("; ")}`);
    }
    const mem = await store.sync();
    const last = await mem.last();
    if (last && !(deps.clock.now() >= last.recordedAt)) throw new RangeError("clock is earlier than the last recordedAt");
    return store;
  }

  private constructor(
    private readonly db: SqlDb,
    private readonly deps: PgStoreDeps,
  ) {
    this.readMax = deps.readMax ?? READ_MAX;
    if (!Number.isInteger(this.readMax) || this.readMax < 1) throw new RangeError("readMax must be an integer >= 1");
  }

  async read(afterSeq = 0, limit = this.readMax): Promise<readonly LogEvent[]> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new RangeError("afterSeq must be an integer >= 0");
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer >= 1");
    return (await this.sync()).read(afterSeq, limit);
  }

  async last(): Promise<LogEvent | null> {
    return (await this.sync()).last();
  }

  append(draft: DraftInput): Promise<AppendResult> {
    if (hasNul(draft)) return Promise.resolve({ ok: false, reason: `draft ${NUL_REASON}` });
    return this.write((mem) => mem.append(draft));
  }

  commitSheet(agentId: string, sheet: SheetInput): Promise<CommitResult> {
    if (hasNul([agentId, sheet])) return Promise.resolve({ ok: false, reason: `sheet ${NUL_REASON}` });
    return this.write((mem) => mem.commitSheet(agentId, sheet));
  }

  /** DB の末尾まで追いつき、検査を終えた状態を返す（読むだけ。鍵は取らない） */
  private sync(): Promise<InMemoryEventStore> {
    return this.serial(() => this.db.transaction((tx) => this.synced(tx)));
  }

  /** 鍵を取り、DB の末尾まで追いついた状態で run を流す。書けたイベントは同じトランザクションで DB に足す */
  private write<T extends AppendResult>(run: (mem: InMemoryEventStore) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      try {
        return await this.db.transaction(async (tx) => {
          await tx.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
          const mem = await this.synced(tx);
          const r = await run(mem);
          if (r.ok) await this.insert(tx, r.event);
          return r;
        });
      } catch (err) {
        // メモリ上の状態が DB より進んでいるかもしれない（書き込みや COMMIT の失敗）。捨てて、次の操作で DB から作り直す
        this.mem = null;
        throw err;
      }
    });
  }

  /** DB にあって手元にないイベントを取り込み（なければ先頭から作り）、手元の状態を返す */
  private async synced(tx: SqlRunner): Promise<InMemoryEventStore> {
    const mem = (this.mem ??= new InMemoryEventStore(this.deps.values, this.deps.holidayTables, this.deps.clock, this.readMax));
    try {
      for (let after = (await mem.last())?.seq ?? 0; ; ) {
        const page = await readRows(tx, after, this.readMax);
        if (page.length === 0) return mem;
        await mem[ADOPT](page);
        after = page.at(-1)!.seq;
      }
    } catch (err) {
      this.mem = null; // 途中まで取り込んだ状態は使わない
      throw err;
    }
  }

  private async insert(tx: SqlRunner, e: LogEvent): Promise<void> {
    await tx.query(`INSERT INTO events (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)`, [
      e.seq,
      e.schema,
      e.type,
      e.recordedAt,
      e.actor,
      JSON.stringify(e.keys),
      JSON.stringify(e.refs),
      JSON.stringify(e.payload),
      e.prevHash,
      e.hash,
    ]);
  }

  /** プロセスの中で1件ずつ。前の失敗は次に伝えない */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
