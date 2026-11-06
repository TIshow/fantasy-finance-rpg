// 架空の企業を上場させる（#113 PR-2、MARKET_DESIGN §1・§2）。まだ上場していない企業ごとに company.listed を書き、
// そのあとで取引対象（universe.set）に加える（取引対象に入れたあとでは上場の記録を書けない）。最初の価格は listingPrice。
// ログを見て済んでいる分は飛ばすので、もう一度呼んでも二重にならず、途中で落ちても呼び直せば続きから進む。
import type { EventStore } from "../../contracts";
import type { LogEvent } from "../../events/types";
import { COMPANIES, type Company, SECTORS, listingPrice } from "./companies";

export interface ListingResult {
  /** 新しく上場した銘柄（書いた順） */
  listed: string[];
  /** 取引対象を書き直したか */
  universeSet: boolean;
}

/**
 * companies のうち、まだ上場していない企業を上場させ、取引対象に加える。取引対象にほかの銘柄があれば残す。
 * universe.set は運営者の操作（actor は operator）。書けなければ例外（理由つき）。
 * runner と同じ1つの書き手として、runDay と runDay のあいだにだけ呼ぶ（runDay の途中に書くと、runner の持つログと合わなくなる）。
 * いまは取引対象を上場した銘柄だけにしない：上場した銘柄の終値の出どころ（評価・引け後の処理）が core にまだなく、毎日の流れが止まる
 */
export async function listCompanies(store: EventStore, seed: number, companies: readonly Company[] = COMPANIES, operator: `operator:${string}` = "operator:owner"): Promise<ListingResult> {
  const events: LogEvent[] = [];
  for (let page = await store.read(); page.length > 0; page = await store.read(page.at(-1)!.seq)) events.push(...page);
  const payload = (e: LogEvent) => e.payload as Record<string, unknown>;
  const already = new Set(events.filter((e) => e.type === "company.listed").map((e) => payload(e).symbol as string));
  const lastUniverse = events.filter((e) => e.type === "universe.set").at(-1);
  const universe = new Set(lastUniverse ? (payload(lastUniverse).symbols as string[]) : []);

  const listed: string[] = [];
  for (const c of companies) {
    if (already.has(c.symbol)) continue;
    const r = await store.append({
      type: "company.listed",
      actor: "system",
      refs: [],
      payload: { symbol: c.symbol, name: c.name, sector: SECTORS[c.sector].name, sharesOutstanding: c.sharesOutstanding, price: listingPrice(seed, c) },
    });
    if (!r.ok) throw new Error(`company.listed ${c.symbol}: ${r.reason}`);
    listed.push(c.symbol);
  }
  // 上場済みでも取引対象にない企業（前回 universe.set の前に落ちたとき）も加える
  const missing = companies.map((c) => c.symbol).filter((s) => !universe.has(s));
  if (missing.length === 0) return { listed, universeSet: false };
  const symbols = [...universe, ...missing].sort();
  const r = await store.append({ type: "universe.set", actor: operator, refs: [], payload: { symbols } });
  if (!r.ok) throw new Error(`universe.set: ${r.reason}`);
  return { listed, universeSet: true };
}
