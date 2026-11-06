// 架空の企業を上場させる（#113 PR-2、MARKET_DESIGN §1・§2）。まだ上場していない企業ごとに company.listed を書き、
// そのあとで取引対象（universe.set）を、上場した銘柄だけにする（取引対象に入れたあとでは上場の記録を書けない）。
// 最初の価格は listingPrice。取引対象から外の銘柄を外すので、外の始値・終値は使わなくなる（#113 PR-3b）。
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
 * companies のうち、まだ上場していない企業を上場させ、取引対象を上場した銘柄すべて（前に上場した分も含む）にする。
 * 取引対象に上場していない銘柄があれば外す。universe.set は運営者の操作（actor は operator）。書けなければ例外（理由つき）。
 * runner と同じ1つの書き手として、runDay と runDay のあいだにだけ呼ぶ（runDay の途中に書くと、runner の持つログと合わなくなる）。
 * 書く前に次を確かめ、当てはまれば何も書かずに例外にする（上場の記録は取り消せないので、取引対象に入れられない半端な状態を残さない）：
 * - 上場させる企業があるのに、注文票を確定したAIの、その日の引け後の処理がまだ（その日の途中に上場すると、評価が止まる）
 * - 外す銘柄を、だれかが約定で手に入れたことがある、または約定待ちの注文票がある（core が外すことを断る）
 */
export async function listCompanies(store: EventStore, seed: number, companies: readonly Company[] = COMPANIES, operator: `operator:${string}` = "operator:owner"): Promise<ListingResult> {
  const events: LogEvent[] = [];
  for (let page = await store.read(); page.length > 0; page = await store.read(page.at(-1)!.seq)) events.push(...page);
  const payload = (e: LogEvent) => e.payload as Record<string, unknown>;
  const already = new Set(events.filter((e) => e.type === "company.listed").map((e) => payload(e).symbol as string));
  const lastUniverse = events.filter((e) => e.type === "universe.set").at(-1);
  const universe = new Set(lastUniverse ? (payload(lastUniverse).symbols as string[]) : []);

  const toList = companies.filter((c) => !already.has(c.symbol));
  const sheets = events.filter((e) => e.type === "order_sheet.committed");
  const applied = new Set(events.filter((e) => e.type === "corporate_actions.applied").map((e) => `${String(payload(e).agentId)}:${String(payload(e).asOf)}`));
  if (toList.length > 0 && sheets.some((e) => !applied.has(`${String(payload(e).agentId)}:${String(payload(e).tradingDate)}`))) throw new Error("company.listed: a trading day is in progress (run the day to its post-close first)");
  const keep = new Set([...already, ...toList.map((c) => c.symbol)]);
  const removed = [...universe].filter((s) => !keep.has(s));
  const filledSheets = new Set(events.filter((e) => e.type === "fills.executed").map((e) => payload(e).sheetSeq as number));
  if (removed.length > 0 && sheets.some((e) => !filledSheets.has(e.seq))) throw new Error("universe.set: a committed sheet is not filled yet");
  const bought = events.filter((e) => e.type === "fills.executed").flatMap((e) => payload(e).fills as { symbol: string; qty: number }[]).find((f) => removed.includes(f.symbol) && f.qty > 0);
  if (bought) throw new Error(`universe.set: ${bought.symbol} may be held (remove it from the universe after it is sold)`);

  const listed: string[] = [];
  for (const c of toList) {
    const r = await store.append({
      type: "company.listed",
      actor: "system",
      refs: [],
      payload: { symbol: c.symbol, name: c.name, sector: SECTORS[c.sector].name, sharesOutstanding: c.sharesOutstanding, price: listingPrice(seed, c) },
    });
    if (!r.ok) throw new Error(`company.listed ${c.symbol}: ${r.reason}`);
    listed.push(c.symbol);
  }
  // 取引対象は上場した銘柄すべて（前回 universe.set の前に落ちた分も加え、上場していない銘柄は外す）
  const symbols = [...new Set([...already, ...listed])].sort();
  if (symbols.length === universe.size && symbols.every((s) => universe.has(s))) return { listed, universeSet: false };
  const r = await store.append({ type: "universe.set", actor: operator, refs: [], payload: { symbols } });
  if (!r.ok) throw new Error(`universe.set: ${r.reason}`);
  return { listed, universeSet: true };
}
