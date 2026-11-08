// LLM の AI 投資家の出力の形と上限の試験（#179）。合わなければ invalid_output にする理由を返す。
import { describe, expect, it } from "vitest";
import { parseInvestorOutput } from "../../src/llm/investor-output";

const BOARDS = ["ORS1", "VRN1"];
const read = (v: unknown, truncated = false) => parseInvestorOutput(typeof v === "string" ? v : JSON.stringify(v), { boards: BOARDS, truncated });
const good = { post: { board: "VRN1", text: "決算が良いので少し買う" }, orders: [{ symbol: "VRN1", side: "buy", qty: 100, limit: 1234 }, { symbol: "ORS1", side: "sell", qty: 200 }], note: "決算" };

describe("parseInvestorOutput", () => {
  it("決まった形を読み、指値（円の整数）を0.1円単位に直す", () => {
    expect(read(good)).toEqual({
      ok: true,
      decision: { post: good.post, orders: [{ symbol: "VRN1", side: "buy", qty: 100, limit: 12_340 }, { symbol: "ORS1", side: "sell", qty: 200 }], note: "決算" },
    });
  });

  it("投稿なし（null・省略）・注文なし・note の省略・「全体」の掲示板・```json の囲みは読める", () => {
    expect(read({ post: null, orders: [] })).toEqual({ ok: true, decision: { post: null, orders: [], note: "" } });
    expect(read({ orders: [] })).toMatchObject({ ok: true, decision: { post: null } });
    expect(read({ post: { board: "全体", text: "様子を見る" }, orders: [] })).toMatchObject({ ok: true, decision: { post: { board: "全体" } } });
    expect(read(`\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\n`)).toMatchObject({ ok: true });
  });

  it("本文は400字まで（文字数は符号の数で数える）", () => {
    expect(read({ ...good, post: { board: "VRN1", text: "あ".repeat(400) } })).toMatchObject({ ok: true });
    expect(read({ ...good, post: { board: "VRN1", text: "🙂".repeat(400) } })).toMatchObject({ ok: true });
    expect(read({ ...good, post: { board: "VRN1", text: "あ".repeat(401) } })).toEqual({ ok: false, problem: "post_length" });
    expect(read({ ...good, post: { board: "VRN1", text: " \n" } })).toEqual({ ok: false, problem: "post_length" });
  });

  it("掲示板は上場した取引対象の銘柄か「全体」だけ", () => {
    for (const board of ["XXX1", "vrn1", "", "全体 "]) expect(read({ ...good, post: { board, text: "x" } })).toEqual({ ok: false, problem: "post_board" });
  });

  it("注文は10件まで", () => {
    const order = { symbol: "VRN1", side: "buy", qty: 100 };
    expect(read({ ...good, orders: Array(10).fill(order) })).toMatchObject({ ok: true });
    expect(read({ ...good, orders: Array(11).fill(order) })).toEqual({ ok: false, problem: "too_many_orders" });
  });

  it.each<[string, unknown]>([
    ["side が決まりの外", { symbol: "VRN1", side: "short", qty: 100 }],
    ["株数が小数", { symbol: "VRN1", side: "buy", qty: 100.5 }],
    ["株数が0", { symbol: "VRN1", side: "buy", qty: 0 }],
    ["株数が文字列", { symbol: "VRN1", side: "buy", qty: "100" }],
    ["指値が小数", { symbol: "VRN1", side: "buy", qty: 100, limit: 12.5 }],
    ["指値が0", { symbol: "VRN1", side: "buy", qty: 100, limit: 0 }],
    ["指値が大きすぎる", { symbol: "VRN1", side: "buy", qty: 100, limit: Number.MAX_SAFE_INTEGER }],
    ["知らない項目", { symbol: "VRN1", side: "buy", qty: 100, reason: "x" }],
    ["銘柄が文字列でない", { symbol: 1, side: "buy", qty: 100 }],
  ])("注文の形が違う：%s", (_name, order) => {
    expect(read({ ...good, orders: [order] })).toEqual({ ok: false, problem: "order_shape" });
  });

  it.each<[string, unknown]>([
    ["orders がない", { post: null }],
    ["orders が配列でない", { post: null, orders: {} }],
    ["知らない項目", { ...good, reasoning: "x" }],
    ["note が文字列でない", { ...good, note: 1 }],
    ["投稿が2件（配列）", { ...good, post: [good.post, good.post] }],
    ["投稿の本文がない", { ...good, post: { board: "VRN1" } }],
    ["全体が配列", [good]],
  ])("形が違う：%s", (_name, v) => {
    expect(read(v)).toEqual({ ok: false, problem: "shape" });
  });

  it("JSON でない・前後に説明がある出力は not_json。上限で切れた出力は、形が合っていても truncated", () => {
    expect(read("買います")).toEqual({ ok: false, problem: "not_json" });
    expect(read(`考えた結果：${JSON.stringify(good)}`)).toEqual({ ok: false, problem: "not_json" });
    expect(read(JSON.stringify(good).slice(0, -5))).toEqual({ ok: false, problem: "not_json" });
    expect(read(good, true)).toEqual({ ok: false, problem: "truncated" });
  });
});
