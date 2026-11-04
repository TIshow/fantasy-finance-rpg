// 規則で動く仮のAI 3体（#27 PR-2）。LLM は呼ばず、runner が渡した入力（記録済みの終値と口座）だけで判断する。
// 先読みの防止は runner が入力を固定することで守る（ここは渡されたものしか見ない）。値は 0.1円単位の整数のまま扱う。
import { canonicalize } from "../events/canonical";
import { sha256Hex } from "../events/hash";
import { LOT, type Deciyen, type Order } from "../ledger/types";
import type { Decision, DecisionInput, RunnerAgent } from "./day";

type Rule = (input: DecisionInput, series: (symbol: string) => Deciyen[]) => { orders: Order[]; reason: string };

/** 銘柄の一覧（入力の終値に出てきたもの。昇順） */
const symbolsOf = (input: DecisionInput) => [...new Set(input.closes.flatMap((c) => Object.keys(c.prices)))].sort();
const held = (input: DecisionInput, symbol: string) => input.account.holdings[symbol]?.qty ?? 0;
const sellAll = (input: DecisionInput, symbol: string): Order => ({ symbol, side: "sell", qty: held(input, symbol) });

/** 買える分だけ（直近の終値で見積もる。約定は始値なので、足りなければ保管と台帳が断る） */
function buys(input: DecisionInput, wanted: { symbol: string; price: Deciyen }[]): Order[] {
  let cash = input.account.cash;
  const out: Order[] = [];
  for (const { symbol, price } of wanted) {
    if (price * LOT > cash) continue;
    cash -= price * LOT;
    out.push({ symbol, side: "buy", qty: LOT });
  }
  return out;
}

/** 5日移動平均：直近の終値が平均より上で持っていなければ1単元買う、下で持っていれば全部売る */
const movingAverage: Rule = (input, series) => {
  const sells: Order[] = [];
  const wanted: { symbol: string; price: Deciyen }[] = [];
  for (const s of symbolsOf(input)) {
    const xs = series(s).slice(-5);
    if (xs.length < 5) continue;
    const last = xs.at(-1)!;
    const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (last > avg && held(input, s) === 0) wanted.push({ symbol: s, price: last });
    if (last < avg && held(input, s) > 0) sells.push(sellAll(input, s));
  }
  return { orders: [...sells, ...buys(input, wanted)], reason: "5-day moving average" };
};

/** 逆張り：前の日から2%以上下げたら1単元買い、2%以上上げて持っていれば全部売る */
const reversal: Rule = (input, series) => {
  const sells: Order[] = [];
  const wanted: { symbol: string; price: Deciyen }[] = [];
  for (const s of symbolsOf(input)) {
    const [before, last] = series(s).slice(-2);
    if (before === undefined || last === undefined) continue;
    // 2% は整数で比べる（100 * 差 と 2 * 前の値）
    if (100 * (last - before) <= -2 * before) wanted.push({ symbol: s, price: last });
    if (100 * (last - before) >= 2 * before && held(input, s) > 0) sells.push(sellAll(input, s));
  }
  return { orders: [...sells, ...buys(input, wanted)], reason: "2% reversal" };
};

/** 持ち続ける：何も持っていなければ、全銘柄を1単元ずつ買い、あとは売買しない（比べるための基準） */
const buyAndHold: Rule = (input, series) => {
  if (Object.values(input.account.holdings).some((h) => h.qty > 0)) return { orders: [], reason: "hold" };
  const wanted = symbolsOf(input).flatMap((s) => {
    const last = series(s).at(-1);
    return last === undefined ? [] : [{ symbol: s, price: last }];
  });
  return { orders: buys(input, wanted), reason: "buy and hold" };
};

const RULES: Record<string, { rule: Rule; text: string }> = {
  ma5: { rule: movingAverage, text: "Buy one lot when the last close is above the 5-day average; sell all when below." },
  reversal: { rule: reversal, text: "Buy one lot after a 2% drop; sell all after a 2% rise." },
  hold: { rule: buyAndHold, text: "Buy one lot of every symbol once, then hold." },
};

/** 判断から、投稿（注文のあった日だけ、最初の注文の銘柄の板に）を作る */
function toDecision(id: string, input: DecisionInput, orders: Order[], reason: string): Decision {
  const first = orders[0];
  const text = first ? `${id}: ${orders.map((o) => `${o.side} ${o.symbol} ${o.qty}`).join(", ")} (${reason})` : "";
  return { orders, post: first ? { board: first.symbol, text } : null, note: `${reason} on ${input.tradingDate}` };
}

/**
 * 規則のAIを作る。id は agentId（登録と同じ）、kind は規則。model.provider は "rule"。
 * プロンプトのハッシュは規則の説明文のハッシュ（規則を変えたら版を上げる）
 */
export async function ruleAgent(id: string, kind: keyof typeof RULES): Promise<RunnerAgent> {
  const { rule, text } = RULES[kind]!;
  const hash = await sha256Hex(new TextEncoder().encode(canonicalize({ kind, text })));
  return {
    id,
    model: { provider: "rule", modelId: kind, settings: {} },
    prompt: { id: `rule-${kind}`, version: "1", hash },
    decide(input) {
      const series = (symbol: string) => input.closes.flatMap((c) => (typeof c.prices[symbol] === "number" ? [c.prices[symbol] as Deciyen] : []));
      const { orders, reason } = rule(input, series);
      return toDecision(id, input, orders, reason);
    },
  };
}

/** 3種の規則のAI（ai-ma5・ai-reversal・ai-hold） */
export const ruleAgents = () => Promise.all([ruleAgent("ai-ma5", "ma5"), ruleAgent("ai-reversal", "reversal"), ruleAgent("ai-hold", "hold")]);
