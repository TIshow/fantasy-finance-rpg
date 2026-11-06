// ログの外の値と本文の、Postgres の保管（#25 PR-2。表は db/002_stored_values.sql、規則は EVENT_LOG §5.2）。
// ValueStore（台帳が価格などを引く口。同期）を満たすため、開くときに全部をメモリに読み、その場でハッシュを照合する。
// 置く口（putValue・putBody）は RunnerValues と同じ形。追記より前に置く（イベントの valuesHash などが指す先になる）。
// 別の処理が置いた分は、refresh で読み直すまで見えない。
import { bodyHash, SALT_BYTES } from "../events/hash";
import type { ValueStore } from "../events/replay";
import { hasNul, type SqlRunner } from "./sql";

export type Salted<T> = { salt: Uint8Array; value: T };

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

export class PgValueStore implements ValueStore {
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

  /** DB から読み直す（別の処理が置いた分を取り込む） */
  async refresh(): Promise<void> {
    const { rows } = await this.db.query<Row>("SELECT hash, kind, salt, content FROM stored_values");
    const values = new Map<string, Salted<unknown>>();
    const bodies = new Map<string, Salted<string>>();
    for (const r of rows) {
      const salt = fromHex(r.salt);
      if ((await bodyHash(salt, r.kind === "body" ? (r.content as string) : { value: r.content })) !== r.hash) throw new Error(`stored value ${r.hash} does not match its hash`);
      if (r.kind === "body") bodies.set(r.hash, { salt, value: r.content as string });
      else values.set(r.hash, { salt, value: r.content });
    }
    this.values = values;
    this.bodies = bodies;
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
    await this.insert({ hash, kind: "value", salt: toHex(salt), content: value });
    this.values.set(hash, { salt, value });
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
    // 同じハッシュは同じ中身（salt が同じで中身が同じ）なので、二重に置いても何も起きない
    await this.db.query("INSERT INTO stored_values (hash, kind, salt, content) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (hash) DO NOTHING", [r.hash, r.kind, r.salt, JSON.stringify(r.content)]);
  }
}
