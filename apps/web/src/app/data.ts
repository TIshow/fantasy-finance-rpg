// 画面に出すデータの出どころ（#106）。
// 環境変数 DATABASE_URL があれば、Postgres の保管から記録を読み（store/pg-reader.ts。読むだけ）、台帳を作り直して表示する。
// なければ（手元の開発・試験・CI のビルド）、固定データ（ゴールデンログ。架空のシナリオ）を表示する。DB・外部通信はしない。
// ページは ISR（前もって作り、一定時間ごとに作り直す）。作り直しのときだけここが呼ばれ、見る人のたびには読まない。
// 作り直しの間隔は、各ページのファイルの `export const revalidate = 3600`（1時間。Next.js は定数の式を読めないため、各ファイルに直接書く）。
import { cache } from "react";
import { buildGoldenLog } from "../../tests/fixtures/golden";
import { SYMBOLS } from "../../tests/fixtures/scenario";
import type { Account } from "../ledger/types";
import { readSnapshotFromEnv } from "../store/pg-reader";
import { buildView } from "../view/build";
import type { View } from "../view/types";

const SEED = 20261104;

type Env = Readonly<Record<string, string | undefined>>;

export interface Source {
  view: View;
  /** AI投資家の口座（取得原価を持つ）。AIのIDごと */
  accounts: Map<string, Account>;
}

/** 固定データ（架空のシナリオ）。架空のままかを、組み立てのたびに確かめる */
async function fromFixture(): Promise<Source> {
  const g = await buildGoldenLog(SEED);
  for (const e of g.events) {
    const p = e.payload as { source?: string; symbols?: string[] };
    if ((e.type === "prices.open" || e.type === "prices.close") && p.source !== "fixture:synthetic") throw new Error(`seq ${e.seq}: not synthetic data`);
    if (e.type === "universe.set" && !p.symbols?.every((s) => (SYMBOLS as readonly string[]).includes(s))) throw new Error(`seq ${e.seq}: not a synthetic symbol`);
  }
  return {
    view: buildView(g.events, (hash) => g.bodies.get(hash)?.value),
    accounts: new Map(g.scenario.agents.map((a) => [a.id, g.ledger.account(a.id)] as const)),
  };
}

/** データベースの記録。読めない・照合が合わないときは例外（作り直しは失敗し、前に作った画面が残る） */
async function fromDatabase(env: Env): Promise<Source> {
  const s = await readSnapshotFromEnv(env);
  return {
    view: buildView(s.events, s.bodyOf), // 順位・カード・AIのページは、buildView が AI投資家だけに絞る
    accounts: new Map([...s.accounts].filter(([id]) => s.kinds.get(id) === "investor").map(([id, a]) => [id, a as Account] as const)),
  };
}

/**
 * DATABASE_URL の有無で出どころを選ぶ（空文字はなし扱い）。
 * 公開（VERCEL_ENV=production）で DATABASE_URL がないときは、固定データに逃げずに例外にする（ビルドが失敗する）。
 * ビルドの時と動いている時で出どころが違うと、AI と銘柄のページが 404 になるため。公開ではビルドの時にも DATABASE_URL を渡す
 */
export async function loadSource(env: Env = process.env): Promise<Source> {
  if (env.DATABASE_URL) return fromDatabase(env);
  if (env.VERCEL_ENV === "production") throw new Error("DATABASE_URL is required in production (the build must read the database, not the fixture)");
  return fromFixture();
}

const getSource = cache(() => loadSource());

export const getView = cache(async () => (await getSource()).view);

/** 台帳の口座（取得原価は評価の記録になく、台帳が持つ）。AIのIDごと */
export const getAccounts = cache(async () => (await getSource()).accounts);
