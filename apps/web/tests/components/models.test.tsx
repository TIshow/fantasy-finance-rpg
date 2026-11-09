import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentPageView } from "../../src/components/AgentPageView";
import { AgentCardView } from "../../src/components/ArenaCardView";
import { Portrait } from "../../src/components/Portrait";
import type { LogEvent } from "../../src/events/types";
import { buildAgentPage, type AgentPage, type DecisionItem } from "../../src/view/agent-page";
import type { ArenaCard } from "../../src/view/arena";
import { buildView } from "../../src/view/build";
import { characterOf } from "../../src/view/characters";
import { labelModel } from "../../src/view/models";

const card = (provider: string, modelId: string): ArenaCard => ({
  agentId: "ai-new",
  character: characterOf("ai-new", "記録名", provider),
  loggedName: "記録名",
  handle: "@ai-new",
  model: labelModel(provider, modelId),
  rank: 1,
  totalText: "¥10,000,000",
  asOf: "11/18",
  pnl: null,
  spark: null,
  top: [],
  quote: null,
  quoteAt: null,
  lastTrade: null,
});

describe("モデルの表示とLLMの3体の肖像", () => {
  it("LLMのカードに、提供元・版・LLMで考える旨と、キャラクターの名前が出る", () => {
    const h = renderToStaticMarkup(<AgentCardView card={card("anthropic", "claude-x")} />);
    expect(h).toContain("LLMで考える");
    expect(h).toContain("Anthropic · claude-x");
    expect(h).toContain("ミナ・アンバー");
  });

  it("規則のカードには、規則で動く旨が出る", () => {
    const h = renderToStaticMarkup(<AgentCardView card={card("rule", "ma5")} />);
    expect(h).toContain("規則で動く（比べる基準）");
    expect(h).toContain("規則 · ma5");
  });

  it("3体の肖像はそれぞれ描ける（外部の画像は使わない）", () => {
    for (const look of ["sora", "gina", "gem"] as const) {
      const h = renderToStaticMarkup(<Portrait look={look} />);
      expect(h).toContain("<svg");
      expect(h).not.toContain("<image");
    }
  });
});

describe("日ごとの判断の画面", () => {
  const item = (o: Partial<DecisionItem>): DecisionItem => ({ key: "p1", timeText: "17:00", kind: "post", label: "投稿", text: "", note: null, symbol: null, tags: [], runSeq: null, model: null, dryRun: false, ...o });
  const pageWith = (decisions: AgentPage["decisions"]): AgentPage => {
    const ev = (seq: number, type: LogEvent["type"], payload: object): LogEvent => ({ seq, schema: 1, type, recordedAt: 0, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" });
    const base = buildAgentPage(buildView([ev(1, "agent.registered", { agentId: "a", displayName: "あ", startDate: "2026-11-09", initialCash: 10_000 })], () => undefined), new Map(), "a")!;
    return { ...base, decisions };
  };

  it("拒否は強調の色、note があるときは本文を出さず note を出す、判断ごとのモデルを出す", () => {
    const h = renderToStaticMarkup(
      <AgentPageView
        page={pageWith([
          {
            date: "2026-11-09",
            dateText: "11/09",
            items: [
              item({ key: "r1", kind: "rejected", label: "注文票を拒否", text: "注文票の不備" }),
              item({ key: "p2", text: "出してはいけない本文", note: "非表示（誤り）", model: labelModel("anthropic", "claude-old") }),
            ],
          },
        ])}
      />,
    );
    expect(h).toContain("text-neon-pink");
    expect(h).toContain("注文票の不備");
    expect(h).toContain("非表示（誤り）");
    expect(h).not.toContain("出してはいけない本文");
    expect(h).toContain("Anthropic · claude-old");
  });

  it("判断の記録がないときは、その旨を出す", () => {
    expect(renderToStaticMarkup(<AgentPageView page={pageWith([])} />)).toContain("まだ判断の記録がありません");
  });
});

describe("知らない提供元のカード", () => {
  it("提供元は記録のまま出し、「提供元は未登録」と書く。見た目は伏せカード", () => {
    const h = renderToStaticMarkup(<AgentCardView card={card("newvendor", "nv-1")} />);
    expect(h).toContain("提供元は未登録");
    expect(h).toContain("newvendor · nv-1");
    expect(h).toContain("参戦準備中");
  });

  it("モデルを途中で変えたAIは、その旨と最後の判断の日付を出す", () => {
    const c = { ...card("anthropic", "claude-new"), model: { ...labelModel("anthropic", "claude-new"), lastText: "最後の判断（11/09）のモデル", changed: true } };
    const h = renderToStaticMarkup(<AgentCardView card={c} />);
    expect(h).toContain("最後の判断（11/09）のモデル");
    expect(h).toContain("途中でモデルを変えています");
  });
});

describe("取り下げた投稿（保管に本文がある場合）", () => {
  const SECRET = "取り下げ対象の本文ZZZ";
  for (const bodyErased of [false, true]) {
    it(`bodyErased=${bodyErased}：AIページを描いた文字列に本文が入らない`, () => {
      const ev = (seq: number, type: LogEvent["type"], payload: object, at: number): LogEvent => ({ seq, schema: 1, type, recordedAt: at, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" });
      const day = Date.parse("2026-11-09T17:00:00+09:00");
      const v = buildView(
        [
          ev(1, "agent.registered", { agentId: "w1", displayName: "取り下げAI", startDate: "2026-11-09", initialCash: 10_000 }, 0),
          ev(2, "post.published", { agentId: "w1", board: "TSTA", bodyHash: "bw", citeSeqs: [], intent: "strategy" }, day),
          ev(3, "content.withdrawn", { targetSeq: 2, reason: "誤り", bodyErased }, day + 3_600_000),
        ],
        (h) => (h === "bw" ? SECRET : undefined),
      );
      const h = renderToStaticMarkup(<AgentPageView page={buildAgentPage(v, new Map(), "w1")!} />);
      expect(h).toContain("非表示（誤り）");
      expect(h).not.toContain(SECRET);
    });
  }
});
