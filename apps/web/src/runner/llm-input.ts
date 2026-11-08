// LLM の AI 投資家に渡す入力の値を、記録から集める（#179）。
// 使うのは、依頼の予約（llm.batch.submitted）を書く前の記録だけ（events に渡すのは、その前までの記録）。依頼は前の営業日の
// 引けのあとに作るので、値段は取引日より前の板寄せ、決算は締めより前に記録した発表、掲示板はそれまでの投稿だけになる。
// 翌朝の受け取りでは、同じ記録（予約より前）から同じ値を作り直し、送った本文のハッシュと比べる（作り直しても同じであることを確かめる）。
import type { LogEvent } from "../events/types";
import { cutoffOf } from "../ledger/ledger";
import type { Account, Deciyen } from "../ledger/types";
import { GENERAL_BOARD, type InvestorInput, type InvestorPost, type InvestorSymbol } from "../llm/investor-prompt";

/** 値段の推移の日数（新しい方から）・決算の四半期の数・投稿の数の上限。入力の文が長すぎれば、さらに削る（investorUserText） */
export const LLM_INPUT_DAYS = 20;
export const LLM_INPUT_QUARTERS = 4;
export const LLM_INPUT_POSTS = 40;

type Payload = Record<string, unknown>;
const pl = (e: LogEvent) => e.payload as Payload;

export interface InvestorInputContext {
  agentId: string;
  tradingDate: string;
  /** いまの口座（台帳の写し）。予約より前の、最後の引け後の処理のあとの口座 */
  account: Account;
  /** 本文のハッシュから本文を引く（消した本文・ないものは null） */
  body: (hash: string) => string | null;
}

/**
 * 予約より前の記録 events から、入力の値を集める。口座の根拠は、そのAIの最後の引け後の処理（まだなければ登録）。
 * 登録がなければ RangeError
 */
export function investorInputOf(events: readonly LogEvent[], c: InvestorInputContext): InvestorInput {
  const registered = events.find((e) => e.type === "agent.registered" && pl(e).agentId === c.agentId);
  if (!registered) throw new RangeError(`agent ${c.agentId} is not registered`);
  const basis = events.filter((e) => e.type === "corporate_actions.applied" && pl(e).agentId === c.agentId).at(-1) ?? registered;
  const universe = new Set((events.filter((e) => e.type === "universe.set").at(-1)?.payload as { symbols?: string[] } | undefined)?.symbols ?? []);
  const symbols: InvestorSymbol[] = events
    .filter((e) => e.type === "company.listed" && universe.has(pl(e).symbol as string))
    .sort((x, y) => ((pl(x).symbol as string) < (pl(y).symbol as string) ? -1 : 1))
    .map((listing) => {
      const symbol = pl(listing).symbol as string;
      const before = events.filter((e) => e.type === "auction.cleared" && pl(e).symbol === symbol && (pl(e).date as string) < c.tradingDate);
      const ref = before.filter((e) => pl(e).price !== null).at(-1) ?? listing;
      const disclosures = events.filter((e) => e.type === "company.disclosed" && pl(e).symbol === symbol && e.recordedAt < cutoffOf(c.tradingDate)).slice(-LLM_INPUT_QUARTERS);
      return {
        symbol,
        name: pl(listing).name as string,
        sector: pl(listing).sector as string,
        sharesOutstanding: pl(listing).sharesOutstanding as number,
        listing: { seq: listing.seq, price: pl(listing).price as Deciyen },
        refPrice: { seq: ref.seq, price: pl(ref).price as Deciyen },
        auctions: before.slice(-LLM_INPUT_DAYS).map((e) => ({ seq: e.seq, date: pl(e).date as string, price: pl(e).price as Deciyen | null, volume: pl(e).volume as number })),
        disclosures: disclosures.map((e) => {
          const q = pl(e);
          return { seq: e.seq, period: q.period as string, revenue: q.revenue as number, netIncome: q.netIncome as number, eps: q.eps as Deciyen, dividendPerShare: q.dividendPerShare as Deciyen };
        }),
      };
    });
  // 掲示板：上場した取引対象の銘柄と「全体」の投稿。取り下げたもの・本文が引けないものは入れない
  const boards = new Set([...symbols.map((s) => s.symbol), GENERAL_BOARD]);
  const withdrawn = new Set(events.filter((e) => e.type === "content.withdrawn").map((e) => pl(e).targetSeq));
  const posts: InvestorPost[] = [];
  for (const e of events) {
    if (e.type !== "post.published" || withdrawn.has(e.seq) || !boards.has(pl(e).board as string)) continue;
    const text = c.body(pl(e).bodyHash as string);
    if (text !== null) posts.push({ seq: e.seq, agentId: pl(e).agentId as string, board: pl(e).board as string, at: e.recordedAt, text });
  }
  return { agentId: c.agentId, tradingDate: c.tradingDate, account: c.account, accountSeq: basis.seq, symbols, posts: posts.slice(-LLM_INPUT_POSTS) };
}
