import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardLink } from "../../src/components/BoardLink";
import { LiveFeedView } from "../../src/components/ArenaCardView";
import { buildBoard, isSymbolBoard } from "../../src/view/board";
import { buildView } from "../../src/view/build";
import type { LogEvent } from "../../src/events/types";

describe("「全体」の掲示板（銘柄ではないのでページへのリンクにしない）", () => {
  it("銘柄はリンク、全体は文字だけ", () => {
    expect(isSymbolBoard("7203")).toBe(true);
    expect(isSymbolBoard("全体")).toBe(false);
    const sym = renderToStaticMarkup(<BoardLink board="7203" suffix=" 掲示板" />);
    expect(sym).toContain('href="/symbols/7203"');
    const all = renderToStaticMarkup(<BoardLink board="全体" suffix=" 掲示板" />);
    expect(all).not.toContain("href");
    expect(all).toContain("全体の掲示板");
  });

  it("ライブの流れの投稿も、全体はリンクにしない", () => {
    const item = { key: "post-1", timeText: "11/9 10:00", kind: "post" as const, label: "投稿", color: "#fff", text: "本文" };
    expect(renderToStaticMarkup(<LiveFeedView feed={[{ ...item, symbol: "全体" }]} />)).not.toContain("/symbols/");
    expect(renderToStaticMarkup(<LiveFeedView feed={[{ ...item, symbol: "7203" }]} />)).toContain("/symbols/7203");
  });

  it("全体の掲示板に投稿があっても、銘柄のページは作らない（buildBoard は null）", () => {
    const e: LogEvent = { seq: 1, schema: 1, type: "post.published", recordedAt: Date.parse("2026-11-09T10:00:00+09:00"), actor: "system", keys: [], refs: [], payload: { agentId: "ai-x", board: "全体", bodyHash: "h", citeSeqs: [], runSeq: 1 }, prevHash: "", hash: "" };
    const view = buildView([e], () => "本文");
    expect(view.threads.map((t) => t.symbol)).toContain("全体");
    expect(buildBoard(view, "全体")).toBeNull();
  });
});
