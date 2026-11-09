// 検証役（#179、PR #223・#224）：試運転の印（lead の決定1）と、80円を超える日の失敗の記録（決定4）を、毎日の実行を通して壊しにいく。
// 決まり：試運転かどうかは、依頼の記録（16:35 の llm.batch.submitted）の dryRun で決まる。その依頼から書く agent.run はすべて同じ印を持ち、
// 印のある依頼の判断は、日の途中で LLM_DRY_RUN を切っても、注文票にならない。80円を超える設定の日は送らず、AIごとに1日1回
// budget_exceeded の失敗を残し、段の結果は失敗（error:）。偽の提供元と架空の市場の世界を使う。本物の API は呼ばない。欠陥の再現は it.fails。
import { describe, expect, it } from "vitest";
import { sealEvent } from "../../src/events/chain";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { runDay } from "../../src/runner/day";
import { llmFailed } from "../../scripts/daily-lib";
import { jst } from "../contracts/fakes";
import { answer } from "../runner/llm-fakes";
import { DAYS, LLM_IDS, llmWorld, p } from "../runner/llm-world";

const [D0, D1, D2] = [DAYS[0]!, DAYS[1]!, DAYS[2]!];
const good = JSON.stringify({ post: { board: "VRN1", text: "決算を見て少し買う" }, orders: [{ symbol: "VRN1", side: "buy", qty: 100 }], note: "決算" });
const BUY = [{ symbol: "VRN1", side: "buy" as const, qty: 100 }];
type World = Awaited<ReturnType<typeof llmWorld>>;
const isLlm = (e: LogEvent) => LLM_IDS.includes(p(e).agentId as string);
const setDry = (w: World, dryRun: boolean) => {
  w.deps.llm = { ...w.deps.llm!, policy: { dailyCostLimit: 1000, dryRun } };
};
const sheetsOf = async (w: World, date: string) => (await w.all()).filter((e) => (e.type === "order_sheet.committed" || e.type === "order_sheet.rejected") && isLlm(e) && p(e).tradingDate === date);
const replayOf = (w: World, events: readonly LogEvent[]) => replay(events, w.values, { holidayTables: w.holidayTables });
/** 保存済みのログの一部を書き換えて、連鎖を作り直す（追記の検査を通らずに保存されたもの） */
async function reseal(events: readonly LogEvent[], edit: (e: LogEvent) => Record<string, unknown>): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  for (const e of events) out.push(await sealEvent(out.at(-1) ?? null, { type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: edit(e) } as Parameters<typeof sealEvent>[1]));
  return out;
}
const without = (o: Record<string, unknown>, k: string) => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k));

describe("試運転の切り替えをどの時点で行っても（16:35・06:50・07:20・08:00 の前。答えは 06:50 か 07:20 に届く）", () => {
  // 各時点の LLM_DRY_RUN の組み合わせを全部試す。期待：16:35 で試運転なら、①とその日の LLM の agent.run はすべて印つきで、注文票は1枚もない。
  // 16:35 で本物なら、印はどこにもなく、答えが届いたあと締めの前に一度でも本物の時点があれば、3体とも注文票を確定する
  const at = [[D0, 16, 35], [D1, 6, 50], [D1, 7, 20], [D1, 8, 0]] as const;
  const cases: { dry: boolean[]; arrive: 6 | 7 }[] = [];
  for (let bits = 0; bits < 16; bits++) for (const arrive of [6, 7] as const) cases.push({ dry: at.map((_, i) => ((bits >> i) & 1) === 1), arrive });
  it.each(cases)("試運転 $dry・答えは $arrive 時台", async ({ dry, arrive }) => {
    const w = await llmWorld({ dailyCostLimit: 1000, dryRun: dry[0]! }, { manualClock: true });
    for (const [h, m] of [[6, 50], [9, 35]] as const) await w.runAt(D0, h, m);
    for (const f of Object.values(w.llm.providers)) f.outcome = () => (w.clock.now() >= jst(D1, arrive === 6 ? 6 : 7, arrive === 6 ? 50 : 20) ? answer(good) : "pending");
    for (const [i, [d, h, m]] of at.entries()) {
      setDry(w, dry[i]!);
      await w.runAt(d, h, m);
    }
    await w.runAt(D1, 8, 29);
    await w.runAt(D1, 9, 35);
    const all = await w.all();
    const subs = all.filter((e) => e.type === "llm.batch.submitted" && p(e).tradingDate === D1);
    const runs = all.filter((e) => e.type === "agent.run" && isLlm(e) && e.recordedAt > jst(D0, 16, 35));
    const committed = (await sheetsOf(w, D1)).map((e) => e.type);
    const realAfterArrival = dry.slice(arrive === 6 ? 1 : 2).some((x) => !x);
    expect(subs.map((e) => p(e).dryRun)).toEqual(LLM_IDS.map(() => (dry[0] ? true : undefined)));
    expect(runs.length).toBe(6);
    expect(new Set(runs.map((e) => p(e).dryRun))).toEqual(new Set([dry[0] ? true : undefined]));
    expect(committed).toEqual(!dry[0] && realAfterArrival ? LLM_IDS.map(() => "order_sheet.committed") : []);
    await replayOf(w, all);
  });
});

describe("16:35 の依頼の段が途中で止まり、試運転を切ってから回し直したとき", () => {
  it("今の動き：回し直しで依頼した AI の①は印なしになり、その AI だけ翌朝に本物の注文票を確定する（同じ日に試運転と本物の AI が混ざる）", async () => {
    const w = await llmWorld({ dailyCostLimit: 1000, dryRun: true }, { manualClock: true });
    for (const [h, m] of [[6, 50], [9, 35]] as const) await w.runAt(D0, h, m);
    const base = w.deps.llm!;
    w.deps.llm = { ...base, portOf: (provider, c) => (provider === "openai" ? (() => { throw new Error("boom"); })() : base.portOf(provider, c)) };
    await w.runAt(D0, 16, 35);
    // 引けのあと（16:35 の実行のあと）に試運転を切り、口も直して回し直す
    w.deps.llm = { ...base, policy: { dailyCostLimit: 1000, dryRun: false } };
    await w.runAt(D0, 17, 0);
    for (const f of Object.values(w.llm.providers)) f.outcome = () => answer(good);
    await w.runAt(D1, 6, 50);
    expect((await w.of("llm.batch.submitted")).map((e) => [p(e).agentId, p(e).dryRun])).toEqual([["ai-claude", true], ["ai-gemini", true], ["ai-gpt", undefined]]);
    expect((await sheetsOf(w, D1)).map((e) => [e.type, p(e).agentId])).toEqual([["order_sheet.committed", "ai-gpt"]]);
  });
});

/** D1 を本物で回し（注文票を確定）、D1 の 16:35 から試運転にして、D2 の 06:50 に印つきの判断を書いた世界 */
async function dryD2() {
  const w = await llmWorld({ dailyCostLimit: 1000, dryRun: false }, { manualClock: true });
  for (const f of Object.values(w.llm.providers)) f.outcome = () => answer(good);
  for (const [h, m] of [[6, 50], [9, 35], [16, 35]] as const) await w.runAt(D0, h, m);
  for (const [h, m] of [[6, 50], [9, 35]] as const) await w.runAt(D1, h, m);
  setDry(w, true);
  await w.runAt(D1, 16, 35);
  await w.runAt(D2, 6, 50);
  setDry(w, false);
  w.clock.set(jst(D2, 7, 0));
  const runs = (await w.of("agent.run")).filter(isLlm);
  const runOf = (id: string, purpose: string, date: string) => runs.find((e) => p(e).agentId === id && p(e).purpose === purpose && e.recordedAt >= jst(date, 6, 0) && e.recordedAt < jst(date, 9, 0))!;
  return { w, runOf };
}

describe("試運転の判断から、どの道でも注文票を確定できない（保管の commitSheet を直接呼ぶ）", () => {
  it("印のある自分の注文の判断・自分の投稿の判断・別の AI の注文の判断は、どれも拒否（invalid_sheet）になる", async () => {
    const { w, runOf } = await dryD2();
    expect(p(runOf("ai-claude", "order", D2)).dryRun).toBe(true);
    for (const run of [runOf("ai-claude", "order", D2), runOf("ai-claude", "post", D2), runOf("ai-gpt", "order", D2)]) {
      const r = await w.store.commitSheet("ai-claude", { tradingDate: D2, orders: BUY, runSeq: run.seq, inputSeqs: [] });
      expect([r.ok, r.ok && r.event.type, r.ok && p(r.event).reason], String(run.seq)).toEqual([true, "order_sheet.rejected", "invalid_sheet"]);
    }
    expect((await sheetsOf(w, D2)).filter((e) => e.type === "order_sheet.committed")).toEqual([]);
    await replayOf(w, await w.all());
  });

  // 前は【低・宛先 core】の欠陥として it.fails にしていた：注文票の検査は元の run の取引日を見ないので、前の取引日の本物の判断の run を、
  // 試運転の日（今日）の注文票の runSeq に使えた。#228（core の PR #230）で、11/10 以後の取引日では、元の判断（agent.run）が
  // 受け付けの始まり（前の取引日の引け 16:30）より前なら invalid_sheet で拒むようになり、直った。前の取引日の判断は、必ずその前に記録されている。
  // 11/9 以前の取引日には、この検査を当てない（記録の照合を変えないため）。そこでは前のままだが、もう過ぎた日なので新しい注文票は出せない
  it("前の取引日の本物の注文の判断を、試運転の日の注文票に使い回せない（#228 で直った）", async () => {
    const { w, runOf } = await dryD2();
    const old = runOf("ai-claude", "order", D1);
    expect([p(old).dryRun, p(old).batchSeq === undefined]).toEqual([undefined, false]);
    const r = await w.store.commitSheet("ai-claude", { tradingDate: D2, orders: BUY, runSeq: old.seq, inputSeqs: [] });
    expect([r.ok && r.event.type, r.ok && p(r.event).reason]).toEqual(["order_sheet.rejected", "invalid_sheet"]);
    expect((await sheetsOf(w, D2)).filter((e) => e.type === "order_sheet.committed")).toEqual([]);
    await replayOf(w, await w.all());
  });

  // 分かっている限界（lead）：LLM の AI か規則の AI かは記録からは見分けられないので、batchSeq のない run は印を確かめられない
  it("今の動き（分かっている限界）：batchSeq のない、印のない注文の判断を system が書けば、試運転の日の LLM の AI でも確定する", async () => {
    const { w } = await dryD2();
    const run = await w.store.append({ type: "agent.run", actor: "system", refs: [], payload: { agentId: "ai-gemini", purpose: "order", inputSeqs: [], ok: true } });
    expect(run.ok).toBe(true);
    const r = await w.store.commitSheet("ai-gemini", { tradingDate: D2, orders: BUY, runSeq: run.ok ? run.event.seq : 0, inputSeqs: [] });
    expect(r.ok && r.event.type).toBe("order_sheet.committed");
  });

  it("印の食い違う run（印なしの run を、印のある①の答えから書く）は追記で断る", async () => {
    const { w, runOf } = await dryD2();
    const run = runOf("ai-claude", "order", D2);
    const r = await w.store.append({ type: "agent.run", actor: "system", refs: [...run.refs], payload: { ...without(p(run), "dryRun"), purpose: "order" } });
    expect(r.ok ? "ok" : r.reason).not.toBe("ok");
  });
});

describe("保存済みのログの照合（replay）は、印の食い違いを断る", () => {
  it("①の印だけ・run の印だけを消したログは落ちる。①と run の印を両方消すと、残した拒否（invalid_sheet）が出し直せずに落ちる", async () => {
    const { w, runOf } = await dryD2();
    const orderRun = runOf("ai-claude", "order", D2);
    await w.store.commitSheet("ai-claude", { tradingDate: D2, orders: BUY, runSeq: orderRun.seq, inputSeqs: [] });
    const all = await w.all();
    await replayOf(w, all);
    const sub = all.find((e) => e.type === "llm.batch.submitted" && p(e).agentId === "ai-claude" && p(e).tradingDate === D2)!;
    const mine = new Set(all.filter((e) => e.type === "agent.run" && p(e).agentId === "ai-claude" && p(e).dryRun === true).map((e) => e.seq));
    const subOnly = await reseal(all, (e) => (e.seq === sub.seq ? without(p(e), "dryRun") : p(e)));
    await expect(replayOf(w, subOnly)).rejects.toThrow(/dryRun must match the batch submission/);
    const runOnly = await reseal(all, (e) => (e.seq === orderRun.seq ? without(p(e), "dryRun") : p(e)));
    await expect(replayOf(w, runOnly)).rejects.toThrow(/dryRun must match the batch submission/);
    const both = await reseal(all, (e) => (e.seq === sub.seq || mine.has(e.seq) ? without(p(e), "dryRun") : p(e)));
    await expect(replayOf(w, both)).rejects.toThrow();
    const flipped = await reseal(all, (e) => (e.seq === sub.seq ? { ...p(e), dryRun: false } : p(e)));
    await expect(replayOf(w, flipped)).rejects.toThrow(/dryRun must be true or left out/);
  });
});

describe("80円を超える設定の日（lead の決定4）", () => {
  const over = async (dryRun: boolean) => {
    const w = await llmWorld({ dailyCostLimit: 1000, dryRun }, { manualClock: true });
    w.deps.llm = { ...w.deps.llm!, yenPerUsd: 400 };
    for (const [h, m] of [[6, 50], [9, 35]] as const) await w.runAt(D0, h, m);
    return w;
  };
  const budgetRuns = async (w: World) => (await w.of("agent.run")).filter((e) => isLlm(e) && p(e).errorCode === "budget_exceeded");

  it("その晩に何度回し直しても（17:00・23:59・日付を変えた 00:10）、失敗の記録は AI ごとに1件のまま、どこにも送らず、段は毎回 error:", async () => {
    const w = await over(false);
    const results = [await w.runAt(D0, 16, 35), await w.runAt(D0, 17, 0), await w.runAt(D0, 23, 59)];
    w.clock.set(jst(D1, 0, 10));
    results.push(await runDay(D0, w.deps));
    for (const r of results) expect(llmFailed(r)).toBe(true);
    expect((await budgetRuns(w)).map((e) => p(e).agentId)).toEqual(LLM_IDS);
    expect(Object.values(w.llm.providers).map((f) => f.sent.length)).toEqual([0, 0, 0]);
    expect(await w.of("llm.batch.submitted")).toEqual([]);
    await replayOf(w, await w.all());
  });

  it("試運転の日の失敗の記録には試運転の印が付き、翌朝の受け取りは何も書かず、注文票もない", async () => {
    const w = await over(true);
    await w.runAt(D0, 16, 35);
    const count = (await w.all()).length;
    await w.runAt(D1, 6, 50);
    expect((await budgetRuns(w)).map((e) => [p(e).dryRun, p(e).batchSeq])).toEqual(LLM_IDS.map(() => [true, undefined]));
    expect((await w.all()).filter((e) => e.seq > count && isLlm(e) && e.type !== "corporate_actions.applied").map((e) => e.type)).toEqual([]);
    expect(await sheetsOf(w, D1)).toEqual([]);
  });

  it("今の動き：その晩に設定を直して回し直しても、その日は送らない（1日1回）。次の営業日の晩は、ふつうに送る", async () => {
    const w = await over(false);
    await w.runAt(D0, 16, 35);
    w.deps.llm = { ...w.deps.llm!, yenPerUsd: 160 };
    await w.runAt(D0, 17, 0);
    expect(Object.values(w.llm.providers).map((f) => f.sent.length)).toEqual([0, 0, 0]);
    for (const [h, m] of [[6, 50], [9, 35], [16, 35]] as const) await w.runAt(D1, h, m);
    expect((await w.of("llm.batch.submitted")).map((e) => p(e).tradingDate)).toEqual(LLM_IDS.map(() => D2));
    expect((await budgetRuns(w)).length).toBe(3);
  });
});
