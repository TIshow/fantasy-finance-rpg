// 検証役（#228）：引けのあとに回し直した毎日の実行が足した記録が、「次の取引日の判断」だけかを確かめる（daily-run・daily-production・erase-body で使う）。
// 引けのあとの実行は次の取引日の判断を書く（platform の夜の実行）。そのとき、前の日の判断（失敗の run を含む）を二重に書いていないことを、
// 種類だけでなく、数と日付と指す先で縛る。
import { expect } from "vitest";
import type { LogEvent } from "../../src/events/types";

const pl = (e: LogEvent) => e.payload as Record<string, unknown>;

/**
 * extra（回し直しで足された記録）について：
 * - 種類は agent.run・order_sheet.committed・post.published だけ
 * - 注文票の取引日は、すべて next（次の取引日）
 * - agent.run は、足された注文票か投稿の runSeq から指されているものだけ（どこからも指されない run は、前の日の判断の二重の記録や失敗の run）
 * - agent.run は、AI ごと・目的ごとに1件まで
 */
export function expectNextDayDecisionsOnly(extra: readonly LogEvent[], next: string, label: string): void {
  expect([...new Set(extra.map((e) => e.type))].filter((t) => !["agent.run", "order_sheet.committed", "post.published"].includes(t)), label).toEqual([]);
  const sheets = extra.filter((e) => e.type === "order_sheet.committed");
  for (const s of sheets) expect(pl(s).tradingDate, `${label} sheet seq ${s.seq}`).toBe(next);
  const referenced = new Set(extra.filter((e) => e.type === "order_sheet.committed" || e.type === "post.published").map((e) => pl(e).runSeq as number));
  const runs = extra.filter((e) => e.type === "agent.run");
  expect(runs.filter((r) => !referenced.has(r.seq)).map((r) => `${String(pl(r).agentId)}:${String(pl(r).purpose)}:seq ${r.seq}`), `${label} runs not used by an added sheet or post`).toEqual([]);
  const perAgent = new Map<string, number>();
  for (const r of runs) {
    const k = `${String(pl(r).agentId)}:${String(pl(r).purpose)}`;
    perAgent.set(k, (perAgent.get(k) ?? 0) + 1);
  }
  expect([...perAgent].filter(([, n]) => n > 1).map(([k]) => k), `${label} more than one run per AI and purpose`).toEqual([]);
}
