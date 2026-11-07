import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "../../src/app/page";
import { getView } from "../../src/app/data";
import { AgentCardView, LiveFeedView, LockedCard } from "../../src/components/ArenaCardView";
import { AgentPageView as AgentPageViewT } from "../../src/components/AgentPageView";
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
  quoteAt: "11/17 16:58",
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

  it("上にピンクの帯で架空の市場の注意書き。カードはAIの数だけと、伏せカード", () => {
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
    expect(h).toContain('href="/agents/ai-reversal"');
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

describe("AIページ", async () => {
  const { default: AgentPage, generateStaticParams } = await import("../../src/app/agents/[id]/page");
  const ids = (await generateStaticParams()).map((p) => p.id);
  const html = renderToStaticMarkup(await AgentPage({ params: Promise.resolve({ id: ids[0]! }) }));

  it("AIごとにページがあり、知らないIDは404。入力の要素がない", async () => {
    expect(ids).toHaveLength((await getView()).agents.length);
    await expect(AgentPage({ params: Promise.resolve({ id: "NOPE" }) })).rejects.toThrow();
    expect(html).not.toMatch(/<(form|input|textarea|select|button)\b/i);
    expect(html).not.toMatch(/\b(SSR|SR)\b/);
  });

  it("紹介・成績・推移・持ち株・取引履歴が出て、推移は全AIの線を重ねる。損益は▲▼つき", () => {
    for (const s of ["RECORD", "総資産", "前日比", "累計損益", "約定の回数", "EQUITY", "HOLDINGS", "取引履歴", "判断の実行 #", "直近の投稿"]) expect(html).toContain(s);
    expect(html.match(/<polyline/g)).toHaveLength(ids.length);
    expect(html).toMatch(/[▲▼－] [+¥-]/);
  });

  it("カードはAIページに、成績の表の名前もAIページにリンクする", async () => {
    const top = renderToStaticMarkup(await Home());
    for (const id of ids) expect(top).toContain(`href="/agents/${id}"`);
  });
});

describe("AIページの部品（細かい場合）", async () => {
  const { AgentPageView } = await import("../../src/components/AgentPageView");
  const { buildAgentPage } = await import("../../src/view/agent-page");
  const { buildView } = await import("../../src/view/build");
  const mk = (type: string, seq: number, payload: object, at = 0) => ({ seq, schema: 1, type, recordedAt: at, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" }) as never;

  it("評価前のAIは『評価前』で、推移を出さず、拒否の行と停止中が出る", () => {
    const v = buildView([mk("agent.registered", 1, { agentId: "ai-new", displayName: "新人", startDate: "2026-11-09", initialCash: 1000 }), mk("order_sheet.rejected", 2, { agentId: "ai-new", tradingDate: "2026-11-09", reason: "suspended", runSeq: 1 }, 5000), mk("agent.suspended", 3, { agentId: "ai-new", scope: "both", reason: "x" })], () => undefined);
    const h = renderToStaticMarkup(<AgentPageView page={buildAgentPage(v, new Map(), "ai-new")!} />);
    for (const s of ["評価前", "#－", "新人", "停止中（投稿と注文）", "拒否（停止中だった）", "受付 "]) expect(h).toContain(s);
    expect(h).not.toContain("<polyline");
    expect(h).not.toMatch(/<(form|input|textarea|select|button)\b/i);
  });
});

describe("掲示板の画面", async () => {
  const { BoardView } = await import("../../src/components/BoardView");
  const { buildBoard } = await import("../../src/view/board");
  const { buildView } = await import("../../src/view/build");
  const { buildAgentPage, fillKey } = await import("../../src/view/agent-page");
  const mk = (type: string, seq: number, payload: object, at = 0) => ({ seq, schema: 1, type, recordedAt: at, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" }) as never;
  const events = [
    mk("agent.registered", 1, { agentId: "ai-ma5", displayName: "あ", startDate: "2026-11-09", initialCash: 1000 }),
    mk("post.published", 2, { agentId: "ai-ma5", board: "X1", bodyHash: "a", citeSeqs: [], runSeq: 1, intent: "strategy", stance: "bull" }),
    mk("post.published", 3, { agentId: "ai-ma5", board: "X1", bodyHash: "b", citeSeqs: [], runSeq: 1, replyTo: 2, intent: "news", stance: "bear" }),
    mk("content.withdrawn", 4, { targetSeq: 3, reason: "誤り", textRemoved: false }),
    mk("order_sheet.committed", 5, { agentId: "ai-ma5", tradingDate: "2026-11-10", runSeq: 1, orders: [{ symbol: "X1", side: "buy", qty: 100 }] }),
    mk("fills.executed", 6, { agentId: "ai-ma5", sheetSeq: 5, tradingDate: "2026-11-10", fills: [{ symbol: "X1", side: "buy", requestedQty: 100, qty: 100, price: 100, amount: 10_000, status: "filled" }] }),
  ];
  const view = buildView(events, (h) => (h === "a" ? "戦略の本文" : "取り消された本文"));
  const board = buildBoard(view, "X1")!;
  const html = renderToStaticMarkup(<BoardView board={board} />);

  it("初期は『すべて』だけが押された状態で、ボタンは種類の6つ。0件の種類も選べる", () => {
    expect([...html.matchAll(/aria-pressed="(true|false)"/g)].map((m) => m[1])).toEqual(["true", "false", "false", "false", "false", "false"]);
    expect(html.match(/<button\b[^>]*type="button"/g)).toHaveLength(6);
    expect(html).toContain("戦略 1");
    expect(html).toContain("未分類 1");
  });

  it("見立て・種類のタグがつき、非表示の投稿は元の本文を出さず理由を出す。返信先にリンクする", () => {
    expect(html).toContain("▲ 強気");
    expect(html).toContain("戦略の本文");
    expect(html).toContain("非表示（誤り）");
    expect(html).not.toContain("取り消された本文");
    expect(html).not.toContain("▼ 弱気"); // 非表示の投稿の見立ては出さない
    expect(html).toContain("未分類 1");
    expect(html).toContain('href="#post-2"');
  });

  it("このあとの売買のリンク先は、AIページの取引履歴の行の id と一致する", () => {
    const href = board.posts.flatMap((p) => p.trades.map((t) => t.href))[0]!;
    const page = renderToStaticMarkup(<AgentPageViewT page={buildAgentPage(view, new Map(), "ai-ma5")!} />);
    expect(href).toBe(`/agents/ai-ma5#${fillKey(6, 0)}`);
    expect(page).toContain(`id="${fillKey(6, 0)}"`);
  });
});

describe("上部の帯", () => {
  it("すべての画面の上に、架空の市場の模擬売買であることと、投資助言ではないことを出す", () => {
    expect(DISCLAIMER).toBe("架空の市場での模擬売買です。登場する企業・価格は架空で、実在の企業とは関係ありません。AIの投稿は投資助言ではありません。");
    const h = renderToStaticMarkup(<Shell>{null}</Shell>);
    expect(h).toContain(DISCLAIMER);
    expect(h).toContain('role="note"');
  });
});

describe("銘柄のページ（市場の記録）", async () => {
  const { PriceChartView } = await import("../../src/components/PriceChartView");
  const { SymbolPageView, MAX_DAYS } = await import("../../src/components/SymbolPageView");
  const { priceChart } = await import("../../src/view/market-chart");
  const { buildMarket } = await import("../../src/view/market");
  const { buildView } = await import("../../src/view/build");
  const { formatYenMark } = await import("../../src/view/format");
  const { default: SymbolPage, generateStaticParams } = await import("../../src/app/symbols/[symbol]/page");
  const mk = (type: string, seq: number, payload: object, at = 0) => ({ seq, schema: 1, type, recordedAt: at, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" }) as never;
  const listed = (seq: number, symbol: string, name: string) => mk("company.listed", seq, { symbol, name, sector: "電機", sharesOutstanding: 500_000, price: 10_000 }, Date.parse("2026-11-09T18:00:00+09:00"));
  const cleared = (seq: number, date: string, price: number | null, volume: number) => mk("auction.cleared", seq, { symbol: "NEO1", date, price, volume, refSeq: 1, sheetSeqs: [] });
  const disclosed = (seq: number, period: string, revenue: number) => mk("company.disclosed", seq, { symbol: "NEO1", period, revenue, netIncome: 1, eps: 1, dividendPerShare: 0 }, Date.parse("2026-11-12T15:30:00+09:00"));
  const render = (events: unknown[], symbol: string) => {
    const node = SymbolPageView({ view: buildView(events as never, () => undefined), symbol });
    return node === null ? null : renderToStaticMarkup(node);
  };

  const market = buildMarket([listed(1, "NEO1", "ネオ電機"), cleared(2, "2026-11-10", 10_100, 200), cleared(3, "2026-11-11", null, 0)]);
  const c = market.companies[0]!;
  const html = renderToStaticMarkup(<PriceChartView chart={priceChart(c.days, c.listing.listedPrice, formatYenMark)!} days={c.days} />);

  it("値段の推移のグラフには、文での説明と表がつき、値つかずの日は印と言葉で分かる", () => {
    expect(html).toContain("2日のうち1日は値つかず");
    expect(html).toContain("▽ 値つかず");
    expect(html).toContain("評価は前の価格 ¥1,010");
    expect(html).toContain("ついた価格の高値 ¥1,010");
    expect(html).toContain("200株");
    const table = html.slice(html.indexOf("<table"));
    expect(table.indexOf("11/11")).toBeLessThan(table.indexOf("11/10")); // 表は最新が上
    expect(html).not.toMatch(/<(form|input|textarea|select|button)\b/i);
    expect(renderToStaticMarkup(<PriceChartView chart={priceChart([c.days[1]!], 10_000, formatYenMark)!} days={[c.days[1]!]} />)).toContain("ついた価格はありません（すべて値つかず）");
  });

  it("上場した銘柄は、投稿・約定がなくてもページがあり、社名・グラフ・決算（最新が上）が出る", () => {
    const page = render([listed(1, "NEO1", "ネオ電機"), cleared(2, "2026-11-10", 10_100, 200), disclosed(3, "2026-Q3", 1_000_000), disclosed(4, "2026-Q4", 2_000_000)], "NEO1")!;
    for (const s of ["ネオ電機", "PRICE ·", "EARNINGS ·", "まだ投稿がありません", "最初の価格 ¥1,000"]) expect(page).toContain(s);
    expect(page.indexOf("2026年 第4四半期")).toBeLessThan(page.indexOf("2026年 第3四半期"));
    expect(page).not.toMatch(/<(form|input|textarea|select)\b/i);
  });

  it("決算・板寄せがまだない銘柄は、その旨を出す。上場も投稿もない銘柄は null（404）", () => {
    const page = render([listed(1, "NEO1", "ネオ電機")], "NEO1")!;
    expect(page).toContain("まだ板寄せがありません");
    expect(page).toContain("まだ決算の発表がありません");
    expect(render([listed(1, "NEO1", "ネオ電機")], "NOPE")).toBeNull();
  });

  it("板寄せの日数が多いときは、直近だけを表示し、その旨を出す", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const events = [listed(1, "NEO1", "ネオ電機"), ...Array.from({ length: MAX_DAYS + 5 }, (_, i) => cleared(i + 2, new Date(base + i * 86_400_000).toISOString().slice(0, 10), 10_000 + i, 1))];
    const page = render(events, "NEO1")!;
    expect(page).toContain(`直近の${MAX_DAYS}日だけを表示しています（板寄せは全部で${MAX_DAYS + 5}日）`);
    expect(page.match(/<tr /g)!.length).toBeLessThanOrEqual(MAX_DAYS + 5); // 表の行は上限まで（見出しの行を含む）
  });

  it("市場の記録がない銘柄（今の固定データ）は『まだありません』と出し、静的なページの一覧は並び順が決まっている", async () => {
    const page = renderToStaticMarkup(await SymbolPage({ params: Promise.resolve({ symbol: "TSTA" }) }));
    expect(page).toContain("市場の記録（上場・板寄せ・決算）は、まだありません");
    expect(page).not.toContain("PRICE ·");
    const ids = (await generateStaticParams()).map((p) => p.symbol);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain("TSTB");
  });
});
