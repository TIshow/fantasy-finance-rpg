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
const run = (agentId: string, provider: string, modelId: string, at: number) =>
  ev("agent.run", { agentId, purpose: "post", model: { provider, modelId, settings: {} }, prompt: { id: "p", version: "1", hash: "h" }, inputSeqs: [], requestHash: "r", startedAt: at, finishedAt: at, ok: true }, at);

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
];
const view = buildView(events, (h) => (h === "b1" ? "本文その1" : undefined));

describe("モデルの表示（判断の記録 agent.run を読む）", () => {
  it("AIごとに最後の記録のモデルを持つ", () => {
    expect(view.models).toEqual([
      { agentId: "ai-c1", provider: "anthropic", modelId: "claude-new" },
      { agentId: "ai-g1", provider: "google", modelId: "gemini-x" },
      { agentId: "ai-m1", provider: "openai", modelId: "gpt-x" },
      { agentId: "ai-ma5", provider: "rule", modelId: "ma5" },
      { agentId: "ai-x1", provider: "constructor", modelId: "m" },
    ]);
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
    expect(characterOf("ai-c1", "x", "anthropic")).toMatchObject({ look: "sora", name: "ソラ・アンバー" });
    expect(characterOf("ai-m1", "x", "openai")).toMatchObject({ look: "gina", name: "ジーナ・パルス" });
    expect(characterOf("ai-g1", "x", "google")).toMatchObject({ look: "gem", name: "ジェム・ツイン" });
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
