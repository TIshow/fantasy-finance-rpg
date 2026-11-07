import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentCardView } from "../../src/components/ArenaCardView";
import { Portrait } from "../../src/components/Portrait";
import type { ArenaCard } from "../../src/view/arena";
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
    expect(h).toContain("ソラ・アンバー");
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
