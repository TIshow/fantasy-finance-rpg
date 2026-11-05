// 架空の企業6社と、四半期ごとの業績のモデル（#113 PR-1、MARKET_DESIGN §5 の段階0）。
// 社名・業種・銘柄コード・事業の説明・数字はすべて架空。銘柄コードは英字3文字＋数字1文字で、実在の銘柄コード
// （数字4桁、または数字3桁＋英字1文字）と重ならず、架空データの TST でも始まらない。
// 業績は固定シードの乱数のモデルで作る（同じシードなら同じ業績）。外部通信・時計なし。
import type { Deciyen } from "../../ledger/types";
import { mulberry32, normal, subSeed } from "./random";

export type SectorId = "electronics" | "utilities" | "software";

/** 業種の性質。成長とぶれは四半期あたりの割合、利益率は売上に対する純利益の割合 */
export interface Sector {
  id: SectorId;
  name: string;
  /** 売上の伸び（四半期あたりの平均） */
  growth: number;
  /** 売上の伸びのぶれ（四半期あたりの標準偏差） */
  growthVol: number;
  /** 利益率の平均 */
  margin: number;
  /** 利益率のぶれ（四半期ごとの標準偏差） */
  marginVol: number;
  /** 配当性向（利益のうち配当に回す割合） */
  payout: number;
  /** 最初の価格を決める株価収益率（株価が1年分の1株あたり利益の何倍か） */
  per: number;
}

export const SECTORS: Readonly<Record<SectorId, Sector>> = {
  electronics: { id: "electronics", name: "電機", growth: 0.01, growthVol: 0.04, margin: 0.06, marginVol: 0.015, payout: 0.3, per: 15 },
  utilities: { id: "utilities", name: "電力・水道", growth: 0.003, growthVol: 0.01, margin: 0.05, marginVol: 0.005, payout: 0.6, per: 12 },
  software: { id: "software", name: "ソフトウェア", growth: 0.04, growthVol: 0.08, margin: 0.12, marginVol: 0.04, payout: 0.1, per: 30 },
};

/** 架空の企業。売上は円、発行済株式数は株（100株の倍数） */
export interface Company {
  symbol: string;
  name: string;
  sector: SectorId;
  sharesOutstanding: number;
  description: string;
  /** 上場の前の四半期の売上（円） */
  baseRevenue: number;
}

export const COMPANIES: readonly Company[] = [
  { symbol: "VRN1", name: "ヴェルナ電機", sector: "electronics", sharesOutstanding: 50_000_000, description: "家庭用の電気製品を作る架空の会社", baseRevenue: 60_000_000_000 },
  { symbol: "ORS1", name: "オルセ精工", sector: "electronics", sharesOutstanding: 20_000_000, description: "工場向けの小さな部品を作る架空の会社", baseRevenue: 15_000_000_000 },
  { symbol: "MRH1", name: "ミラハ電力", sector: "utilities", sharesOutstanding: 80_000_000, description: "架空の地方で電気を売る会社", baseRevenue: 90_000_000_000 },
  { symbol: "SLN1", name: "ソルネ水道", sector: "utilities", sharesOutstanding: 10_000_000, description: "架空の町の水道を運営する会社", baseRevenue: 5_000_000_000 },
  { symbol: "QON1", name: "クオネ・ソフト", sector: "software", sharesOutstanding: 30_000_000, description: "会社向けの会計ソフトを売る架空の会社", baseRevenue: 8_000_000_000 },
  { symbol: "LPO1", name: "ラピオ・ラボ", sector: "software", sharesOutstanding: 15_000_000, description: "店の予約のアプリを運営する架空の会社", baseRevenue: 3_000_000_000 },
];

/** 1四半期の業績。売上・純利益は円、1株あたり利益と配当は0.1円単位 */
export interface Quarter {
  /** 0 が上場の前の四半期。1 から上場の後 */
  index: number;
  revenue: number;
  netIncome: number;
  eps: Deciyen;
  /** 1株あたり配当。半期（index が 2, 4, … の四半期）だけ、その半期の利益に配当性向を掛けて出す。赤字なら0 */
  dividendPerShare: Deciyen;
}

/** 0.1円単位の1株あたりの値（円の金額 ÷ 株数、四捨五入） */
const perShare = (yen: number, shares: number): Deciyen => Math.round((yen * 10) / shares);

/**
 * 企業の業績を count 四半期分作る（index 0 から）。売上は前の四半期から「業種の伸び＋ぶれ」で動き、
 * 利益率は業種の平均のまわりでぶれる（赤字もありうる）。seed と銘柄コードから企業ごとの乱数の列を作る
 */
export function quarters(seed: number, company: Company, count: number): Quarter[] {
  const sector = SECTORS[company.sector];
  const rand = mulberry32(subSeed(seed, company.symbol));
  const out: Quarter[] = [];
  let revenue = company.baseRevenue;
  for (let index = 0; index < count; index++) {
    if (index > 0) revenue = Math.max(1, Math.round(revenue * (1 + sector.growth + sector.growthVol * normal(rand))));
    const margin = sector.margin + sector.marginVol * normal(rand);
    const netIncome = Math.round(revenue * margin);
    const eps = perShare(netIncome, company.sharesOutstanding);
    // 上場の前の四半期（index 0）は配当なし。index 2, 4, … で、その半期（前の四半期と合わせた2四半期）の利益から出す
    const half = index > 0 && index % 2 === 0 ? eps + out.at(-1)!.eps : 0;
    const dividendPerShare = Math.max(0, Math.round(half * sector.payout));
    out.push({ index, revenue, netIncome, eps, dividendPerShare });
  }
  return out;
}

/**
 * 業績から決まる目安の価格（0.1円単位、1円の刻みに丸める。最低1円）。直近4四半期の1株あたり利益の合計 × 業種の株価収益率。
 * 4四半期に足りなければ、ある分を年に引き延ばす。利益が売上の1%を下回るとき（赤字を含む）は、売上の1%を利益とみなす。
 * 段階0の暫定の式（金利を入れていない）。マーケットメイカーの理論価格（PR-3）に使う前に、金利の扱いを lead と決める
 */
export function fairPrice(company: Company, recent: readonly Quarter[]): Deciyen {
  const last = recent.slice(-4);
  if (last.length === 0) throw new Error(`no quarters for ${company.symbol}`);
  const scale = 4 / last.length;
  const eps = last.reduce((a, q) => a + q.eps, 0) * scale;
  const floor = perShare(last.reduce((a, q) => a + q.revenue, 0) * scale * 0.01, company.sharesOutstanding);
  const price = SECTORS[company.sector].per * Math.max(eps, floor);
  return Math.max(10, Math.round(price / 10) * 10);
}

/** 上場した日の価格：上場の前の四半期（index 0）の業績から、fairPrice で計算する */
export function listingPrice(seed: number, company: Company): Deciyen {
  return fairPrice(company, quarters(seed, company, 1));
}
