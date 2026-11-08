// 試運転の印（dryRun）の試験（#179）。印は、依頼（①）を記録したとき（16:35）の設定で決まり、その依頼の agent.run にそのまま写す。
// 印のある依頼からは、あとで試運転を切っても注文票を作らない（commitSheet を呼ばないので、拒否の記録も残らない）。本物の API は呼ばない。
import { describe, expect, it } from "vitest";
import { answer } from "./llm-fakes";
import { DAYS, LLM_IDS, llmWorld, p } from "./llm-world";

const D0 = DAYS[0]!;
const D1 = DAYS[1]!;
const good = JSON.stringify({ post: { board: "VRN1", text: "決算を見て少し買う" }, orders: [{ symbol: "VRN1", side: "buy", qty: 100 }], note: "決算" });

type World = Awaited<ReturnType<typeof llmWorld>>;

/** D0 を回し（判断・板寄せ・引け後・D1 の分の依頼）、3体とも答えを返すようにする */
async function evening(dryRun: boolean): Promise<World> {
  const w = await llmWorld({ dailyCostLimit: 1000, dryRun }, { manualClock: true });
  for (const [h, m] of [[6, 50], [9, 35], [16, 35]] as const) await w.runAt(D0, h, m);
  for (const f of Object.values(w.llm.providers)) f.outcome = () => answer(good);
  return w;
}
const setDry = (w: World, dryRun: boolean) => {
  w.deps.llm = { ...w.deps.llm!, policy: { dailyCostLimit: 1000, dryRun } };
};
const isLlm = (agentId: unknown) => LLM_IDS.includes(agentId as string);
/** D1 の LLM の AI の注文票（確定と拒否の両方） */
const sheets = async (w: World) => (await w.all()).filter((e) => (e.type === "order_sheet.committed" || e.type === "order_sheet.rejected") && isLlm(p(e).agentId) && p(e).tradingDate === D1);
const runsOf = async (w: World, id: string) => (await w.of("agent.run")).filter((e) => p(e).agentId === id);
const collectOf = (r: { stage: string; status?: string }[]) => r.find((x) => x.stage === "llm.collect");

describe("試運転の印は、依頼を記録したときに決まる", () => {
  it("試運転で依頼した①と、翌朝に書く判断の記録のすべてに dryRun: true が付き、注文票はない", async () => {
    const w = await evening(true);
    await w.runAt(D1, 6, 50);
    const subs = (await w.of("llm.batch.submitted")).filter((e) => p(e).tradingDate === D1);
    expect(subs.map((e) => p(e).dryRun)).toEqual([true, true, true]);
    for (const id of LLM_IDS) expect((await runsOf(w, id)).map((e) => [p(e).purpose, p(e).ok, p(e).dryRun]), id).toEqual([["post", true, true], ["order", true, true]]);
    expect(await sheets(w)).toEqual([]);
  });

  it("試運転で依頼したあと、06:50 の前に試運転を切っても、06:50・07:20 の判断は印つきで、注文票（確定も拒否も）を書かない", async () => {
    const w = await evening(true);
    setDry(w, false);
    await w.runAt(D1, 6, 50);
    const count = (await w.all()).length;
    // 07:20：印のある依頼は片づいた扱いで、何も書かない
    expect(collectOf(await w.runAt(D1, 7, 20))).toMatchObject({ status: "done" });
    expect((await w.all()).length).toBe(count);
    for (const id of LLM_IDS) expect((await runsOf(w, id)).map((e) => [p(e).purpose, p(e).ok, p(e).dryRun]), id).toEqual([["post", true, true], ["order", true, true]]);
    expect(await sheets(w)).toEqual([]);
  });

  it("06:50 の結果を見てから試運転を切っても、07:20 に注文票を書かない", async () => {
    const w = await evening(true);
    await w.runAt(D1, 6, 50);
    setDry(w, false);
    await w.runAt(D1, 7, 20);
    expect(await sheets(w)).toEqual([]);
  });

  it("試運転で依頼し、締めで打ち切った日の失敗の記録（timeout）にも、①の印が付く", async () => {
    const w = await evening(true);
    for (const f of Object.values(w.llm.providers)) f.outcome = () => "pending";
    setDry(w, false);
    await w.runAt(D1, 9, 35);
    const fails = (await w.of("agent.run")).filter((e) => isLlm(p(e).agentId) && p(e).ok === false);
    expect(fails.map((e) => [p(e).agentId, p(e).errorCode, p(e).dryRun])).toEqual(LLM_IDS.map((id) => [id, "timeout", true]));
    expect(await sheets(w)).toEqual([]);
  });

  it("逆：本物として依頼したあと試運転に入れたら、判断は印なしで書き、試運転の間は注文票を書かない。締めの前に切れば書く", async () => {
    const w = await evening(false);
    expect((await w.of("llm.batch.submitted")).map((e) => p(e).dryRun)).toEqual([undefined, undefined, undefined]);
    setDry(w, true);
    await w.runAt(D1, 6, 50);
    for (const id of LLM_IDS) expect((await runsOf(w, id)).map((e) => [p(e).purpose, p(e).ok, p(e).dryRun]), id).toEqual([["post", true, undefined], ["order", true, undefined]]);
    expect(await sheets(w)).toEqual([]);
    // 試運転のままなら、07:20 も何も書かない
    const count = (await w.all()).length;
    await w.runAt(D1, 7, 20);
    expect((await w.all()).length).toBe(count);
    // 締めの前に試運転を切れば、本物の依頼なので注文票を確定する
    setDry(w, false);
    await w.runAt(D1, 8, 0);
    expect((await sheets(w)).map((e) => [e.type, p(e).agentId]).sort()).toEqual(LLM_IDS.map((id) => ["order_sheet.committed", id]).sort());
  });
});
