import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardLink } from "../../src/components/BoardLink";
import { LiveFeedView } from "../../src/components/ArenaCardView";
import { AgentPageView } from "../../src/components/AgentPageView";
import { TimelineItemView } from "../../src/components/TimelineItemView";
import { boardSymbols, buildBoard, isSymbolBoard } from "../../src/view/board";
import { buildAgentPage } from "../../src/view/agent-page";
import { buildView } from "../../src/view/build";
import type { LogEvent } from "../../src/events/types";

const AT = Date.parse("2026-11-09T10:00:00+09:00");
let n = 0;
const ev = (type: LogEvent["type"], payload: object): LogEvent => ({ seq: ++n, schema: 1, type, recordedAt: AT + n, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" });
const BOARDS = ["全体", "全体 ", "全体　", "ALL", "tsta", "ZZZZ", "TSTA"];

const view = () => {
  n = 0;
  const events = [
    ev("agent.registered", { agentId: "ai-x", displayName: "あ", startDate: "2026-11-09", initialCash: 1000 }),
    ...BOARDS.map((b, i) => ev("post.published", { agentId: "ai-x", board: b, bodyHash: `h${i}`, citeSeqs: [], runSeq: 1 })),
    ev("fills.executed", { agentId: "ai-x", sheetSeq: 9, tradingDate: "2026-11-10", fills: [{ symbol: "TSTA", side: "buy", requestedQty: 1, qty: 1, price: 100, amount: 100, status: "filled" }] }),
  ];
  return buildView(events, () => "本文");
};

describe("「全体」の掲示板（銘柄ではないのでページにもリンクにもしない）", () => {
  it("銘柄はリンク、全体は文字だけ。下線以外の見た目の指定は残す", () => {
    expect(isSymbolBoard("7203")).toBe(true);
    expect(isSymbolBoard("全体")).toBe(false);
    expect(renderToStaticMarkup(<BoardLink board="7203" suffix=" 掲示板" />)).toContain('href="/symbols/7203"');
    const all = renderToStaticMarkup(<BoardLink board="全体" symbols={new Set(["7203"])} className="font-num text-xs underline" />);
    expect(all).not.toContain("href");
    expect(all).toContain("全体の掲示板");
    expect(all).toContain("font-num text-xs");
    expect(all).not.toContain("underline");
  });

  it("銘柄のページにする記号は、知っている銘柄だけ（全体の別の書き方・小文字・存在しない記号は含めない）", () => {
    const v = view();
    expect([...boardSymbols(v)]).toEqual(["TSTA"]);
    for (const b of BOARDS.filter((b) => b !== "TSTA")) expect(buildBoard(v, b)).toBeNull();
    expect(buildBoard(v, "TSTA")).not.toBeNull();
  });

  it("流れ・AIのページ・タイムラインは、知らない掲示板を /symbols/ へのリンクにしない", () => {
    const v = view();
    const symbols = boardSymbols(v);
    const feed = BOARDS.map((b, i) => ({ key: `p${i}`, timeText: "11/9 10:00", kind: "post" as const, label: "投稿", color: "#fff", text: "本文", symbol: b }));
    const html = renderToStaticMarkup(<LiveFeedView feed={feed} symbols={symbols} />);
    expect([...html.matchAll(/href="(\/symbols\/[^"]*)"/g)].map((m) => m[1])).toEqual(["/symbols/TSTA"]);

    const page = renderToStaticMarkup(<AgentPageView page={buildAgentPage(v, new Map(), "ai-x")!} symbols={symbols} />);
    expect([...page.matchAll(/href="(\/symbols\/[^"]*)"/g)].map((m) => m[1]).filter((h) => h !== "/symbols/TSTA")).toEqual([]);

    for (const item of v.timeline.filter((t) => t.kind === "post")) {
      const out = renderToStaticMarkup(<TimelineItemView item={item} symbols={symbols} />);
      const linked = out.includes("/symbols/");
      expect(linked).toBe(item.kind === "post" && item.symbol === "TSTA");
    }
  });
});
