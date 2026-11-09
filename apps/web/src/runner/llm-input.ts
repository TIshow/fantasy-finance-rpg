// LLM の AI 投資家に渡す入力の値を、記録から集める（#179）。
// 使うのは、依頼の予約（llm.batch.submitted）を書く前の記録だけ（events に渡すのは、その前までの記録。念のため、予約の時刻より
// あとに記録したものも外す）。依頼は前の取引日（prev）の引けのあとに作るので、値段は取引日より前の板寄せ、決算は締めより前に
// 記録した発表、掲示板はそれまでの投稿だけになる。
// 受け取り（その夜か翌朝）では、同じ記録（予約より前）から同じ値を作り直し、送った本文のハッシュと比べる（作り直しても同じであることを確かめる）。
import type { LogEvent } from "../events/types";
import { cutoffOf } from "../ledger/ledger";
import type { Account, Deciyen } from "../ledger/types";
import { GENERAL_BOARD, type InvestorInput, type InvestorPost, type InvestorSymbol } from "../llm/investor-prompt";

/** 値段の推移の日数（新しい方から）・決算の四半期の数・投稿の数の上限。入力の文が長すぎれば、さらに削る（investorMarketText） */
export const LLM_INPUT_DAYS = 20;
export const LLM_INPUT_QUARTERS = 4;
export const LLM_INPUT_POSTS = 40;

type Payload = Record<string, unknown>;
const pl = (e: LogEvent) => e.payload as Payload;

export interface InvestorInputContext {
  agentId: string;
  tradingDate: string;
  /** 取引日の前の取引日（この日の引け後の処理のあとに依頼を作る） */
  prev: string;
  /** 予約の時刻（UNIXミリ秒）。これよりあとに記録したものは使わない */
  submittedAt: number;
  /** いまの口座（台帳の写し）。予約より前の、最後の引け後の処理のあとの口座 */
  account: Account;
  /** 本文のハッシュから本文を引く（消した本文・ないものは null） */
  body: (hash: string) => string | null;
}

/**
 * 予約より前の記録 events から、入力の値を集める。口座の根拠は、そのAIの最後の引け後の処理（まだなければ登録）。
 * 次のときは RangeError（依頼を作らない）：登録がない、prev の板寄せの結果がそろっていない、開始日が取引日より前なのに
 * prev の引け後の処理がない、根拠のあとにそのAIの約定がある（口座の根拠が古い）
 */
export function investorInputOf(all: readonly LogEvent[], c: InvestorInputContext): InvestorInput {
  const events = all.filter((e) => e.recordedAt <= c.submittedAt);
  const registered = events.find((e) => e.type === "agent.registered" && pl(e).agentId === c.agentId);
  if (!registered) throw new RangeError(`agent ${c.agentId} is not registered`);
  const mine = (type: LogEvent["type"]) => events.filter((e) => e.type === type && pl(e).agentId === c.agentId);
  const basis = mine("corporate_actions.applied").at(-1) ?? registered;
  if ((pl(registered).startDate as string) < c.tradingDate && (basis === registered || pl(basis).asOf !== c.prev)) throw new RangeError(`the post-close of ${c.prev} is not done for ${c.agentId}`);
  if (mine("fills.executed").some((e) => e.seq > basis.seq)) throw new RangeError(`fills after the account basis for ${c.agentId}`);
  // 口座の元：登録・最初の配分・根拠と、根拠のあとの台帳の調整（いまの口座に入っている）
  const allotted = mine("shares.allotted");
  const adjusted = mine("ledger.adjusted").filter((e) => e.seq > basis.seq);
  const accountSeqs = [registered.seq, ...allotted.map((e) => e.seq), basis.seq, ...adjusted.map((e) => e.seq)];

  const universe = new Set((events.filter((e) => e.type === "universe.set").at(-1)?.payload as { symbols?: string[] } | undefined)?.symbols ?? []);
  const prevClosed = events.some((e) => e.type === "market.closed" && pl(e).date === c.prev);
  const symbols: InvestorSymbol[] = events
    .filter((e) => e.type === "company.listed" && universe.has(pl(e).symbol as string))
    .sort((x, y) => ((pl(x).symbol as string) < (pl(y).symbol as string) ? -1 : 1))
    .map((listing) => {
      const symbol = pl(listing).symbol as string;
      const before = events.filter((e) => e.type === "auction.cleared" && pl(e).symbol === symbol && (pl(e).date as string) < c.tradingDate);
      // prev に板寄せがあるはずの銘柄（prev の締めより前に上場し、prev が臨時休場でない）は、その結果がそろうまで作らない
      if (!prevClosed && listing.recordedAt < cutoffOf(c.prev) && !before.some((e) => pl(e).date === c.prev)) throw new RangeError(`the auction of ${symbol} on ${c.prev} is not recorded`);
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
  // 掲示板：上場した取引対象の銘柄と「全体」の投稿。取り下げたもの・本文が引けないものは入れない。
  // 訂正（correction.issued）があれば、seq が最大の訂正の本文を使い、訂正済みと示す（EVENT_LOG §3.4・§6.1）。seq が最大の訂正が読めなければ外す。
  // 訂正の中身の形（#179 の lead の決定。記録の検査は core の append.ts）：訂正する対象は targetSeq の1件だけで、読めるのは
  // 「種類が post・対象 targetSeq が投稿・新しい本文が newBodyHash」の形だけ。refs のほかの投稿は引用で、外さず、ふつうに出す。
  // 投稿を指している（targetSeq が投稿か、読める targetSeq がなければ refs のどれかが投稿の seq）のに形が読めない訂正があれば、安全側に倒して
  // その投稿を入力から外す（訂正前の本文を印なしで渡さない）。外した数は文に書く
  const boards = new Set([...symbols.map((s) => s.symbol), GENERAL_BOARD]);
  const withdrawn = new Set(events.filter((e) => e.type === "content.withdrawn").map((e) => pl(e).targetSeq));
  const postSeqs = new Set(events.filter((e) => e.type === "post.published").map((e) => e.seq));
  const isPost = (seq: unknown) => typeof seq === "number" && postSeqs.has(seq);
  // 投稿ごとに、seq が最大の訂正だけが効く（EVENT_LOG §3.4）。記録の順に見て、読める訂正と読めない訂正のどちらかに置き換える
  const corrections = new Map<number, LogEvent>();
  const unreadable = new Map<number, LogEvent>();
  for (const e of [...events].sort((x, y) => x.seq - y.seq)) {
    if (e.type !== "correction.issued") continue;
    const q = pl(e);
    const target = q.targetSeq;
    if (q.kind === "post" && typeof target === "number" && isPost(target) && typeof q.newBodyHash === "string") {
      corrections.set(target, e);
      unreadable.delete(target);
      continue;
    }
    // 投稿を指しているのに読めない訂正：targetSeq が投稿ならその投稿だけ。入力データの訂正（kind が input）なら、refs の投稿は引用なので外さない。
    // それ以外（targetSeq が数でない・投稿でない）は、refs のうち投稿のものを外す
    const pointed = typeof target === "number" && (isPost(target) || q.kind === "input") ? [target] : e.refs;
    for (const seq of pointed) {
      if (!isPost(seq)) continue;
      unreadable.set(seq, e);
      corrections.delete(seq);
    }
  }
  // 新しい方から40件（外す投稿も1件と数える）を選んでから、外すものと入れるものに分ける
  const shown: (InvestorPost | { postSeq: number; correctionSeq: number })[] = [];
  for (const e of events) {
    if (e.type !== "post.published" || withdrawn.has(e.seq) || !boards.has(pl(e).board as string)) continue;
    const bad = unreadable.get(e.seq);
    if (bad) {
      shown.push({ postSeq: e.seq, correctionSeq: bad.seq });
      continue;
    }
    const fix = corrections.get(e.seq);
    const text = c.body((fix ? pl(fix).newBodyHash : pl(e).bodyHash) as string);
    if (text === null) continue;
    shown.push({ seq: e.seq, agentId: pl(e).agentId as string, board: pl(e).board as string, at: e.recordedAt, text, ...(fix ? { correctionSeq: fix.seq } : {}) });
  }
  const recent = shown.slice(-LLM_INPUT_POSTS);
  const posts = recent.filter((x): x is InvestorPost => "seq" in x);
  const withheld = recent.filter((x): x is { postSeq: number; correctionSeq: number } => "postSeq" in x);
  return { agentId: c.agentId, tradingDate: c.tradingDate, account: c.account, accountSeq: basis.seq, accountSeqs, symbols, posts, ...(withheld.length > 0 ? { withheld } : {}) };
}
