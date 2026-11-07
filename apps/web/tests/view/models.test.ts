import { describe, expect, it } from "vitest";
import type { LogEvent } from "../../src/events/types";
import { buildAgentPage } from "../../src/view/agent-page";
import { buildArena } from "../../src/view/arena";
import { buildView } from "../../src/view/build";
import { characterOf } from "../../src/view/characters";
import { labelModel } from "../../src/view/models";

let n = 0;
const ev = (type: LogEvent["type"], payload: object, at: number): LogEvent => ({ seq: ++n, schema: 1, type, recordedAt: at, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" });
const T = (date: string, hh: number) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:00:00+09:00`);
const run = (agentId: string, provider: string, modelId: string, at: number, ok = true) =>
  ev("agent.run", { agentId, purpose: "post", model: { provider, modelId, settings: {} }, prompt: { id: "p", version: "1", hash: "h" }, inputSeqs: [], requestHash: "r", startedAt: at, finishedAt: at, ok }, at);

// 提供元ごとに1体ずつ。IDは運用で決まるので、IDが表にない前提で、提供元から見た目を引く
n = 0;
const events: LogEvent[] = [
  ev("agent.registered", { agentId: "ai-c1", displayName: "記録名C", startDate: "2026-11-09", initialCash: 10_000 }, 0),
  ev("agent.registered", { agentId: "ai-g1", displayName: "記録名G", startDate: "2026-11-09", initialCash: 10_000 }, 0),
  ev("agent.registered", { agentId: "ai-m1", displayName: "記録名M", startDate: "2026-11-09", initialCash: 10_000 }, 0),
  ev("agent.registered", { agentId: "ai-x1", displayName: "記録名X", startDate: "2026-11-09", initialCash: 10_000 }, 0),
  ev("agent.registered", { agentId: "ai-ma5", displayName: "規則", startDate: "2026-11-09", initialCash: 10_000 }, 0),
  run("ai-c1", "anthropic", "claude-old", T("2026-11-08", 16)),
  run("ai-c1", "anthropic", "claude-new", T("2026-11-09", 16)),
  run("ai-g1", "google", "gemini-x", T("2026-11-08", 16)),
  run("ai-m1", "openai", "gpt-x", T("2026-11-08", 16)),
  run("ai-x1", "constructor", "m", T("2026-11-08", 16)),
  run("ai-ma5", "rule", "ma5", T("2026-11-08", 16)),
  ev("post.published", { agentId: "ai-c1", board: "TSTA", bodyHash: "b1", citeSeqs: [], intent: "strategy", stance: "bull", runSeq: 6 }, T("2026-11-08", 17)),
  ev("post.published", { agentId: "ai-c1", board: "全体", bodyHash: "b2", citeSeqs: [], runSeq: 7 }, T("2026-11-09", 17)),
  ev("order_sheet.committed", { agentId: "ai-c1", tradingDate: "2026-11-09", runSeq: 7, orders: [{ symbol: "TSTA", side: "buy", qty: 100 }, { symbol: "TSTB", side: "sell", qty: 200 }] }, T("2026-11-09", 8)),
  ev("order_sheet.rejected", { agentId: "ai-c1", tradingDate: "2026-11-10", reason: "invalid_sheet" }, T("2026-11-09", 9)),
  ev("content.withdrawn", { targetSeq: 13, reason: "誤り", bodyErased: true }, T("2026-11-10", 1)),
  // 失敗した判断（ok:false）は「最後のモデル」に数えない：ai-g1 の最後は gemini-x のまま
  run("ai-g1", "openai", "gpt-failed", T("2026-11-12", 16), false),
];
const view = buildView(events, (h) => (h === "b1" ? "本文その1" : undefined));

describe("モデルの表示（判断の記録 agent.run を読む）", () => {
  it("AIごとに最後の記録のモデルを持つ", () => {
    expect(view.models).toEqual([
      { agentId: "ai-c1", provider: "anthropic", modelId: "claude-new", at: T("2026-11-09", 16), changed: true },
      { agentId: "ai-g1", provider: "google", modelId: "gemini-x", at: T("2026-11-08", 16), changed: false },
      { agentId: "ai-m1", provider: "openai", modelId: "gpt-x", at: T("2026-11-08", 16), changed: false },
      { agentId: "ai-ma5", provider: "rule", modelId: "ma5", at: T("2026-11-08", 16), changed: false },
      { agentId: "ai-x1", provider: "constructor", modelId: "m", at: T("2026-11-08", 16), changed: false },
    ]);
    expect(view.runs).toHaveLength(7);
  });

  it("カードのモデルは「最後の判断（日付）のモデル」と分かる文言で、途中で変えたAIはその旨を持つ", () => {
    const cards = new Map(buildArena(view).cards.map((c) => [c.agentId, c]));
    expect(cards.get("ai-c1")!.model).toMatchObject({ lastText: "最後の判断（11/09）のモデル", changed: true });
    expect(cards.get("ai-g1")!.model).toMatchObject({ lastText: "最後の判断（11/08）のモデル", changed: false });
  });

  it("LLM か規則かを分け、知らない提供元は記録のまま出す（constructor などを提供元の表と取り違えない）", () => {
    expect(labelModel("anthropic", "claude-new")).toMatchObject({ kind: "llm", kindText: "LLMで考える", text: "Anthropic · claude-new" });
    expect(labelModel("rule", "ma5")).toMatchObject({ kind: "rule", kindText: "規則で動く（比べる基準）", text: "規則 · ma5" });
    expect(labelModel("constructor", "m")).toMatchObject({ kind: "other", providerText: "constructor" });
    expect(labelModel("fixture", "scripted").kind).toBe("script");
  });

  it("形の違う agent.run は読み飛ばし、判断の記録のないAIはモデルなし", () => {
    const v = buildView([ev("agent.registered", { agentId: "a", displayName: "あ", startDate: "2026-11-09", initialCash: 10_000 }, 0), ev("agent.run", { agentId: "a", model: "x" }, 1)], () => undefined);
    expect(v.models).toEqual([]);
    expect(buildArena(v).cards[0]!.model).toBeNull();
  });

  it("カードとAIのページにモデルが載る", () => {
    const cards = new Map(buildArena(view).cards.map((c) => [c.agentId, c]));
    expect(cards.get("ai-c1")!.model).toMatchObject({ kind: "llm", modelId: "claude-new" });
    expect(cards.get("ai-ma5")!.model).toMatchObject({ kind: "rule" });
    expect(buildAgentPage(view, new Map(), "ai-g1")!.model).toMatchObject({ providerText: "Google" });
  });
});

describe("LLM で考える3体のキャラクター", () => {
  it("IDが表にないAIは、提供元から引く。表にあるIDが先。知らない提供元は伏せカード", () => {
    expect(characterOf("ai-c1", "x", "anthropic")).toMatchObject({ look: "sora", name: "ミナ・アンバー" });
    expect(characterOf("ai-m1", "x", "openai")).toMatchObject({ look: "gina", name: "ジーナ・タクト" });
    expect(characterOf("ai-g1", "x", "google")).toMatchObject({ look: "gem", name: "ユノ・ツイン" });
    expect(characterOf("ai-ma5", "x", "anthropic").look).toBe("mia");
    expect(characterOf("ai-x1", "記録名", "constructor")).toMatchObject({ look: "locked", name: "記録名" });
    expect(characterOf("ai-c1", "記録名").look).toBe("locked");
  });

  it("カードの見た目は、提供元から決まる", () => {
    expect(buildArena(view).cards.find((c) => c.agentId === "ai-g1")!.character.look).toBe("gem");
  });
});

describe("その日の判断（投稿と注文票）", () => {
  const page = buildAgentPage(view, new Map(), "ai-c1")!;

  it("日ごとにまとめ、新しい日が先。投稿の種類・見立て、注文の要約、拒否の理由を出す", () => {
    expect(page.decisions.map((d) => d.dateText)).toEqual(["11/09", "11/08"]);
    const [d9, d8] = page.decisions;
    expect(d8!.items[0]).toMatchObject({ kind: "post", text: "本文その1", symbol: "TSTA", tags: ["戦略", "▲ 強気"], note: null, runSeq: 6 });
    expect(d9!.items.map((i) => [i.kind, i.text])).toEqual([["orders", "買 TSTA 100株、売 TSTB 200株"], ["rejected", "注文票の不備"], ["post", ""]]);
  });

  it("非表示の投稿は本文を出さず理由を出す。保管にない本文はその旨を出す", () => {
    const posts = page.decisions.flatMap((d) => d.items).filter((i) => i.kind === "post");
    expect(posts.map((p) => p.note)).toEqual(["非表示（誤り）", null]);
    const missing = buildAgentPage(buildView(events.slice(0, 13), () => undefined), new Map(), "ai-c1")!.decisions.flatMap((d) => d.items).find((i) => i.key === "p12");
    expect(missing).toMatchObject({ text: "", note: "本文が保管にありません" });
  });
});

describe("判断ごとのモデル（版を途中で変えても、過去の判断に今のモデルを付けない）", () => {
  it("投稿・注文票の runSeq から、そのときの判断の記録のモデルを引く", () => {
    const page = buildAgentPage(view, new Map(), "ai-c1")!;
    const items = page.decisions.flatMap((d) => d.items);
    expect(items.find((i) => i.runSeq === 6)!.model).toMatchObject({ modelId: "claude-old", text: "Anthropic · claude-old" });
    expect(items.filter((i) => i.runSeq === 7).map((i) => i.model?.modelId)).toEqual(["claude-new", "claude-new"]);
    // 判断の記録に対応のない（runSeq が null の）項目はモデルなし
    expect(items.find((i) => i.kind === "rejected")!.model).toBeNull();
    expect(page.model).toMatchObject({ lastText: "最後の判断（11/09）のモデル", changed: true });
  });
});

describe("日付の見出し", () => {
  it("key は年月日。表示する日が年をまたぐときは年も出す", () => {
    const evs: LogEvent[] = [
      ev("agent.registered", { agentId: "a", displayName: "あ", startDate: "2026-12-30", initialCash: 10_000 }, 0),
      ev("order_sheet.committed", { agentId: "a", tradingDate: "2026-12-31", runSeq: null, orders: [] }, T("2026-12-30", 8)),
      ev("order_sheet.committed", { agentId: "a", tradingDate: "2027-01-05", runSeq: null, orders: [] }, T("2027-01-04", 8)),
    ];
    const days = buildAgentPage(buildView(evs, () => undefined), new Map(), "a")!.decisions;
    expect(days.map((d) => [d.date, d.dateText])).toEqual([["2027-01-04", "2027/01/04"], ["2026-12-30", "2026/12/30"]]);
    expect(buildAgentPage(view, new Map(), "ai-c1")!.decisions.map((d) => d.dateText)).toEqual(["11/09", "11/08"]);
  });
});

describe("取り下げた投稿の本文（保管に本文がある場合）", () => {
  const SECRET = "取り下げ対象の本文ZZZ";
  const events = (withdrawn: object): LogEvent[] => {
    n = 0;
    return [
      ev("agent.registered", { agentId: "w1", displayName: "取り下げAI", startDate: "2026-11-09", initialCash: 10_000 }, 0),
      ev("post.published", { agentId: "w1", board: "TSTA", bodyHash: "bw", citeSeqs: [], intent: "strategy", stance: "bull" }, T("2026-11-09", 17)),
      ev("content.withdrawn", { targetSeq: 2, ...withdrawn }, T("2026-11-10", 1)),
    ];
  };
  for (const [name, w] of [["取り下げ（本文は残す）", { reason: "誤り", bodyErased: false }], ["取り下げ（本文を消した）", { reason: "誤り", bodyErased: true }]] as const) {
    it(`${name}：本文は View にも AIページにも出ない`, () => {
      const v = buildView(events(w), (h) => (h === "bw" ? SECRET : undefined));
      const page = buildAgentPage(v, new Map(), "w1")!;
      const post = page.decisions.flatMap((d) => d.items)[0]!;
      expect(post).toMatchObject({ kind: "post", text: "", note: "非表示（誤り）", tags: [] });
      expect(JSON.stringify(page)).not.toContain(SECRET);
      expect(JSON.stringify(v)).not.toContain(SECRET);
    });
  }
});
