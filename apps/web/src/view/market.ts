// 架空の市場の記録（上場・板寄せの結果・決算の発表）から、銘柄ごとの値段の推移・出来高・決算の一覧を作る（#126）。
// 記録を写して並べるだけ。価格がつかなかった日は「値つかず」とし、数字を作らない（前の価格は、記録にある直近の値をそのまま添える）。
import type { LogEvent } from "../events/types";
import type { Deciyen } from "../ledger/types";
import { formatJst, formatJstShort, formatMonthDay, formatPeriod, formatPlainYen, formatYenMark } from "./format";

export const NO_PRICE_TEXT = "値つかず";
const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export interface ListingView {
  symbol: string;
  name: string;
  sector: string;
  sharesText: string;
  /** 上場のときの最初の価格 */
  listedPrice: Deciyen;
  listedPriceText: string;
  /** 上場の記録の日（日本時間 "11/04"） */
  listedOn: string;
}

export interface AuctionDay {
  seq: number;
  date: string;
  dateText: string;
  /** 価格がつかなかった日は null */
  price: Deciyen | null;
  priceText: string;
  volume: number;
  volumeText: string;
  /** 価格がつかなかった日に評価に使われる、直近の価格（記録にある値）。価格がついた日は null */
  carriedText: string | null;
  /** その価格を借りた記録（company.listed か、価格のついた auction.cleared）の seq。評価の記録の priceSeq と同じになる */
  carriedSeq: number | null;
}

export interface DisclosureView {
  seq: number;
  atText: string;
  periodText: string;
  revenueText: string;
  netIncomeText: string;
  epsText: string;
  dividendText: string;
}

export interface CompanyMarket {
  listing: ListingView;
  /** 板寄せの日の順（古い日から） */
  days: AuctionDay[];
  /** 最新が先 */
  disclosures: DisclosureView[];
}

export interface MarketView {
  /** 銘柄コード順 */
  companies: CompanyMarket[];
}

type P = Record<string, any>; // 連鎖の検査を通ったイベントの中身

export function buildMarket(events: readonly LogEvent[]): MarketView {
  const companies = new Map<string, CompanyMarket>();
  // 直近の価格とその記録の seq（台帳の priceOnOrBefore と同じ規則：上場の価格から始め、価格のついた板寄せで更新する）
  const lastPrice = new Map<string, { price: Deciyen; seq: number }>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const p = e.payload as P;
    switch (e.type) {
      case "company.listed":
        companies.set(p.symbol, {
          listing: { symbol: p.symbol, name: p.name, sector: p.sector, sharesText: `${group(p.sharesOutstanding)}株`, listedPrice: p.price, listedPriceText: formatYenMark(p.price), listedOn: formatMonthDay(formatJst(e.recordedAt).slice(0, 10)) },
          days: [],
          disclosures: [],
        });
        lastPrice.set(p.symbol, { price: p.price, seq: e.seq });
        break;
      case "auction.cleared": {
        const c = companies.get(p.symbol);
        if (!c) break;
        const price: Deciyen | null = p.price;
        const carried = price === null ? (lastPrice.get(p.symbol) ?? null) : null;
        if (price !== null) lastPrice.set(p.symbol, { price, seq: e.seq });
        c.days.push({
          seq: e.seq, date: p.date, dateText: formatMonthDay(p.date), price, priceText: price === null ? NO_PRICE_TEXT : formatYenMark(price),
          volume: p.volume, volumeText: `${group(p.volume)}株`, carriedText: carried === null ? null : formatYenMark(carried.price), carriedSeq: carried?.seq ?? null,
        });
        break;
      }
      case "company.disclosed": {
        const c = companies.get(p.symbol);
        if (!c) break;
        c.disclosures.unshift({ seq: e.seq, atText: formatJstShort(e.recordedAt), periodText: formatPeriod(p.period), revenueText: formatPlainYen(p.revenue), netIncomeText: formatPlainYen(p.netIncome), epsText: formatYenMark(p.eps), dividendText: formatYenMark(p.dividendPerShare) });
        break;
      }
    }
  }
  return { companies: [...companies.values()].sort((a, b) => (a.listing.symbol < b.listing.symbol ? -1 : a.listing.symbol > b.listing.symbol ? 1 : 0)) };
}
