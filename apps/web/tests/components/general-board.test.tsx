import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentPageView } from "../../src/components/AgentPageView";
import { BoardLink } from "../../src/components/BoardLink";
import { GeneralBoardPageView } from "../../src/components/GeneralBoardPageView";
import { buildAgentPage, failureText } from "../../src/view/agent-page";
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
    expect(out.filter((i) => i.kind === "failed").map((i) => i.text)).toEqual(["判断が出ませんでした（エラーコード：weird）", "判断が出ませんでした（エラーコード：記載なし）"]);
    expect(out.filter((i) => i.kind !== "post")).toHaveLength(2);
    expect(failureText("constructor")).toContain("エラーコード");
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
        run({ ok: true, outputHash: "o", dryRun: true }),
        ev("post.published", { agentId: "ai-x", board: "全体", bodyHash: "h1", citeSeqs: [], runSeq: 2 }),
      ],
      () => "本文",
    );
    const out = buildAgentPage(v, new Map(), "ai-x")!.decisions.flatMap((d) => d.items);
    expect(out.map((i) => [i.kind, i.dryRun])).toEqual([["post", true]]);
  });
});
