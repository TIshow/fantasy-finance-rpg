// ログの外に置く値（EVENT_LOG §5.2）：prices.* の値（valuesHash）と、投稿の本文・AIの出力（bodyHash・outputHash）。
// メモリ上に持つだけ（Postgres に残すものは src/store/pg-values.ts の PgValueStore）。乱数（salt）は外側なので、差し替えられる関数で受け取る（試験では固定シード）。
import { bodyHash } from "../events/hash";
import type { ValuesPort } from "../store/pg-values";

export type Salted<T> = { salt: Uint8Array; value: T };

/** 本番の salt：暗号用の乱数 16 バイト */
export const randomSalt = () => crypto.getRandomValues(new Uint8Array(16));

export class RunnerValues implements ValuesPort {
  private readonly values = new Map<string, Salted<unknown>>();
  private readonly bodies = new Map<string, Salted<string>>();

  constructor(private readonly salt: () => Uint8Array = randomSalt) {}

  /** 値を salt つきで置き、valuesHash を返す。追記より前に置く（保管は値がなければ書かない） */
  async putValue(value: unknown): Promise<string> {
    const salt = this.salt();
    const hash = await bodyHash(salt, { value });
    this.values.set(hash, { salt, value });
    return hash;
  }

  /** 本文・出力を salt つきで置き、ハッシュを返す（候補の文を当てて確かめられないように） */
  async putBody(text: string): Promise<string> {
    const salt = this.salt();
    const hash = await bodyHash(salt, text);
    this.bodies.set(hash, { salt, value: text });
    return hash;
  }

  get(hash: string): Salted<unknown> | undefined {
    return this.values.get(hash);
  }

  body(hash: string): Salted<string> | undefined {
    return this.bodies.get(hash);
  }
}
