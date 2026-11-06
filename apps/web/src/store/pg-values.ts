// ログの外の値と本文の、Postgres の保管（#25 PR-2。表は db/002_stored_values.sql、規則は EVENT_LOG §5.2）。
// ValueStore（台帳が価格などを引く口。同期）を満たすため、開くときに全部をメモリに読み、その場でハッシュを照合する。
// 置く口（putValue・putBody）は RunnerValues と同じ形。追記より前に置く（イベントの valuesHash などが指す先になる）。
// 別の処理が置いた分は、refresh で取り込む（足すだけ。PgEventStore は、別の処理の書いたイベントに追いつく前に呼ぶ）。
import { canonicalize } from "../events/canonical";
import { bodyHash, SALT_BYTES } from "../events/hash";
import type { ValueStore } from "../events/replay";
import { hasNul, type SqlRunner } from "./sql";

export type Salted<T> = { salt: Uint8Array; value: T };

/**
 * 値と本文を置く・引く口。RunnerValues（src/runner/values.ts）と同じ形。
 * RunnerValues は private の項目を持つクラスなので、runner（day.ts）が型としてそれを受け取る限り、PgValueStore は渡せない。
 * runner が下の型を受け取るようにする変更は runner の担当（#30 の前に lead が決める）。
 */
export interface ValuesPort extends ValueStore {
  putValue(value: unknown): Promise<string>;
  putBody(text: string): Promise<string>;
  body(hash: string): Salted<string> | undefined;
}

const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) for (const x of Object.values(Object.freeze(v))) deepFreeze(x);
  return v;
};

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
/** 本番の salt：暗号用の乱数 16 バイト（EVENT_LOG §5.2） */
const randomSalt = () => crypto.getRandomValues(new Uint8Array(SALT_BYTES));

interface Row {
  hash: string;
  kind: "value" | "body";
  salt: string;
  content: unknown;
}

export class PgValueStore implements ValuesPort {
  private values = new Map<string, Salted<unknown>>();
  private bodies = new Map<string, Salted<string>>();

  private constructor(
    private readonly db: SqlRunner,
    private readonly salt: () => Uint8Array,
  ) {}

  /** 保存済みの値と本文を全部読み、ハッシュを照合する。合わない行があれば例外（書き換えられている） */
  static async open(db: SqlRunner, salt: () => Uint8Array = randomSalt): Promise<PgValueStore> {
    const store = new PgValueStore(db, salt);
    await store.refresh();
    return store;
  }

  /** 手元にない値と本文を DB から取り込み（db を渡せば、その接続・トランザクションで読む。トランザクションの中からは必ず渡す）、ハッシュを照合して足す（手元のものは変えない）。合わない行があれば例外 */
  async refresh(db: SqlRunner = this.db): Promise<void> {
    const known = new Set([...this.values.keys(), ...this.bodies.keys()]);
    const { rows: all } = await db.query<{ hash: string }>("SELECT hash FROM stored_values");
    const missing = all.map((r) => r.hash).filter((h) => !known.has(h));
    if (missing.length === 0) return;
    const { rows } = await db.query<Row>("SELECT hash, kind, salt, content FROM stored_values WHERE hash IN (SELECT jsonb_array_elements_text($1::jsonb))", [JSON.stringify(missing)]);
    for (const r of rows) {
      const salt = fromHex(r.salt);
      if ((await bodyHash(salt, r.kind === "body" ? (r.content as string) : { value: r.content })) !== r.hash) throw new Error(`stored value ${r.hash} does not match its hash`);
      if (r.kind === "body") this.bodies.set(r.hash, { salt, value: r.content as string });
      else this.values.set(r.hash, { salt, value: deepFreeze(r.content) });
    }
  }

  get(hash: string): Salted<unknown> | undefined {
    return this.values.get(hash);
  }

  body(hash: string): Salted<string> | undefined {
    return this.bodies.get(hash);
  }

  /** 値を salt つきで置き、valuesHash を返す。JSON で表せない値・U+0000 を含む値は例外 */
  async putValue(value: unknown): Promise<string> {
    if (hasNul(value)) throw new Error("value contains U+0000, which the database cannot store");
    const salt = this.salt();
    const hash = await bodyHash(salt, { value });
    const own = deepFreeze(structuredClone(value)); // 置いたあとに呼び出し側が書き換えても、手元と DB の行は変わらない
    await this.insert({ hash, kind: "value", salt: toHex(salt), content: own });
    this.values.set(hash, { salt, value: own });
    return hash;
  }

  /** 本文・出力を salt つきで置き、ハッシュを返す */
  async putBody(text: string): Promise<string> {
    if (hasNul(text)) throw new Error("body contains U+0000, which the database cannot store");
    const salt = this.salt();
    const hash = await bodyHash(salt, text);
    await this.insert({ hash, kind: "body", salt: toHex(salt), content: text });
    this.bodies.set(hash, { salt, value: text });
    return hash;
  }

  private async insert(r: Row): Promise<void> {
    const { rows } = await this.db.query("INSERT INTO stored_values (hash, kind, salt, content) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (hash) DO NOTHING RETURNING hash", [r.hash, r.kind, r.salt, JSON.stringify(r.content)]);
    if (rows.length > 0) return;
    // 同じハッシュの行が先にある。同じ中身（種類・salt・中身）なら二重に置いただけ。違えば、先の行が不正か、salt を固定した衝突
    const { rows: old } = await this.db.query<Row>("SELECT hash, kind, salt, content FROM stored_values WHERE hash = $1", [r.hash]);
    const o = old[0];
    if (!o || o.kind !== r.kind || o.salt !== r.salt || canonicalize(o.content) !== canonicalize(r.content)) throw new Error(`stored value ${r.hash} already exists with different content`);
  }
}
