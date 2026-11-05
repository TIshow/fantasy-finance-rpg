import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "../../src/app/page";
import { getView } from "../../src/app/data";
import { AgentCardView, LiveFeedView, LockedCard } from "../../src/components/ArenaCardView";
import { Portrait } from "../../src/components/Portrait";
import { DISCLAIMER, Shell } from "../../src/components/Shell";
import { buildArena, type ArenaCard } from "../../src/view/arena";
import { characterOf } from "../../src/view/characters";

const card = (over: Partial<ArenaCard> = {}): ArenaCard => ({
  agentId: "ai-reversal",
  character: characterOf("ai-reversal", "x"),
  loggedName: "x",
  handle: "@ai-reversal",
  rank: 2,
  totalText: "¥9,900,000",
  asOf: "11/18",
  pnl: { direction: "down", text: "-¥100,000", percentText: "-1.00%" },
  spark: { points: "0,10 140,30", baseY: 20, label: "2営業日の資産の推移（初期資金より下）" },
  top: [{ symbol: "TSTB", weightText: "31.4%", weightPct: 31.4 }],
  quote: "本文そのまま",
  lastTrade: "11/18 売 TSTA 400株",
  ...over,
});

describe("トップ（アリーナ）の画面", async () => {
  const html = renderToStaticMarkup(
    <Shell>
      {await Home()}
    </Shell>,
  );
  const view = await getView();
  const arena = buildArena(view);

  it("上にピンクの帯で模擬売買の注意書き。カードはAIの数だけと、伏せカード", () => {
    expect(html.indexOf(DISCLAIMER)).toBeGreaterThanOrEqual(0);
    expect(html.indexOf(DISCLAIMER)).toBeLessThan(html.indexOf("参戦中のAI"));
    expect(html).toContain("bg-neon-pink");
    expect(html.match(/<article/g)).toHaveLength(arena.cards.length + 1);
    expect(html).toContain("次のAI、参戦準備中");
    expect(html).toContain("LIVE FEED");
  });

  it("レア度（SSR・SR）を出さない。人間が操作する要素もない", () => {
    expect(html).not.toMatch(/\b(SSR|SR)\b/);
    expect(html).not.toMatch(/<(form|input|textarea|select|button)\b/i);
  });

  it("各カードに、順位・総資産・累計損益の▲・二つ名・ひとこと・直近の売買が出る", () => {
    for (const c of arena.cards) {
      expect(html).toContain(c.character.name);
      expect(html).toContain(c.totalText);
      expect(html).toContain(`#${c.rank}`);
    }
    expect(html).toContain("▲");
    expect(html).toContain("今日のひとこと");
    expect(html).toContain("直近 ");
    expect(html).toContain("<polyline");
  });
});

describe("カードの部品", () => {
  it("下落はピンクと▼（色だけで示さない）。本文は記録の文のまま", () => {
    const h = renderToStaticMarkup(<AgentCardView card={card()} />);
    expect(h).toContain("▼ -1.00%");
    expect(h).toContain("-¥100,000");
    expect(h).toContain("#FF2E88");
    expect(h).toContain("本文そのまま");
    expect(h).toContain("31.4%");
    expect(h).toContain("2営業日の資産の推移");
    expect(h).toContain("11/18 引け");
    expect(h).toContain('href="/agents#ai-reversal"');
  });

  it("投稿・保有・売買がない、評価がまだないカードも壊れない", () => {
    const h = renderToStaticMarkup(<AgentCardView card={card({ rank: null, quote: null, top: [], lastTrade: null, totalText: null, asOf: null, pnl: null, spark: null })} />);
    expect(h).toContain("#－");
    expect(h).toContain("まだ投稿がありません");
    expect(h).toContain("保有なし");
    expect(h).toContain("売買なし");
    expect(h).toContain("評価前");
    expect(h).not.toContain("<polyline");
    expect(h).not.toMatch(/[▲▼－] /);
  });

  it("未知のAIは伏せカードの肖像で、記録の名前を出す", () => {
    const h = renderToStaticMarkup(<AgentCardView card={card({ character: characterOf("ai-new", "新人さん"), loggedName: "新人さん" })} />);
    expect(h).toContain("新人さん");
    expect(h).toContain("まだ参戦していないAIのシルエット");
  });

  it("肖像は種類ごとのラベルとコードを持ち、複数置いても id が衝突しない", () => {
    const h = renderToStaticMarkup(
      <>
        <Portrait look="mia" />
        <Portrait look="mia" />
        <Portrait look="riva" />
        <Portrait look="holden" />
        <LockedCard />
      </>,
    );
    for (const s of ["ミア・ファイヴの肖像", "リバ・ゼロの肖像", "ホールデン翁の肖像", "MA5 // TREND", "REV // CONTRA", "HOLD // LONG", "??? // COMING"]) expect(h).toContain(s);
    const ids = [...h.matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5);
    expect(h).not.toMatch(/<image|href="http/);
  });

  it("キャラの名前が記録の名前と違うときは、記録の名前も出す", () => {
    expect(renderToStaticMarkup(<AgentCardView card={card({ loggedName: "テストAI・い" })} />)).toContain("記録名 テストAI・い");
  });

  it("フィードの投稿は掲示板へのリンクを持つ", () => {
    const h = renderToStaticMarkup(<LiveFeedView feed={[{ key: "p", timeText: "11/18 16:58", kind: "post", label: "投稿", color: "#D9C8F2", text: "リバ・ゼロ「x」", symbol: "TSTA" }]} />);
    expect(h).toContain('href="/symbols/TSTA"');
    expect(h).toContain("11/18 16:58");
  });
});

describe("タイムライン・成績のページ", () => {
  it("/timeline は全項目を出し、入力の要素がない。評価のないAIは成績の表の代わりに文を出す", async () => {
    const { default: TimelinePage } = await import("../../src/app/timeline/page");
    const h = renderToStaticMarkup(await TimelinePage());
    expect(h).toContain("タイムライン");
    expect(h.match(/<time /g)?.length).toBe((await getView()).timeline.length);
    expect(h).not.toMatch(/<(form|input|textarea|select|button)\b/i);
  });
});
