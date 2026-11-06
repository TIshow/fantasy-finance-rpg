// 値をつきやすくする売買役（#113 PR-3a、MARKET_DESIGN §4）。マーケットメイカー（銘柄ごとに1つ）と、ばらばらに売買する
// 参加者（まとめて1つ）を、種類つきで登録し、上場の日に最初の株を配る。毎日の注文は、runner が AI と同じ流れ
// （agent.run → 注文票）で記録する。判断は規則（liquidity.ts）で決め、LLM は使わない。
import type { EventStore } from "../../contracts";
import { canonicalize } from "../../events/canonical";
import { sha256Hex } from "../../events/hash";
import type { LogEvent } from "../../events/types";
import { priceBand } from "../../ledger/auction";
import type { Deciyen, Order } from "../../ledger/types";
import type { DecisionInput, ListedInput, RunnerAgent } from "../day";
import { COMPANIES, type Company, fairPrice } from "./companies";
import { type LiquidityOrder, MAKER_PARAMS, NOISE_PARAMS, makerOrders, noiseOrders } from "./liquidity";

/** 最初の持ち株と現金（#113 の lead の決定）。現金は0.1円単位 */
export const ALLOTMENT = {
  /** マーケットメイカー：その銘柄を5,000株（持っていたい株数も5,000株）、現金5,000万円 */
  maker: { shares: 5_000, target: 5_000, cash: 50_000_000 * 10 },
  /** ばらばらに売買する参加者：6社をそれぞれ1,000株、現金3,000万円 */
  noise: { sharesPerCompany: 1_000, cash: 30_000_000 * 10 },
} as const;

/** 参加者の ID（登録の agentId は英小文字・数字・-・_ だけ） */
export const makerId = (symbol: string) => `mm-${symbol.toLowerCase()}`;
export const NOISE_ID = "noise";

/**
 * 上場した企業ごとのマーケットメイカーと、ばらばらに売買する参加者を登録し、最初の株を配る（shares.allotted）。
 * listCompanies のあと、同じ日（最初の板寄せの締めより前）に呼ぶ。startDate は、いまから締めがまだ来ていない最初の営業日
 * （登録の決まり。違えば保管が断り、例外になる）。済んでいる分は飛ばすので、呼び直せば続きから進む。
 * 配分は、参加者がまだ売買を始めていないときだけ書ける：あとから上場した企業を、売買を始めた参加者には配れない
 */
export async function setUpParticipants(store: EventStore, startDate: string, companies: readonly Company[] = COMPANIES, operator: `operator:${string}` = "operator:owner"): Promise<void> {
  const events: LogEvent[] = [];
  for (let page = await store.read(); page.length > 0; page = await store.read(page.at(-1)!.seq)) events.push(...page);
  const p = (e: LogEvent) => e.payload as Record<string, unknown>;
  const registered = new Map(events.filter((e) => e.type === "agent.registered").map((e) => [p(e).agentId as string, p(e)]));
  const allotted = new Set(events.filter((e) => e.type === "shares.allotted").map((e) => `${String(p(e).agentId)}:${String(p(e).symbol)}`));
  const write = async (type: "agent.registered" | "shares.allotted", payload: Record<string, unknown>) => {
    const r = await store.append({ type, actor: type === "agent.registered" ? operator : "system", refs: [], payload });
    if (!r.ok) throw new Error(`${type} ${String(payload.agentId)}: ${r.reason}`);
  };
  const register = async (agentId: string, kind: "market_maker" | "noise", initialCash: Deciyen) => {
    const r = registered.get(agentId);
    if (!r) return write("agent.registered", { agentId, displayName: agentId, kind, initialCash, startDate });
    // 同じ ID で、別の種類・現金の参加者（AI投資家など）が登録済みなら、株を配らない
    if (r.kind !== kind || r.initialCash !== initialCash) throw new Error(`agent.registered ${agentId}: already registered as ${String(r.kind ?? "investor")} with ${String(r.initialCash)}`);
  };
  const allot = async (agentId: string, symbol: string, qty: number) => {
    if (!allotted.has(`${agentId}:${symbol}`)) await write("shares.allotted", { agentId, symbol, qty });
  };
  for (const c of companies) {
    await register(makerId(c.symbol), "market_maker", ALLOTMENT.maker.cash);
    await allot(makerId(c.symbol), c.symbol, ALLOTMENT.maker.shares);
  }
  await register(NOISE_ID, "noise", ALLOTMENT.noise.cash);
  for (const c of companies) await allot(NOISE_ID, c.symbol, ALLOTMENT.noise.sharesPerCompany);
}

const refPrice = (x: ListedInput): Deciyen => x.refPrice.price;
/** 目安の価格：締めより前に発表済みの決算（直近4四半期）から fairPrice で出す。発表がまだなければ上場の価格 */
const fairOf = (company: Company, x: ListedInput): Deciyen => (x.disclosures.length > 0 ? fairPrice(company, x.disclosures.map((q, index) => ({ index, ...q }))) : x.listing.price);
/** 仮の注文の形（成行は limit: null）を、注文票の形（成行は limit を書かない）にする */
const toOrder = ({ limit, ...o }: LiquidityOrder): Order => (limit === null ? o : { ...o, limit });
/**
 * 規則の記録。注文を決める値（段の幅・株数・目標の株数・乱数のシードなど）を settings に入れ、説明の文と一緒にハッシュにする。
 * 規則の文（text）か数字（liquidity.ts の MAKER_PARAMS・NOISE_PARAMS）を変えたら、文を新しい動きに合わせて書き直し、版（version）を
 * 上げる（記録を読む人が新旧の規則を区別できるように。いまは本番の記録がないので "1" のまま。#139 の変更では文を書き直した）
 */
const ruleModel = async (modelId: string, text: string, params: Record<string, number>) => {
  const settings = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
  return {
    model: { provider: "rule", modelId, settings },
    prompt: { id: `rule-${modelId}`, version: "1", hash: await sha256Hex(new TextEncoder().encode(canonicalize({ kind: modelId, text, settings }))) },
  };
};

/**
 * 銘柄のマーケットメイカー。目安の価格は、締めより前に発表済みの決算（直近4四半期）から fairPrice で出す。
 * 発表がまだなければ上場の価格（上場の前の四半期の業績から出したもの）。取引対象にない日は注文しない
 */
export async function makerAgent(company: Company): Promise<RunnerAgent> {
  const id = makerId(company.symbol);
  const text =
    "Quote buy and sell limits around the fair price from disclosed results; lean against the inventory. " +
    "When the center is outside the daily price band, quote only the side toward the fair price at the band edge (sell at the upper limit, buy at the lower limit). " +
    "Never quote a buy that can trade against its own sell.";
  return {
    id,
    ...(await ruleModel("market-maker", text, { ...MAKER_PARAMS, target: ALLOTMENT.maker.target })),
    decide(input: DecisionInput) {
      const x = input.listed.find((l) => l.symbol === company.symbol);
      if (!x) return { orders: [], post: null, note: `${company.symbol} is not in the universe` };
      const fair = fairOf(company, x);
      const held = input.account.holdings[company.symbol]?.qty ?? 0;
      const orders = makerOrders({ symbol: company.symbol, fair, band: priceBand(refPrice(x)), held, target: ALLOTMENT.maker.target, cash: input.account.cash });
      return { orders: orders.map(toOrder), post: null, note: `fair ${fair} from ${x.disclosures.length} disclosed quarters, held ${held}` };
    },
  };
}

/** ばらばらに売買する参加者。前日の価格（値幅の基準の価格）のまわりに、固定シードの乱数で小さい注文を出す */
export async function noiseAgent(seed: number, companies: readonly Company[] = COMPANIES): Promise<RunnerAgent> {
  const text =
    "Place small random market and limit orders around the previous price with a fixed seed. " +
    "Lean toward buying when shares fall below the first allotment and toward selling when cash falls below the first cash, keeping a random part. " +
    "When the fair price from disclosed results is outside the daily price band, lean toward buying above the upper limit and selling below the lower limit instead.";
  return {
    id: NOISE_ID,
    ...(await ruleModel("noise", text, { ...NOISE_PARAMS, seed })),
    decide(input: DecisionInput) {
      const markets = input.listed.map((x) => {
        const band = priceBand(refPrice(x));
        // 値幅の端の日：マーケットメイカーと同じ決め方の目安の価格（発表済みの決算から）が、値幅の外にある銘柄。
        // マーケットメイカーの持ち株によるずれ（中心）は、ばらばらの参加者には見えないので入れない
        const company = companies.find((c) => c.symbol === x.symbol);
        const fair = company ? fairOf(company, x) : null;
        const edge = fair === null ? undefined : fair > band.upper ? ("upper" as const) : fair < band.lower ? ("lower" as const) : undefined;
        return { symbol: x.symbol, prevPrice: refPrice(x), band, ...(edge ? { edge } : {}) };
      });
      const holdings = Object.fromEntries(Object.entries(input.account.holdings).map(([s, h]) => [s, h.qty]));
      // 片寄りの基準は、記録された最初の現金と配分（コードの定数ではなく。あとから上場した企業や、配分の数字を変えたときも合うように）
      const baseline = { shares: input.start.shares, cash: input.start.cash };
      const orders = noiseOrders({ seed, tradingDate: input.tradingDate, markets, holdings, cash: input.account.cash, baseline });
      return { orders: orders.map(toOrder), post: null, note: `random orders with seed ${seed}` };
    },
  };
}

/** 企業ごとのマーケットメイカーと、ばらばらに売買する参加者（runner の agents に、AI と一緒に渡す） */
export const liquidityAgents = async (seed: number, companies: readonly Company[] = COMPANIES) => [...(await Promise.all(companies.map(makerAgent))), await noiseAgent(seed, companies)];
