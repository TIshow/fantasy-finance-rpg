// SQL を流す小さな口と、表を作る処理（#25 PR-1）。Postgres のドライバ（pg）も試験用の PGlite も、この口の後ろに置く。
// 保管（pg-store.ts）はこの口だけを知る。ドライバを替えるときは、つなぎ（pg-db.ts と tests/store/pglite.ts）を差し替える。
import { readdirSync, readFileSync } from "node:fs";

export interface SqlRunner {
  /** 1つの文を、$1 などの引数つきで流す。数は number・string のまま渡し、配列やオブジェクトは JSON の文字列にして ::jsonb で受ける */
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
  /** 複数の文を引数なしで流す（表を作るときなど） */
  exec(text: string): Promise<void>;
}

export interface SqlDb extends SqlRunner {
  /** fn を1つのトランザクションで流す。fn が例外を投げれば取り消す */
  transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
  /**
   * 接続を通して持つ鍵（セッションの advisory lock）を取る。取れなければ null（別の処理が持っている）。
   * 返す関数で手放す。プロセスが落ちれば、接続が切れて自動で手放される。毎日の実行が、全体を1つだけ動かすのに使う
   */
  lock(key: number): Promise<(() => Promise<void>) | null>;
  close(): Promise<void>;
}

const DB_DIR = new URL("../../db/", import.meta.url);

/** apps/web/db/*.sql を名前の順に流す。CLI・scripts・試験からだけ呼ぶ（db/ をファイルとして読むので、Next.js でまとめる画面のコードからは呼ばない）。何度流しても同じ結果になる書き方にしてある */
export async function migrate(db: SqlDb): Promise<void> {
  const files = readdirSync(DB_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  if (files.length === 0) throw new Error("no migration files in db/");
  await db.transaction(async (tx) => {
    for (const f of files) await tx.exec(readFileSync(new URL(f, DB_DIR), "utf8"));
  });
}

/** jsonb は U+0000 を持てない。本体は text.ts（画面のビルドからも読み込めるように、db/ を読むこのファイルから分けた） */
export { hasNul } from "./text";
