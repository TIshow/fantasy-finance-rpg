import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentPageView } from "../../src/components/AgentPageView";
import { BoardLink } from "../../src/components/BoardLink";
import { GeneralBoardPageView } from "../../src/components/GeneralBoardPageView";
import { buildAgentPage, failureText } from "../../src/view/agent-page";
import { TimelineItemView } from "../../src/components/TimelineItemView";
import { Shell } from "../../src/components/Shell";
import { buildAllBoard } from "../../src/view/board";
import { buildView } from "../../src/view/build";
import type { LogEvent } from "../../src/events/types";

const AT = Date.parse("2026-11-09T10:00:00+09:00");
let n = 0;
const ev = (type: LogEvent["type"], payload: object): LogEvent => ({ seq: ++n, schema: 1, type, recordedAt: AT + n * 1000, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" });
const run = (extra: object) => ev("agent.run", { agentId: "ai-x", purpose: "order", model: { provider: "anthropic", modelId: "m1", settings: {} }, prompt: { id: "p", version: "1", hash: "h" }, inputSeqs: [], requestHash: "r", startedAt: AT, finishedAt: AT, ...extra });

const view = (runs: object[]) => {
  n = 0;
  return buildView(
    [
      ev("agent.registered", { agentId: "ai-x", displayName: "あ", startDate: "2026-11-09", initialCash: 1000 }),
      ev("post.published", { agentId: "ai-x", board: "全体", bodyHash: "h1", citeSeqs: [], runSeq: 99 }),
      ev("post.published", { agentId: "ai-x", board: "7203", bodyHash: "h2", citeSeqs: [], runSeq: 99 }),
      ...runs.map(run),
    ],
    (h) => `本文-${h}`,
  );
};

describe("「全体」の掲示板のページ", () => {
  it("「全体」の投稿だけを一覧にし、銘柄の投稿は含めない", () => {
    const v = view([]);
    expect(buildAllBoard(v).posts.map((p) => p.text)).toEqual(["本文-h1"]);
    const html = renderToStaticMarkup(<GeneralBoardPageView view={v} />);
    expect(html).toContain("全体の掲示板");
    expect(html).toContain("本文-h1");
    expect(html).not.toContain("本文-h2");
  });

  it("投稿がなくても作れる", () => {
    n = 0;
    const html = renderToStaticMarkup(<GeneralBoardPageView view={buildView([], () => undefined)} />);
    expect(html).toContain("まだ投稿がありません");
  });

  it("BoardLink は「全体」を /board にリンクする", () => {
    const html = renderToStaticMarkup(<BoardLink board="全体" symbols={new Set(["7203"])} className="underline" />);
    expect(html).toContain('href="/board"');
  });
});

describe("失敗した判断と試運転", () => {
  const items = (runs: object[]) => buildAgentPage(view(runs), new Map(), "ai-x")!.decisions.flatMap((d) => d.items);

  it("エラーコードごとに、ふつうの言葉で「判断に失敗」の行を出す", () => {
    const codes = ["budget_exceeded", "timeout", "rate_limited", "provider_error", "invalid_output"];
    const out = items(codes.map((errorCode) => ({ ok: false, errorCode })));
    const failed = out.filter((i) => i.kind === "failed");
    expect(failed.map((i) => i.text)).toEqual(codes.map(failureText));
    expect(new Set(failed.map((i) => i.text)).size).toBe(5);
    expect(failed[0]!.text).toContain("費用の上限");
    expect(failed[0]!.label).toBe("判断に失敗");
    expect(failed[0]!.model).toMatchObject({ text: "Anthropic · m1" });
  });

  it("知らないコード・コードなしでも落ちずに出す。成功した判断は行にしない", () => {
    const out = items([{ ok: false, errorCode: "weird" }, { ok: false }, { ok: true, outputHash: "o" }]);
    expect(out.filter((i) => i.kind === "failed").map((i) => i.text)).toEqual(["判断が出ませんでした（理由の分類なし）", "判断が出ませんでした（理由の分類なし）"]);
    expect(out.filter((i) => i.kind !== "post")).toHaveLength(2);
    expect(failureText("constructor")).toBe("判断が出ませんでした（理由の分類なし）");
  });

  it("画面に失敗の説明を出す", () => {
    const page = buildAgentPage(view([{ ok: false, errorCode: "budget_exceeded" }]), new Map(), "ai-x")!;
    const html = renderToStaticMarkup(<AgentPageView page={page} />);
    expect(html).toContain("判断に失敗");
    expect(html).toContain("費用の上限");
  });

  it("dryRun が true の判断だけ試運転の印を付ける。ない・true 以外は付けない", () => {
    const flag = (extra: object) => {
      const page = buildAgentPage(view([{ ok: false, errorCode: "budget_exceeded", ...extra }]), new Map(), "ai-x")!;
      return [items([{ ok: false, errorCode: "timeout", ...extra }]).find((i) => i.kind === "failed")!.dryRun, renderToStaticMarkup(<AgentPageView page={page} />).includes("試運転")] as const;
    };
    expect(flag({ dryRun: true })).toEqual([true, true]);
    expect(flag({})).toEqual([false, false]);
    expect(flag({ dryRun: "true" })).toEqual([false, false]);
    expect(flag({ dryRun: 1 })).toEqual([false, false]);
  });

  it("試運転の判断から出た投稿にも印が付く", () => {
    n = 0;
    const v = buildView(
      [
        ev("agent.registered", { agentId: "ai-x", displayName: "あ", startDate: "2026-11-09", initialCash: 1000 }),
        run({ purpose: "post", ok: true, outputHash: "o", dryRun: true }),
        ev("post.published", { agentId: "ai-x", board: "全体", bodyHash: "h1", citeSeqs: [], runSeq: 2 }),
      ],
      () => "本文",
    );
    const out = buildAgentPage(v, new Map(), "ai-x")!.decisions.flatMap((d) => d.items);
    expect(out.map((i) => [i.kind, i.dryRun])).toEqual([["post", true]]);
  });
});

import { SymbolPageView } from "../../src/components/SymbolPageView";
const BoardViewFor = ({ view }: { view: ReturnType<typeof buildView> }) => <SymbolPageView view={view} symbol="7203" />;

describe("追加の確認（レビュー対応）", () => {
  const reg = () => ev("agent.registered", { agentId: "ai-x", displayName: "あ", startDate: "2026-11-09", initialCash: 1000 });

  it("失敗した判断の message・requestId などの余計な項目は画面に出ない", () => {
    n = 0;
    const v = buildView([reg(), run({ ok: false, errorCode: "provider_error", message: "SECRET-MSG", requestId: "req_SECRET" })], () => undefined);
    const html = renderToStaticMarkup(<AgentPageView page={buildAgentPage(v, new Map(), "ai-x")!} />);
    expect(html).toContain("判断に失敗");
    expect(html).not.toContain("SECRET");
  });

  it("非表示の投稿は /board に理由だけを出す。AIでない記録者の投稿にはAIのページへのリンクを付けない", () => {
    n = 0;
    const v = buildView(
      [
        reg(),
        ev("post.published", { agentId: "ai-x", board: "全体", bodyHash: "h1", citeSeqs: [], runSeq: 9 }),
        ev("post.published", { agentId: "stranger", board: "全体", bodyHash: "h2", citeSeqs: [], runSeq: 9 }),
        ev("content.withdrawn", { targetSeq: 2, reason: "誤り" }),
      ],
      (h) => `本文-${h}`,
    );
    const html = renderToStaticMarkup(<GeneralBoardPageView view={v} />);
    expect(html).toContain("非表示（誤り）");
    expect(html).not.toContain("本文-h1");
    expect(html).toContain("本文-h2");
    expect(html).not.toContain("/agents/stranger");
  });

  it("試運転の判断から出た投稿に、掲示板・タイムラインの両方で印が付く。銘柄の掲示板から全体の投稿への返信は /board へリンクする", () => {
    n = 0;
    const v = buildView(
      [
        reg(),
        ev("universe.set", { symbols: ["7203"] }),
        run({ purpose: "post", ok: true, outputHash: "o", dryRun: true }),
        ev("post.published", { agentId: "ai-x", board: "全体", bodyHash: "h1", citeSeqs: [], runSeq: 3 }),
        ev("post.published", { agentId: "ai-x", board: "7203", bodyHash: "h2", citeSeqs: [], replyTo: 4, runSeq: 99 }),
      ],
      (h) => `本文-${h}`,
    );
    const post = v.timeline.find((t) => t.kind === "post" && t.symbol === "全体")!;
    expect(renderToStaticMarkup(<GeneralBoardPageView view={v} />)).toContain("試運転");
    expect(renderToStaticMarkup(<TimelineItemView item={post} />)).toContain("試運転");
    const other = v.timeline.find((t) => t.kind === "post" && t.symbol === "7203")!;
    expect(renderToStaticMarkup(<TimelineItemView item={other} />)).not.toContain("試運転");
    const stock = renderToStaticMarkup(<BoardViewFor view={v} />);
    expect(stock).toContain('href="/board#post-4"');
  });

  it("試運転の拒否は専用の文、成功した試運転の注文の判断は行になる", () => {
    n = 0;
    const v = buildView(
      [
        reg(),
        run({ ok: true, outputHash: "o", dryRun: true }),
        ev("order_sheet.rejected", { agentId: "ai-x", tradingDate: "2026-11-10", reason: "invalid_sheet", runSeq: 2 }),
        run({ ok: true, outputHash: "o2", dryRun: true }),
      ],
      () => undefined,
    );
    const items = buildAgentPage(v, new Map(), "ai-x")!.decisions.flatMap((d) => d.items);
    expect(items.find((i) => i.kind === "rejected")!.text).toBe("試運転の判断のため、注文にしませんでした");
    expect(items.filter((i) => i.kind === "dry").map((i) => [i.runSeq, i.text])).toEqual([[4, "試運転：注文は出していません"]]);
  });

  it("上のメニューに全体の掲示板がある", () => {
    const html = renderToStaticMarkup(<Shell>x</Shell>);
    expect(html).toContain('href="/board"');
  });
});
