// 画面に出すデータ。ゴールデンログ（架空のシナリオ）を作って表示用に変換する。DB・外部通信なし。
// 実データの権利の確認（P-001）が済むまで、画面は架空のデータだけを表示する。固定データが架空のままかを、組み立てのたびに確かめる。
import { cache } from "react";
import { buildGoldenLog } from "../../tests/fixtures/golden";
import { SYMBOLS } from "../../tests/fixtures/scenario";
import { buildView } from "../view/build";

const SEED = 20261104;

const getGolden = cache(async () => {
  const g = await buildGoldenLog(SEED);
  for (const e of g.events) {
    const p = e.payload as { source?: string; symbols?: string[] };
    if ((e.type === "prices.open" || e.type === "prices.close") && p.source !== "fixture:synthetic") throw new Error(`seq ${e.seq}: not synthetic data`);
    if (e.type === "universe.set" && !p.symbols?.every((s) => (SYMBOLS as readonly string[]).includes(s))) throw new Error(`seq ${e.seq}: not a synthetic symbol`);
  }
  return g;
});

export const getView = cache(async () => {
  const g = await getGolden();
  return buildView(g.events, (hash) => g.bodies.get(hash)?.value);
});

/** 台帳の口座（取得原価は評価の記録になく、台帳が持つ）。AIのIDごと */
export const getAccounts = cache(async () => {
  const g = await getGolden();
  return new Map(g.scenario.agents.map((a) => [a.id, g.ledger.account(a.id)] as const));
});
