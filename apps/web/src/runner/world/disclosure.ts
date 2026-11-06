// 架空の企業の決算の発表（#113 PR-3b、MARKET_DESIGN §5）。上場の日に、上場の前の四半期（index 0）を発表し、
// そのあと板寄せの日が QUARTER_DAYS 日たまるごとに、その日の大引け（15:30）のあとに次の四半期を発表する（company.disclosed）。
// 数字は quarters（固定シードの業績のモデル）が決める。ログを見て済んでいる分は飛ばすので、呼び直しても二重にならない。
import type { Clock, EventStore } from "../../contracts";
import type { LogEvent } from "../../events/types";
import { cutoffOf } from "../../ledger/ledger";
import { COMPANIES, type Company, quarters } from "./companies";

/** 1四半期の長さ（板寄せの日数。#113 の lead の決定） */
export const QUARTER_DAYS = 20;

const HOUR = 3_600_000;

/**
 * 四半期の呼び名（例：2026-Q3）。index 0 は、上場した日（日本時間）を含む暦の四半期の、1つ前の四半期。
 * そこから index ごとに1四半期ずつ進める。架空の会計期間なので、暦より速く進む（1四半期は板寄せの20日）
 */
export function periodOf(listedAt: number, index: number): string {
  const d = new Date(listedAt + 9 * HOUR);
  const q = d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3) - 1 + index;
  return `${Math.floor(q / 4)}-Q${(q % 4) + 1}`;
}

/**
 * 上場した企業ごとに、発表の時期が来た四半期のうち、まだ発表していない分を古い順に書く。書いた「銘柄:四半期」を返す。
 * 時期：index 0 は上場の直後。index k は、板寄せが k × quarterDays 日分済み、その最後の日の15:30を過ぎたとき
 * （価格のつかなかった板寄せの日も数える）。毎日の実行では、上場の直後（productionSetup）と、runDay の afterClose
（前の日までの追いつきのあとと、その日の引け後）で呼ぶ。書けなければ例外（理由つき）。
 * clock は保管と同じ時計を渡す（時期は clock で決め、記録の時刻は保管が付けるので、別の時計だと15:30より前の記録になりうる）
 */
export async function discloseDue(store: EventStore, seed: number, clock: Clock, companies: readonly Company[] = COMPANIES, quarterDays = QUARTER_DAYS): Promise<string[]> {
  const events: LogEvent[] = [];
  for (let page = await store.read(); page.length > 0; page = await store.read(page.at(-1)!.seq)) events.push(...page);
  const p = (e: LogEvent) => e.payload as Record<string, unknown>;
  const out: string[] = [];
  for (const c of companies) {
    const listing = events.find((e) => e.type === "company.listed" && p(e).symbol === c.symbol);
    if (!listing) continue;
    const disclosed = new Set(events.filter((e) => e.type === "company.disclosed" && p(e).symbol === c.symbol).map((e) => p(e).period as string));
    const closedDays = events.filter((e) => e.type === "auction.cleared" && p(e).symbol === c.symbol && clock.now() >= cutoffOf(p(e).date as string) + 7 * HOUR).length;
    for (const q of quarters(seed, c, 1 + Math.floor(closedDays / quarterDays))) {
      const period = periodOf(listing.recordedAt, q.index);
      if (disclosed.has(period)) continue;
      const { index: _, ...figures } = q;
      const r = await store.append({ type: "company.disclosed", actor: "system", refs: [listing.seq], payload: { symbol: c.symbol, period, ...figures } });
      if (!r.ok) throw new Error(`company.disclosed ${c.symbol} ${period}: ${r.reason}`);
      out.push(`${c.symbol}:${period}`);
    }
  }
  return out;
}
