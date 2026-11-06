// 値をつきやすくする売買役の注文を決める関数（#113 PR-3 のうち、記録に関わらない部分。MARKET_DESIGN §4）。
// マーケットメイカー（銘柄ごとに1つ。目安の価格のまわりに、いつも買いと売りの指値を出す）と、ばらばらに売買する参加者
// （まとめて1つ。小さい数量の成行・指値を、固定シードの乱数で出す）。どちらも決まった入力から決まった注文を返す純関数で、
// 記録・時計・外部通信には触れない。成行は limit: null で返し、注文票の形には participants.ts で直す。
import { TICK } from "../../ledger/auction";
import { LOT, type Deciyen, type Side } from "../../ledger/types";
import { mulberry32, subSeed } from "./random";

/** 注文の形：limit が null なら成行（値段を指定しない注文） */
export interface LiquidityOrder {
  symbol: string;
  side: Side;
  qty: number;
  limit: Deciyen | null;
}

/** その日に約定できる価格の範囲（値幅の下限と上限。計算は core の板寄せの規則に任せ、ここでは受け取る） */
export interface PriceBand {
  lower: Deciyen;
  upper: Deciyen;
}

/** 割合は基点（1万分の1）の整数で持つ。価格の計算を整数で行い、丸めの誤差で刻みがずれないように */
const BP = 10_000;
const clamp = (p: Deciyen, band: PriceBand) => Math.min(band.upper, Math.max(band.lower, p));

/** 入力の検査。価格・株数・現金が安全な整数で、値幅が刻みに合っていて下限 ≦ 上限 */
function checkBand(band: PriceBand) {
  if (!Number.isSafeInteger(band.lower) || !Number.isSafeInteger(band.upper) || band.lower < TICK || band.lower > band.upper || band.lower % TICK !== 0 || band.upper % TICK !== 0) throw new Error(`invalid band ${band.lower}-${band.upper}`);
}
const checkCount = (name: string, v: number) => {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`invalid ${name}: ${v}`);
};
const checkLots = (name: string, v: number) => {
  if (!Number.isSafeInteger(v) || v <= 0 || v % LOT !== 0) throw new Error(`${name} must be a positive multiple of ${LOT}`);
};

export interface MakerParams {
  /** 目安の価格から、1段ごとに離す幅（基点。100 = 1%） */
  spreadBp: number;
  /** 買いと売りの、それぞれの段の数 */
  levels: number;
  /** 1段あたりの株数（100株の倍数） */
  qtyPerLevel: number;
  /** 持ち株が目標から100株ずれるごとに、値段の中心をずらす幅（基点） */
  skewPerLotBp: number;
  /** 中心をずらす幅の上限（基点）。段の幅 × 段の数まで（目安から大きく離れた値段を出し続けないように） */
  maxSkewBp: number;
}

export const MAKER_PARAMS: MakerParams = { spreadBp: 50, levels: 3, qtyPerLevel: 300, skewPerLotBp: 20, maxSkewBp: 150 };

export interface MakerInput {
  symbol: string;
  /**
   * 業績から計算した目安の価格（fairPrice）。その日の締めの時点で開示済みの四半期だけから計算したものを渡す
   * （まだ開示していない業績を入れると、決算の前に気配と価格が動き、先読みになる）
   */
  fair: Deciyen;
  band: PriceBand;
  /** いま持っている株数と、持っていたい株数 */
  held: number;
  target: number;
  cash: Deciyen;
}

/**
 * マーケットメイカーの注文。中心は目安の価格で、持ち株が目標より多ければ下げ（売りやすく）、少なければ上げる。
 * 中心から spreadBp ずつ離して、買いと売りの指値を levels 段ずつ出す。買いは刻みに切り下げ、売りは切り上げ、値幅の内側に収める。
 * 値幅に押しつけられて同じ値段に重なった段はまとめる。中心が値幅の内側で、買いと売りが同じ値段に重なったら、買いを外す
 * （自分どうしで約定しないように）。中心が値幅の外なら、値幅の端の値段で売りと買いの両方を出す（その日に値段がつくように）。
 * 売りは持っている株数まで（重なりを確かめる前に減らす）。買いは「指値 × 株数」の合計が現金を超えない分まで、目安に近い段から（足りない段は飛ばし、安い段を出す）
 */
export function makerOrders(input: MakerInput, params: MakerParams = MAKER_PARAMS): LiquidityOrder[] {
  checkBand(input.band);
  for (const [k, v] of [["fair", input.fair], ["held", input.held], ["target", input.target], ["cash", input.cash]] as const) checkCount(k, v);
  checkLots("qtyPerLevel", params.qtyPerLevel);
  const lots = Math.trunc((input.held - input.target) / LOT);
  const skewBp = Math.max(-params.maxSkewBp, Math.min(params.maxSkewBp, lots * params.skewPerLotBp));
  const center = Math.round((input.fair * (BP - skewBp)) / BP);
  // center × (BP ± 段の幅) は整数。刻み（TICK × BP）で割って切り上げ・切り下げる
  const at = (i: number, sign: 1 | -1) => center * (BP + sign * params.spreadBp * i);
  const merge = (side: Side, prices: Deciyen[]) => {
    const out: { price: Deciyen; qty: number }[] = [];
    for (const price of prices) {
      const last = out.at(-1);
      if (last?.price === price) last.qty += params.qtyPerLevel;
      else out.push({ price, qty: params.qtyPerLevel });
    }
    return out.map((x) => ({ symbol: input.symbol, side, qty: x.qty, limit: x.price }));
  };
  const range = Array.from({ length: params.levels }, (_, i) => i + 1);
  // 中心が値幅の外なら（#139 の lead の決定）、すべての段を値幅の端の値段に置き、売りと買いの両方を出す。上の外なら上限、
  // 下の外なら下限で、自分の売りと買いが当たるので、その日に必ず値段がつき、値段は毎日値幅いっぱいずつ目安に近づく
  // （ストップ高・安が続く動き）
  const edge = center > input.band.upper ? input.band.upper : center < input.band.lower ? input.band.lower : null;
  let asks = merge("sell", range.map((i) => edge ?? clamp(Math.ceil(at(i, 1) / (TICK * BP)) * TICK, input.band)));
  let bids = merge("buy", range.map((i) => edge ?? clamp(Math.floor(at(i, -1) / (TICK * BP)) * TICK, input.band)));
  // 売りは先に持ち株で減らす（売れない売りのために買いを外さないように）
  asks = limitQty(asks, input.held, (o) => o.qty);
  // 中心が値幅の内側なら、重なった段は外す（自分どうしで約定しないように）
  if (edge === null) bids = bids.filter((b) => b.limit < (asks[0]?.limit ?? Infinity));
  return [...asks, ...limitQty(bids, input.cash, (o) => o.qty * o.limit)];
}

/** 前から順に、合計が budget を超えない分まで残す。超える注文は100株単位で減らし、0株なら落とす */
function limitQty<T extends LiquidityOrder>(orders: T[], budget: number, cost: (o: T) => number): T[] {
  const out: T[] = [];
  let left = budget;
  for (const o of orders) {
    const perLot = cost({ ...o, qty: LOT });
    const lotsAffordable = perLot > 0 ? Math.floor(left / perLot) : 0;
    const qty = Math.min(o.qty, lotsAffordable * LOT);
    if (qty <= 0) continue;
    out.push({ ...o, qty });
    left -= cost({ ...o, qty });
  }
  return out;
}

export interface NoiseParams {
  /** 1銘柄・1日あたり、注文を出す確率 */
  chance: number;
  /** 1注文の株数の上限（100株の倍数） */
  maxQty: number;
  /** 成行にする確率（残りは指値） */
  marketShare: number;
  /** 指値を前日の価格から離す幅の上限（基点） */
  maxOffsetBp: number;
  /**
   * 売りと買いの片寄り（#139）。買いの確率 = 0.5 + tilt ×（株の減り方 − 現金の減り方）。減り方は、最初の持ち株・現金に対する
   * 減った割合（増えていれば負）。株が減れば買いを多く、現金が減れば売りを多くする
   */
  tilt: number;
  /** 買いの確率の下限（上限は 1 − これ）。乱数で決める部分を残す */
  minBuyChance: number;
}

export const NOISE_PARAMS: NoiseParams = { chance: 1, maxQty: 300, marketShare: 0.95, maxOffsetBp: 300, tilt: 1, minBuyChance: 0.1 };

export interface NoiseInput {
  /** 世界のシードと約定日（日ごとに別の乱数の列になる） */
  seed: number;
  tradingDate: string;
  /** 銘柄ごとの前日の価格と値幅（銘柄コードの昇順に並べて使う） */
  markets: readonly { symbol: string; prevPrice: Deciyen; band: PriceBand }[];
  holdings: Readonly<Record<string, number>>;
  cash: Deciyen;
  /** 最初の持ち株（銘柄ごと）と現金。売りと買いの片寄りの基準。省けば片寄らせない。最初の持ち株がない銘柄は、株の減り方を0とみなす */
  baseline?: { shares: Readonly<Record<string, number>>; cash: Deciyen };
}

/** 買いの確率：最初の持ち株・現金からの減り方で片寄らせ、[minBuyChance, 1 − minBuyChance] に収める */
function buyChance(input: NoiseInput, symbol: string, cash: Deciyen, params: NoiseParams): number {
  const b = input.baseline;
  if (!b || b.cash <= 0) return 0.5;
  const base = Object.hasOwn(b.shares, symbol) ? b.shares[symbol]! : 0;
  const sharesDown = base > 0 ? (base - (input.holdings[symbol] ?? 0)) / base : 0;
  const cashDown = (b.cash - cash) / b.cash;
  return Math.min(1 - params.minBuyChance, Math.max(params.minBuyChance, 0.5 + params.tilt * (sharesDown - cashDown)));
}

/**
 * ばらばらに売買する参加者の注文。銘柄ごとに、chance の確率で1注文。売り買いは半々、株数は100株〜maxQty。
 * 成行か、前日の価格から ±maxOffsetBp の中の指値（刻みに丸め、値幅の内側に収める）。乱数の列は銘柄ごとに分ける
 * （銘柄が増えても減っても、ほかの銘柄の注文は変わらない）。売りは持っている株数まで（持っていなければ出さない）。
 * 買いの現金は「指値（成行は値幅の上限）× 株数」で、銘柄コードの順に確かめる
 */
export function noiseOrders(input: NoiseInput, params: NoiseParams = NOISE_PARAMS): LiquidityOrder[] {
  checkCount("cash", input.cash);
  checkLots("maxQty", params.maxQty);
  const markets = [...input.markets].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  markets.forEach((m, i) => {
    if (i > 0 && markets[i - 1]!.symbol === m.symbol) throw new Error(`duplicate market ${m.symbol}`);
    checkBand(m.band);
    checkCount("prevPrice", m.prevPrice);
  });
  const out: LiquidityOrder[] = [];
  let cash = input.cash;
  for (const m of markets) {
    const rand = mulberry32(subSeed(input.seed, `noise:${input.tradingDate}:${m.symbol}`));
    if (rand() >= params.chance) continue;
    const side: Side = rand() < buyChance(input, m.symbol, cash, params) ? "buy" : "sell";
    let qty = (1 + Math.floor(rand() * (params.maxQty / LOT))) * LOT;
    const isMarket = rand() < params.marketShare;
    const offsetBp = Math.round((2 * rand() - 1) * params.maxOffsetBp);
    const limit = isMarket ? null : clamp(Math.round((m.prevPrice * (BP + offsetBp)) / (BP * TICK)) * TICK, m.band);
    if (side === "sell") qty = Math.min(qty, Math.floor((input.holdings[m.symbol] ?? 0) / LOT) * LOT);
    else qty = Math.min(qty, Math.floor(cash / ((limit ?? m.band.upper) * LOT)) * LOT);
    if (qty <= 0) continue;
    if (side === "buy") cash -= (limit ?? m.band.upper) * qty;
    out.push({ symbol: m.symbol, side, qty, limit });
  }
  return out;
}
