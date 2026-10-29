import { describe, expect, it } from "vitest";
import {
  clearCurrentRound,
  createMatch,
  deriveForecast,
  investigate,
  placeOrder,
  playerAccount,
  ranking,
  settleMatch,
  type Account,
} from "@/engine";
import { policy, scenario, sheet } from "./fixtures";

describe("予測の導出（D-021）", () => {
  const acct = (cash: number, costs: Record<string, number>): Account => ({
    id: "team:a",
    kind: "player",
    cash,
    positions: Object.fromEntries(Object.entries(costs).map(([g, c]) => [g, { qty: c > 0 ? 1 : 0, costBasis: c }])),
  });
  const guilds = ["airship", "alchemy", "dragon", "academy"];

  it("取得原価が最大のギルドが本命。資金配分率の分母は現金を含む", () => {
    const f = deriveForecast(acct(160, { airship: 280, alchemy: 0, dragon: 460, academy: 100 }), guilds);
    expect(f).toEqual({ favorite: { kind: "guild", guildId: "dragon" }, allocationPct: 46 });
  });

  it("同額首位は分散・同率、保有なしは未投資", () => {
    expect(deriveForecast(acct(500, { airship: 250, dragon: 250 }), guilds).favorite).toEqual({ kind: "split" });
    expect(deriveForecast(acct(1000, {}), guilds)).toEqual({ favorite: { kind: "none" }, allocationPct: 0 });
  });

  it("売ると対応する取得原価が減り、価格の変化だけでは本命が変わらない", () => {
    let m = createMatch(scenario, sheet, ["A"]);
    let r = placeOrder(m, scenario, "A", { guildId: "dragon", side: "buy", qty: 10 });
    if (!r.ok) throw new Error(r.reason);
    m = clearCurrentRound(r.match, policy).match;
    const cost = playerAccount(m, "A")!.positions.dragon!.costBasis;
    m = clearCurrentRound(m, policy).match; // 価格だけが動く
    expect(m.history[1]!.forecasts.A).toEqual(m.history[0]!.forecasts.A);
    r = placeOrder(m, scenario, "A", { guildId: "dragon", side: "sell", qty: 5 });
    if (!r.ok) throw new Error(r.reason);
    m = clearCurrentRound(r.match, policy).match;
    expect(playerAccount(m, "A")!.positions.dragon!.costBasis).toBe(cost / 2);
  });
});

describe("調査券（D-020）", () => {
  it("第3・第4ラウンドのどちらかで1回だけ。窓ごとに結果が変わる", () => {
    let m = createMatch(scenario, sheet, ["A", "B"]);
    expect(investigate(m, scenario, "A", "official")).toEqual({ ok: false, reason: "no_window" });
    m = clearCurrentRound(clearCurrentRound(m, policy).match, policy).match;
    const a = investigate(m, scenario, "A", "official");
    expect(a.ok && a.source.result).toContain("三本帯");
    m = a.ok ? a.match : m;
    expect(investigate(m, scenario, "A", "ai")).toEqual({ ok: false, reason: "already_used" });
    m = clearCurrentRound(m, policy).match;
    const b = investigate(m, scenario, "B", "official");
    expect(b.ok && b.source.result).toContain("OT-04");
    m = clearCurrentRound(b.ok ? b.match : m, policy).match;
    expect(investigate(m, scenario, "C", "ai")).toEqual({ ok: false, reason: "unknown_team" });
  });

  it("参加者IDが __proto__ でも、未使用の調査券を使用済みと誤判定しない", () => {
    let m = createMatch(scenario, sheet, ["__proto__"]);
    m = clearCurrentRound(clearCurrentRound(m, policy).match, policy).match;
    expect(investigate(m, scenario, "__proto__", "official").ok).toBe(true);
  });
});

describe("決算", () => {
  it("ドラゴン輸送の成功証を1口100Gで精算し、2回呼んでも1回分だけ", () => {
    let m = createMatch(scenario, sheet, ["A", "B"]);
    const r = placeOrder(m, scenario, "A", { guildId: "dragon", side: "buy", qty: 10 });
    if (!r.ok) throw new Error(r.reason);
    m = r.match;
    for (let i = 0; i < 5; i++) m = clearCurrentRound(m, policy).match;
    const cashBefore = playerAccount(m, "A")!.cash;
    const settled = settleMatch(m, scenario);
    expect(playerAccount(settled, "A")!.cash).toBe(cashBefore + 1000);
    expect(settleMatch(settled, scenario)).toBe(settled);
    expect(ranking(settled).map((x) => x.teamId)).toEqual(["A", "B"]);
    expect(() => settleMatch(createMatch(scenario, sheet, ["A"]), scenario)).toThrow();
  });
});
