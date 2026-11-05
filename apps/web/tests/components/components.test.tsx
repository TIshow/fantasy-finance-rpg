import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DISCLAIMER, Shell } from "../../src/components/Shell";
import { TimelineItemView } from "../../src/components/TimelineItemView";
import { buildView } from "../../src/view/build";
import { formatJst } from "../../src/view/format";
import AgentsPage from "../../src/app/agents/page";
import SymbolPage from "../../src/app/symbols/[symbol]/page";
import { buildGoldenLog } from "../fixtures/golden";

describe("画面の部品（ゴールデンログ）", async () => {
  const g = await buildGoldenLog(20261104);
  const view = buildView(g.events, (h) => g.bodies.get(h)?.value);
  const html = renderToStaticMarkup(
    <Shell>
      <ol>
        {view.timeline.map((item, i) => (
          <TimelineItemView key={i} item={item} />
        ))}
      </ol>
    </Shell>,
  );

  it("上部に模擬売買の注意書きがあり、タイムラインの全項目が出る", () => {
    expect(html.indexOf(DISCLAIMER)).toBeGreaterThanOrEqual(0);
    expect(html.indexOf(DISCLAIMER)).toBeLessThan(html.indexOf("<ol>"));
    expect(html.match(/<time /g)?.length).toBe(view.timeline.length);
  });

  it("人間が入力・操作する要素（フォーム・入力欄・ボタン）がない", () => {
    expect(html).not.toMatch(/<(form|input|textarea|select|button)\b/i);
  });

  it("日本時間の表示は環境に依らない", () => {
    expect(formatJst(Date.parse("2026-11-09T21:00:01+09:00"))).toBe("2026-11-09 21:00:01");
    expect(formatJst(Date.parse("2026-11-12T03:00:00+09:00"))).toBe("2026-11-12 03:00:00");
  });

  it("非表示の投稿は、本文があっても出さず、理由（なければ定めた文）を同じ位置に出す", () => {
    const post = view.timeline.find((t) => t.kind === "post")!;
    if (post.kind !== "post") throw new Error();
    expect(post.text).toContain("架空のデータ");
    const out = (reason: string) => renderToStaticMarkup(<TimelineItemView item={{ ...post, withdrawn: { seq: 999, reason } }} />);
    expect(out("確認用")).toContain("非表示（確認用）");
    expect(out("確認用")).not.toContain("架空のデータ");
    expect(out("")).toContain("非表示（理由の記載なし）");
  });

  it("直近の終値で評価した評価は、その旨を出す（評価の項目と成績の表）", async () => {
    const v = view.timeline.find((t) => t.kind === "valuation")!;
    if (v.kind !== "valuation") throw new Error();
    const pos = { symbol: "TSTA", qty: 100, price: 10, priceText: "1円", closeSeq: 1 };
    const fresh = renderToStaticMarkup(<TimelineItemView item={{ ...v, positions: [{ ...pos, stale: false }] }} />);
    const stale = renderToStaticMarkup(<TimelineItemView item={{ ...v, positions: [{ ...pos, stale: true }] }} />);
    expect(fresh).not.toContain("直近の終値で評価");
    expect(stale).toContain("直近の終値で評価：TSTA");
    const page = renderToStaticMarkup(await AgentsPage());
    expect(page).toContain("順位");
    expect(page).not.toContain("直近の終値で評価"); // ゴールデンログには古い終値の評価がない
  });

  it("成績・銘柄スレッドの画面にも入力の要素がなく、知らない銘柄は404（not-found）", async () => {
    const agents = renderToStaticMarkup(await AgentsPage());
    const thread = renderToStaticMarkup(await SymbolPage({ params: Promise.resolve({ symbol: "TSTB" }) }));
    expect(thread).toContain("掲示板");
    expect(agents).not.toMatch(/<(form|input|textarea|select|button)\b/i);
    // 掲示板で操作できるのは、種類の絞り込みのボタンだけ（フォーム・入力欄・送信するボタンはない）
    expect(thread).not.toMatch(/<(form|input|textarea|select)\b/i);
    expect([...thread.matchAll(/<button\b[^>]*>/g)].every((m) => m[0].includes('type="button"'))).toBe(true);
    await expect(SymbolPage({ params: Promise.resolve({ symbol: "NOPE" }) })).rejects.toThrow();
  });
});
