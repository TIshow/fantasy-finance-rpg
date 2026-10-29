import { describe, expect, it } from "vitest";
import {
  clearCurrentRound,
  clearRound,
  createMatch,
  currentPrices,
  placeOrder,
  playerAccount,
  type MatchState,
  type OrderIntent,
  type RoundOrder,
} from "@/engine";
import { scenario, policy, sheet, teams } from "./fixtures";

function advanceTo(round: number, match: MatchState) {
  let m = match;
  while (m.round < round) m = clearCurrentRound(m, policy).match;
  return m;
}

function order(m: MatchState, teamId: string, intent: OrderIntent) {
  const r = placeOrder(m, scenario, teamId, intent);
  if (!r.ok) throw new Error(r.reason);
  return r.match;
}

describe("一斉約定（MARKET_SPEC §8 の例）", () => {
  it("例1 通常：全員が公開された新価格で約定し、現金と口数の増減は合計0", () => {
    let m = createMatch(scenario, sheet, ["A", "B"]);
    m = order(m, "A", { guildId: "airship", side: "buy", qty: 10 });
    m = order(m, "B", { guildId: "airship", side: "buy", qty: 10 });
    m = clearCurrentRound(m, policy).match;
    m = order(m, "A", { guildId: "dragon", side: "buy", qty: 10 });
    m = order(m, "B", { guildId: "airship", side: "sell", qty: 5 });
    const { record } = clearCurrentRound(m, policy);
    const r = record.result;
    const a = r.fills.find((f) => f.accountId === "team:A")!;
    const b = r.fills.find((f) => f.accountId === "team:B")!;
    expect(a).toMatchObject({ filled: 10, price: r.prices.dragon, reason: "filled" });
    expect(b).toMatchObject({ filled: 5, price: r.prices.airship, cashDelta: 5 * r.prices.airship! });
    // 同じギルドのNPCも同じ価格
    expect(r.fills.filter((f) => f.guildId === "dragon").every((f) => f.price === r.prices.dragon)).toBe(true);
    expect(r.fills.reduce((s, f) => s + f.cashDelta, 0) + r.mmCashDelta).toBe(0);
    expect(Object.values(r.prices).reduce((x, y) => x + y, 0)).toBe(100);
    expect(r.iterations).toBe(1);
  });

  it("例2 逆方向への集中：6商会が暴落に逆らっても山場は残り、暴落後の価格で買える", () => {
    let m = advanceTo(3, createMatch(scenario, sheet, teams(6)));
    for (const t of teams(6)) m = order(m, t, { guildId: "dragon", side: "buy", qty: 10 });
    const reserved = m.orders[0]!.reserveCash;
    const { match, record } = clearCurrentRound(m, policy);
    expect(currentPrices(match).dragon).toBeLessThanOrEqual(20);
    const fill = record.result.fills.find((f) => f.accountId === "team:t1")!;
    expect(fill).toMatchObject({ filled: 10, price: record.result.prices.dragon });
    expect(reserved).toBe(10 * 45);
    expect(playerAccount(match, "t1")!.cash).toBe(1000 - 10 * record.result.prices.dragon!);
  });

  it("例3 予算不足：新価格で予約額を超える分を減らして一部約定にする", () => {
    let m = advanceTo(5, createMatch(scenario, sheet, ["D"]));
    m = order(m, "D", { guildId: "dragon", side: "buy", qty: 10 });
    const reserve = m.orders[0]!.reserveCash;
    const { record } = clearCurrentRound(m, policy);
    const f = record.result.fills.find((x) => x.accountId === "team:D")!;
    expect(f.reason).toBe("partial_budget");
    expect(f.filled * f.price).toBeLessThanOrEqual(reserve);
    expect((f.filled + 1) * f.price).toBeGreaterThan(reserve);
    expect(record.result.iterations).toBeGreaterThan(1);
  });

  it("予約額で1口も買えなければ不成立", () => {
    const market = { guilds: ["x", "y"], b: 100, q: { x: 0, y: 0 } };
    const orders: RoundOrder[] = [
      { accountId: "p", kind: "player", guildId: "x", side: "buy", qty: 5, reserveCash: 10 },
    ];
    const r = clearRound({ market, orders });
    expect(r.fills[0]).toMatchObject({ filled: 0, reason: "unfilled_budget", cashDelta: 0 });
  });

  it("例4 参加者0人：NPCだけで目標どおりの値動きになる", () => {
    let m = createMatch(scenario, sheet, []);
    const path = [currentPrices(m)];
    for (let r = 1; r <= 5; r++) {
      m = clearCurrentRound(m, policy).match;
      path.push(currentPrices(m));
    }
    expect(path.map((p) => p.dragon)).toEqual([23, 22, 30, 11, 9, 28]);
    expect(path.slice(1)).toEqual(scenario.targetPrices);
  });

  it("例5 売りだけ：暴落と同じ向きに売ると、暴落後の価格で受け取る", () => {
    let m = createMatch(scenario, sheet, ["A"]);
    m = order(m, "A", { guildId: "dragon", side: "buy", qty: 10 });
    m = advanceTo(3, m);
    m = order(m, "A", { guildId: "dragon", side: "sell", qty: 10 });
    const { record } = clearCurrentRound(m, policy);
    const f = record.result.fills.find((x) => x.accountId === "team:A")!;
    expect(f.price).toBe(record.result.prices.dragon);
    expect(f.price).toBeLessThanOrEqual(12);
  });

  it("例6 同じ入力なら同じ結果。注文の並び順にも依存しない", () => {
    let m = advanceTo(3, createMatch(scenario, sheet, teams(3)));
    m = order(m, "t1", { guildId: "dragon", side: "buy", qty: 7 });
    m = order(m, "t2", { guildId: "airship", side: "buy", qty: 3 });
    m = order(m, "t3", { guildId: "alchemy", side: "buy", qty: 10 });
    const orders = [...m.orders, ...policy.ordersForRound(3)];
    const a = clearRound({ market: m.market, orders });
    const b = clearRound({ market: m.market, orders: [...orders].reverse() });
    expect(b.outputHash).toBe(a.outputHash);
    expect(b.inputHash).toBe(a.inputHash);
    expect(clearRound({ market: m.market, orders }).outputHash).toBe(a.outputHash);
  });
});

describe("裁定ができない", () => {
  const noNpc = { ordersForRound: () => [] };

  it("往復売買（買って次のラウンドで売る）ではリスクなしに儲からない", () => {
    for (const g of scenario.guilds.map((x) => x.id)) {
      for (const qty of [1, 5, 10]) {
        let m = createMatch(scenario, sheet, ["A"]);
        m = order(m, "A", { guildId: g, side: "buy", qty });
        m = clearCurrentRound(m, noNpc).match;
        m = order(m, "A", { guildId: g, side: "sell", qty });
        m = clearCurrentRound(m, noNpc).match;
        expect(playerAccount(m, "A")!.cash).toBeLessThanOrEqual(1000);
      }
    }
  });

  it("4ギルドを1口ずつ買うと価格は変わらず100G。決算でも100Gで、利益は出ない", () => {
    let m = createMatch(scenario, sheet, ["A"]);
    const before = currentPrices(m);
    for (const g of scenario.guilds.map((x) => x.id)) m = order(m, "A", { guildId: g, side: "buy", qty: 1 });
    const { match, record } = clearCurrentRound(m, noNpc);
    expect(record.result.prices).toEqual(before);
    expect(playerAccount(match, "A")!.cash).toBe(900);
  });
});
