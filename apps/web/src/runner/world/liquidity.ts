// 値をつきやすくする売買役の注文を決める関数（#113 PR-3 のうち、記録に関わらない部分。MARKET_DESIGN §4）。
// マーケットメイカー（銘柄ごとに1つ。目安の価格のまわりに、いつも買いと売りの指値を出す）と、ばらばらに売買する参加者
// （まとめて1つ。小さい数量の成行・指値を、固定シードの乱数で出す）。どちらも決まった入力から決まった注文を返す純関数で、
// 記録・時計・外部通信には触れない。注文の形は仮（core の #110 PR-2 で指値の注文票の形が決まったら合わせる）。
import { LOT, type Deciyen, type Side } from "../../ledger/types";
import { mulberry32, subSeed } from "./random";

/** 仮の注文の形：limit が null なら成行（値段を指定しない注文） */
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

/** 呼値（価格の刻み）：1円 */
const TICK: Deciyen = 10;
const floorTick = (p: number) => Math.floor(p / TICK) * TICK;
const ceilTick = (p: number) => Math.ceil(p / TICK) * TICK;
const clamp = (p: Deciyen, band: PriceBand) => Math.min(band.upper, Math.max(band.lower, p));

export interface MakerParams {
  /** 目安の価格から、1段ごとに離す幅（割合） */
  spread: number;
  /** 買いと売りの、それぞれの段の数 */
  levels: number;
  /** 1段あたりの株数（100株の倍数） */
  qtyPerLevel: number;
  /** 持ち株が目標から100株ずれるごとに、値段の中心をずらす割合 */
  skewPerLot: number;
  /** 中心をずらす割合の上限 */
  maxSkew: number;
}

export const MAKER_PARAMS: MakerParams = { spread: 0.01, levels: 3, qtyPerLevel: 100, skewPerLot: 0.002, maxSkew: 0.1 };

export interface MakerInput {
  symbol: string;
  /** 業績から計算した目安の価格（fairPrice） */
  fair: Deciyen;
  band: PriceBand;
  /** いま持っている株数と、持っていたい株数 */
  held: number;
  target: number;
  cash: Deciyen;
}

/**
 * マーケットメイカーの注文。中心は目安の価格で、持ち株が目標より多ければ下げ（売りやすく）、少なければ上げる。
 * 中心から spread ずつ離して、買いと売りの指値を levels 段ずつ出す。買いは刻みに切り下げ、売りは切り上げ、値幅の内側に収める。
 * 値幅に押しつけられて同じ値段に重なった段はまとめる。買いと売りが同じ値段に重なったら、目安の価格の側の注文だけを残す
 * （自分どうしで約定しないように。目安が値幅より上なら買い、下なら売り）。
 * 売りは持っている株数まで、買いは「指値 × 株数」の合計が現金を超えない分まで
 */
export function makerOrders(input: MakerInput, params: MakerParams = MAKER_PARAMS): LiquidityOrder[] {
  const lots = (input.held - input.target) / LOT;
  const skew = Math.max(-params.maxSkew, Math.min(params.maxSkew, lots * params.skewPerLot));
  const center = input.fair * (1 - skew);
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
  let asks = merge("sell", range.map((i) => clamp(ceilTick(center * (1 + params.spread * i)), input.band)));
  let bids = merge("buy", range.map((i) => clamp(floorTick(center * (1 - params.spread * i)), input.band)));
  // 重なったら、中心が値幅の上にあれば（安すぎる）買いを残し、それ以外は売りを残す
  if (center > input.band.upper) asks = asks.filter((a) => a.limit > (bids[0]?.limit ?? -Infinity));
  else bids = bids.filter((b) => b.limit < (asks[0]?.limit ?? Infinity));
  return [...limitQty(asks, input.held, (o) => o.qty), ...limitQty(bids, input.cash, (o) => o.qty * o.limit)];
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
  /** 指値を前日の価格から離す幅の上限（割合） */
  maxOffset: number;
}

export const NOISE_PARAMS: NoiseParams = { chance: 0.6, maxQty: 300, marketShare: 0.3, maxOffset: 0.03 };

export interface NoiseInput {
  /** 世界のシードと約定日（日ごとに別の乱数の列になる） */
  seed: number;
  tradingDate: string;
  /** 銘柄ごとの前日の価格と値幅（銘柄コードの昇順に並べて使う） */
  markets: readonly { symbol: string; prevPrice: Deciyen; band: PriceBand }[];
  holdings: Readonly<Record<string, number>>;
  cash: Deciyen;
}

/**
 * ばらばらに売買する参加者の注文。銘柄ごとに、chance の確率で1注文。売り買いは半々、株数は100株〜maxQty。
 * 成行か、前日の価格から ±maxOffset の中の指値（刻みに丸め、値幅の内側に収める）。
 * 売りは持っている株数まで（持っていなければ出さない）。買いの現金は「指値（成行は値幅の上限）× 株数」で、銘柄の順に確かめる
 */
export function noiseOrders(input: NoiseInput, params: NoiseParams = NOISE_PARAMS): LiquidityOrder[] {
  const rand = mulberry32(subSeed(input.seed, `noise:${input.tradingDate}`));
  const out: LiquidityOrder[] = [];
  let cash = input.cash;
  for (const m of [...input.markets].sort((a, b) => (a.symbol < b.symbol ? -1 : 1))) {
    // 乱数は銘柄ごとに同じ数だけ引く（注文を出さない銘柄があっても、後ろの銘柄の乱数がずれないように）
    const [act, side, size, kind, offset] = [rand(), rand(), rand(), rand(), rand()];
    if (act >= params.chance) continue;
    const s: Side = side < 0.5 ? "buy" : "sell";
    let qty = (1 + Math.floor(size * (params.maxQty / LOT))) * LOT;
    const limit = kind < params.marketShare ? null : clamp(Math.round((m.prevPrice * (1 + params.maxOffset * (2 * offset - 1))) / TICK) * TICK, m.band);
    if (s === "sell") qty = Math.min(qty, Math.floor((input.holdings[m.symbol] ?? 0) / LOT) * LOT);
    else qty = Math.min(qty, Math.floor(cash / ((limit ?? m.band.upper) * LOT)) * LOT);
    if (qty <= 0) continue;
    if (s === "buy") cash -= (limit ?? m.band.upper) * qty;
    out.push({ symbol: m.symbol, side: s, qty, limit });
  }
  return out;
}
