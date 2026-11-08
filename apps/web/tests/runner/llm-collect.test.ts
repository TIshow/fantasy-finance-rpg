// 毎日の実行の受け取りと判断の段（翌朝 06:50・07:20。#179）の試験。本物の API は呼ばない（偽の提供元）。
// GitHub Actions と同じく、決まった時刻まで待たずに、時計を合わせて回す。
import { describe, expect, it } from "vitest";
import { replay } from "../../src/events/replay";
import { jst } from "../contracts/fakes";
import { answer } from "./llm-fakes";
import { DAYS, llmWorld, p } from "./llm-world";

const D0 = DAYS[0]!;
const D1 = DAYS[1]!;
const good = JSON.stringify({ post: { board: "VRN1", text: "決算を見て少し買う" }, orders: [{ symbol: "VRN1", side: "buy", qty: 100 }], note: "決算" });

/** D0 を回し（判断・板寄せ・引け後・D1 の分の依頼）、D1 の朝の手前まで進める */
async function evening(dryRun = false) {
  const w = await llmWorld({ dailyCostLimit: 1000, dryRun }, { manualClock: true });
  for (const [h, m] of [[6, 50], [9, 35], [16, 35]] as const) await w.runAt(D0, h, m);
  return w;
}
const collectOf = (r: { stage: string; detail?: string }[]) => r.find((x) => x.stage === "llm.collect");
const llmRuns = async (w: Awaited<ReturnType<typeof evening>>, id: string) => (await w.of("agent.run")).filter((e) => p(e).agentId === id);

describe("受け取りと判断（06:50・07:20）", async () => {
  const w = await evening();
  w.llm.providers.anthropic!.outcome = () => answer(good);
  w.llm.providers.openai!.outcome = () => answer(good, { truncated: true });
  // 依頼のあとに取り下げた投稿は、作り直しの入力に影響しない（予約より前の取り下げだけを見る）
  const post = (await w.of("post.published"))[0];
  if (post) await w.store.append({ type: "content.withdrawn", actor: "operator:owner", refs: [post.seq], payload: { targetSeq: post.seq, reason: "試験", bodyErased: false } });
  const first = await w.runAt(D1, 6, 50);

  it("答えがあれば閉じた記録を書き、出力を読んで、投稿と注文票を締めの前に確定する（判断の記録は元のバッチと入力を指す）", async () => {
    const closed = (await w.of("llm.batch.closed")).filter((e) => p(e).agentId === "ai-claude");
    expect(closed.map((e) => [p(e).result, p(e).inputTokens, p(e).outputTokens])).toEqual([["collected", 5000, 800]]);
    const runs = await llmRuns(w, "ai-claude");
    expect(runs.map((e) => [p(e).purpose, p(e).ok, p(e).batchSeq])).toEqual([["post", true, closed[0]!.seq], ["order", true, closed[0]!.seq]]);
    const sub = (await w.of("llm.batch.submitted")).find((e) => p(e).agentId === "ai-claude")!;
    expect(runs.every((r) => (p(r).inputSeqs as number[]).every((s) => s < sub.seq) && p(r).sentBodyHash === p(sub).sentBodyHash)).toBe(true);
    expect(runs[0]!.recordedAt).toBeLessThan(jst(D1, 8, 30));
    const posts = (await w.of("post.published")).filter((e) => p(e).agentId === "ai-claude");
    expect(posts.map((e) => [p(e).board, w.values.body(p(e).bodyHash as string)?.value])).toEqual([["VRN1", "決算を見て少し買う"]]);
    const sheet = (await w.of("order_sheet.committed")).find((e) => p(e).agentId === "ai-claude" && p(e).tradingDate === D1)!;
    expect(p(sheet).orders).toEqual([{ symbol: "VRN1", side: "buy", qty: 100 }]);
  });

  it("出力が上限で切れた答えは、閉じたうえで invalid_output の失敗を残し、その日は注文しない", async () => {
    const runs = await llmRuns(w, "ai-gpt");
    expect(runs.map((e) => [p(e).ok, p(e).errorCode, typeof p(e).batchSeq])).toEqual([[false, "invalid_output", "number"]]);
    expect((await w.of("order_sheet.committed")).some((e) => p(e).agentId === "ai-gpt")).toBe(false);
    expect(collectOf(first)).toMatchObject({ status: "written", detail: expect.stringContaining("ai-gpt:invalid_output (truncated)") });
  });

  it("答えがまだなければ待ち、07:20 の実行で受け取る。済んだAIは二重に書かない", async () => {
    expect(collectOf(first)!.detail).toContain("waiting: ai-gemini");
    w.llm.providers.google!.outcome = () => answer(JSON.stringify({ post: null, orders: [] }));
    const before = (await w.all()).length;
    const second = await w.runAt(D1, 7, 20);
    expect(collectOf(second)).toMatchObject({ status: "written" });
    const added = (await w.all()).slice(before);
    expect(added.map((e) => [e.type, p(e).agentId])).toEqual([
      ["llm.batch.closed", "ai-gemini"],
      ["agent.run", "ai-gemini"],
      ["order_sheet.committed", "ai-gemini"],
    ]);
    await replay(await w.all(), w.values, { holidayTables: w.holidayTables });
  });
});

describe("締めでの打ち切り・止まったあとのやり直し・試運転", () => {
  it("締め（8:30）を過ぎても答えがなければ、取り消しを頼み、予約した費用で閉じ、失敗（timeout）を残す", async () => {
    const w = await evening();
    await w.runAt(D1, 9, 35);
    const closed = await w.of("llm.batch.closed");
    expect(closed.map((e) => [p(e).result, p(e).costUnknown, p(e).cost])).toEqual([["expired", true, 64], ["expired", true, 224], ["expired", true, 36]]);
    expect(Object.values(w.llm.providers).map((f) => f.cancels.length)).toEqual([1, 1, 1]);
    expect((await w.of("agent.run")).filter((e) => p(e).errorCode === "timeout").map((e) => p(e).agentId)).toEqual(["ai-claude", "ai-gpt", "ai-gemini"]);
    await replay(await w.all(), w.values, { holidayTables: w.holidayTables });
  });

  it("送った結果が分からなかった依頼は、提供元で探す。見つかればバッチのIDを記録して受け取り、見つからないまま40分たてば予約した費用で閉じる", async () => {
    const w = await llmWorld(undefined, { manualClock: true });
    w.llm.providers.openai!.send = () => ({ ok: false, errorCode: "timeout", billingUnknown: true });
    w.llm.providers.google!.send = () => ({ ok: false, errorCode: "timeout", billingUnknown: true });
    // 依頼は夜遅く（23:50）の実行で行う
    for (const [h, m] of [[6, 50], [9, 35], [23, 50]] as const) await w.runAt(D0, h, m);
    w.llm.providers.openai!.find = () => ({ status: "found", batchId: "openai-found-1" });
    w.llm.providers.openai!.outcome = () => answer(good);
    // 依頼から40分たつまでは、見つからなくても閉じない
    await w.runAt(D1, 0, 10);
    expect((await w.of("llm.batch.closed")).map((e) => p(e).agentId)).toEqual(["ai-gpt"]);
    await w.runAt(D1, 0, 40);
    expect((await w.of("llm.batch.sent")).find((e) => p(e).agentId === "ai-gpt")).toMatchObject({ payload: { batchId: "openai-found-1" } });
    const closed = await w.of("llm.batch.closed");
    expect(closed.map((e) => [p(e).agentId, p(e).result, p(e).costUnknown ?? false])).toEqual([["ai-gpt", "collected", false], ["ai-gemini", "failed", true]]);
    expect((await w.of("order_sheet.committed")).some((e) => p(e).agentId === "ai-gpt" && p(e).tradingDate === D1)).toBe(true);
    // 閉じたあとも締めまでは探し、見つけたら取り消しを頼む（記録は増やさない）
    w.llm.providers.google!.find = () => ({ status: "found", batchId: "google-late-1" });
    const before = (await w.all()).length;
    await w.runAt(D1, 7, 20);
    expect(w.llm.providers.google!.cancels).toEqual(["google-late-1"]);
    expect((await w.all()).slice(before).filter((e) => p(e).agentId === "ai-gemini")).toEqual([]);
    await replay(await w.all(), w.values, { holidayTables: w.holidayTables });
  });

  it("閉じた記録を書いたあとに落ちたら、次の実行で提供元から受け取り直して、判断の記録から続ける", async () => {
    const w = await evening();
    w.llm.providers.anthropic!.outcome = () => answer(good);
    const inner = w.deps.store;
    let crash = true;
    w.deps.store = { ...inner, read: inner.read.bind(inner), last: inner.last.bind(inner), commitSheet: inner.commitSheet.bind(inner), append: (d) => (crash && d.type === "agent.run" && d.payload.agentId === "ai-claude" ? ((crash = false), Promise.reject(new Error("crashed"))) : inner.append(d)) };
    expect(collectOf(await w.runAt(D1, 6, 50))).toMatchObject({ detail: "error: crashed" });
    expect((await w.of("llm.batch.closed")).map((e) => p(e).agentId)).toEqual(["ai-claude"]);
    await w.runAt(D1, 7, 20);
    expect((await llmRuns(w, "ai-claude")).map((e) => [p(e).purpose, p(e).ok])).toEqual([["post", true], ["order", true]]);
    expect((await w.of("order_sheet.committed")).some((e) => p(e).agentId === "ai-claude" && p(e).tradingDate === D1)).toBe(true);
  });

  it("試運転（dryRun）の間は、投稿だけを書き、注文票は書かない", async () => {
    const w = await evening(true);
    w.llm.providers.anthropic!.outcome = () => answer(good);
    await w.runAt(D1, 6, 50);
    expect((await llmRuns(w, "ai-claude")).map((e) => p(e).purpose)).toEqual(["post"]);
    expect((await w.of("post.published")).some((e) => p(e).agentId === "ai-claude")).toBe(true);
    expect((await w.of("order_sheet.committed")).some((e) => p(e).agentId === "ai-claude" && p(e).tradingDate === D1)).toBe(false);
    // 翌日の引け後の処理と評価は、注文票がなくても進む
    await w.runAt(D1, 9, 35);
    await w.runAt(D1, 16, 35);
    expect((await w.of("valuation.recorded")).some((e) => p(e).agentId === "ai-claude" && p(e).date === D1)).toBe(true);
  });
});
