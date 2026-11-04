// ゴールデンログの元になる架空のシナリオ：架空の銘柄3つ・架空のAI3体・前営業日と5営業日分の始値・終値・出来高、
// AIごとの注文と投稿の計画。実在の企業・実データ・外部通信は含まない。同じシードなら同じ結果になる。
// 観測の publishedAt・fetchedAt は、その時点に整合する値（publishedAt <= fetchedAt）。取り込みが遅れる日も1日入れる。
// イベントの組み立て（投稿→注文票の確定→約定→引け後処理→評価）は、このシナリオを使う別のPRで行う。
import type { PriceObservation } from "../../src/contracts";
import type { Order } from "../../src/ledger/types";
import { LOT } from "../../src/ledger/types";
import { mulberry32, pick, randInt } from "./prng";

/** 架空の銘柄コード（実在しない）。基準の株価（円）は始まりの値 */
export const SYMBOLS = ["TSTA", "TSTB", "TSTC"] as const;
const BASE_YEN: Record<string, number> = { TSTA: 1200, TSTB: 2500, TSTC: 800 };

export const AGENTS = [
  { id: "ai-a", name: "テストAI・あ" },
  { id: "ai-b", name: "テストAI・い" },
  { id: "ai-c", name: "テストAI・う" },
] as const;

/**
 * 判断の入力に使うだけの前営業日と、5営業日分の取引日（月〜金、祝日なし）。AIは PRIOR_DAY の終値の記録より後に登録し、
 * 開始日は TRADING_DAYS[0]。PRIOR_DAY は評価しない日になる（口座の基準日が PRIOR_DAY のため）
 */
export const PRIOR_DAY = "2026-11-06";
export const TRADING_DAYS = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"] as const;
/** 終値の取り込みが翌日の未明まで遅れる日 */
export const LATE_DAY = "2026-11-11";

export interface AgentPlan {
  agentId: string;
  /** 約定させる営業日 */
  tradingDate: string;
  /** 判断した日（前の営業日。その日の終値までを入力に使える） */
  decidedOn: string;
  /**
   * 判断（投稿・注文票の確定）の時刻。decidedOn の全銘柄の終値を取り込んだ後、かつ約定日の締め（8:30）より前。
   * 通常は decidedOn の 21:00、終値の取り込みが遅れた日は、取り込みの30分後
   */
  decideAt: number;
  orders: Order[];
  /** 投稿（銘柄と本文）。ない日は null */
  post: { symbol: string; text: string } | null;
}

export interface Scenario {
  seed: number;
  symbols: readonly string[];
  agents: readonly { id: string; name: string }[];
  priorDay: string;
  tradingDays: readonly string[];
  lateDay: string;
  /** 前営業日と取引日の、銘柄ごとの始値・終値（公開時刻の昇順ではなく、日・銘柄・種類の順） */
  observations: PriceObservation[];
  plans: AgentPlan[];
}

/** 日本時間の日時（UNIXミリ秒） */
const at = (date: string, hh: number, mm = 0, ss = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}+09:00`);
const nextCalendarDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** 円を 0.1円単位にする */
const deci = (yen: number) => yen * 10;

export function buildScenario(seed: number): Scenario {
  const rand = mulberry32(seed);
  const days = [PRIOR_DAY, ...TRADING_DAYS];
  const observations: PriceObservation[] = [];
  const closeYen: Record<string, number[]> = {};

  for (const date of days) {
    for (const symbol of SYMBOLS) {
      const prev = closeYen[symbol]?.at(-1) ?? BASE_YEN[symbol]!;
      const open = Math.max(1, Math.round(prev * (1 + (rand() - 0.5) * 0.03)));
      const close = Math.max(1, Math.round(open * (1 + (rand() - 0.5) * 0.04)));
      (closeYen[symbol] ??= []).push(close);
      const delay = () => randInt(rand, 5, 120) * 1000; // 取り込みは公開の5〜120秒後
      const openAt = at(date, 9);
      const closeAt = at(date, 15, 30);
      observations.push({ symbol, date, kind: "open", price: deci(open), publishedAt: openAt, fetchedAt: openAt + delay(), source: "fixture:synthetic" });
      observations.push({
        symbol,
        date,
        kind: "close",
        price: deci(close),
        volume: randInt(rand, 100, 5000) * LOT,
        publishedAt: closeAt,
        fetchedAt: date === LATE_DAY ? at(nextCalendarDay(date), 3) : closeAt + delay(),
        source: "fixture:synthetic",
      });
    }
  }

  // 注文と投稿の計画。保有を数えながら作り、売りは保有の範囲に収める（現金は 1 日 1 注文・最大 200 株で足りる）
  const held: Record<string, Record<string, number>> = Object.fromEntries(AGENTS.map((a) => [a.id, {}]));
  const plans: AgentPlan[] = [];
  TRADING_DAYS.forEach((tradingDate, i) => {
    const decidedOn = days[i]!;
    const lastFetch = Math.max(...observations.filter((o) => o.date === decidedOn && o.kind === "close").map((o) => o.fetchedAt));
    const decideAt = Math.max(at(decidedOn, 21), lastFetch + 30 * 60_000);
    for (const agent of AGENTS) {
      const holdings = held[agent.id]!;
      const owned = Object.keys(holdings).filter((s) => (holdings[s] ?? 0) > 0);
      const orders: Order[] = [];
      if (i === 0 || rand() < 0.6) {
        if (owned.length > 0 && rand() < 0.4) {
          const symbol = pick(rand, owned);
          orders.push({ symbol, side: "sell", qty: holdings[symbol]! });
          holdings[symbol] = 0;
        } else {
          const symbol = pick(rand, SYMBOLS);
          const qty = LOT * randInt(rand, 1, 2);
          orders.push({ symbol, side: "buy", qty });
          holdings[symbol] = (holdings[symbol] ?? 0) + qty;
        }
      }
      let post: AgentPlan["post"] = null;
      if (rand() < 0.7) {
        const symbol = pick(rand, SYMBOLS);
        const lastClose = closeYen[symbol]![i]!; // decidedOn の終値
        post = { symbol, text: `${symbol} の${decidedOn}の終値は${lastClose}円。${pick(rand, ["様子を見る", "買い増しを検討する", "利益確定を検討する"])}。（架空のデータ）` };
      }
      plans.push({ agentId: agent.id, tradingDate, decidedOn, decideAt, orders, post });
    }
  });

  return { seed, symbols: SYMBOLS, agents: AGENTS, priorDay: PRIOR_DAY, tradingDays: TRADING_DAYS, lateDay: LATE_DAY, observations, plans };
}
