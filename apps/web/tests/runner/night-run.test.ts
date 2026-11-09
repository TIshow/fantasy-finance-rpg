// 夜の実行（#228）：判断の受け付けは前の取引日の引け（16:30）のあとから。引けのあとに始めた実行（16:35・17:50・23:50）は、
// 次の取引日の判断と LLM の受け取りも進める。毎日の実行と同じく decideNext を付け、決まった時刻まで待たずに時計を合わせて回す。
// 本物の API は呼ばない（偽の提供元）。
import { describe, expect, it } from "vitest";
import { missedCutoff } from "../../scripts/daily-lib";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { cutoffOf, decisionOpensAt, marketClosedDays } from "../../src/ledger/ledger";
import type { StageResult } from "../../src/runner/day";
import { jst } from "../contracts/fakes";
import { answer } from "./llm-fakes";
import { DAYS, LLM_IDS, llmWorld, p } from "./llm-world";

const D0 = DAYS[0]!;
const D1 = DAYS[1]!;
const good = JSON.stringify({ post: null, orders: [{ symbol: "VRN1", side: "buy", qty: 100 }], note: "買う" });
const OPENS_D1 = decisionOpensAt(D1, marketClosedDays(new Set()));

async function nightWorld() {
  const w = await llmWorld({ dailyCostLimit: 1000, dryRun: false }, { manualClock: true });
  w.deps.decideNext = true;
  return w;
}
type World = Awaited<ReturnType<typeof nightWorld>>;
const sheetsOf = async (w: World, date: string) => (await w.of("order_sheet.committed")).filter((e) => p(e).tradingDate === date);
const nextOf = (r: readonly StageResult[], stage: string) => r.find((x) => x.stage === stage && x.date !== undefined);
const answerAll = (w: World) => {
  for (const f of Object.values(w.llm.providers)) f.outcome = () => answer(good);
};

describe("16:35 の実行", () => {
  it("09:35 の実行が抜けても、前の日の板寄せと引け後の処理、次の取引日の LLM の依頼をし、続けて次の取引日の判断をする", async () => {
    const w = await nightWorld();
    await w.runAt(D0, 6, 50);
    const r = await w.runAt(D0, 16, 35);
    expect(r.filter((x) => x.date === undefined && x.status === "written" && ["open", "after_close", "llm.submit"].includes(x.stage)).map((x) => [x.stage, x.status])).toEqual([
      ["open", "written"],
      ["after_close", "written"],
      ["llm.submit", "written"],
    ]);
    expect(nextOf(r, "decide")).toEqual({ stage: "decide", status: "written", date: D1 });
    // 答えはまだない（依頼の直後）
    expect(nextOf(r, "llm.collect")).toMatchObject({ status: "waiting", date: D1 });
    const sheets = await sheetsOf(w, D1);
    // 規則のAI 3体・マーケットメイカー6・ばらばらの参加者1
    expect(sheets).toHaveLength(10);
    for (const s of sheets) expect(s.recordedAt).toBeGreaterThanOrEqual(OPENS_D1);
    expect((await w.of("order_sheet.rejected"))).toEqual([]);
  });
});

describe("17:50 の実行（16:35 の実行が抜けた夜）", async () => {
  const w = await nightWorld();
  await w.runAt(D0, 6, 50);
  await w.runAt(D0, 9, 35);
  answerAll(w);
  const evening = await w.runAt(D0, 17, 50);
  const afterEvening = (await w.all()).length;

  it("LLM の依頼をし、次の取引日の判断をし、答えが返っていれば、その夜のうちに LLM の注文票も確定する", async () => {
    expect(evening.find((x) => x.stage === "llm.submit")).toMatchObject({ status: "written" });
    expect(nextOf(evening, "decide")).toMatchObject({ status: "written", date: D1 });
    expect(nextOf(evening, "llm.collect")).toMatchObject({ status: "written", date: D1 });
    const sheets = await sheetsOf(w, D1);
    expect(sheets).toHaveLength(13);
    for (const id of LLM_IDS) expect(sheets.find((s) => p(s).agentId === id)!.recordedAt).toBe(jst(D0, 17, 50));
    expect(missedCutoff(evening)).toBe(false);
  });

  it("23:50 と翌日の 04:50・06:50 の実行は、何も書かない", async () => {
    for (const [d, h, m] of [[D0, 23, 50], [D1, 4, 50], [D1, 6, 50]] as const) {
      const r = await w.runAt(d, h, m);
      expect(r.filter((x) => x.status === "written"), `${d} ${h}:${m}`).toEqual([]);
      expect(missedCutoff(r)).toBe(false);
    }
    expect(await w.all()).toHaveLength(afterEvening);
  });

  it("夜に確定した注文票は、翌朝の板寄せに入り、記録だけから作り直した台帳と一致する", async () => {
    await w.runAt(D1, 9, 35);
    const sheets = await sheetsOf(w, D1);
    const auctions = (await w.of("auction.cleared")).filter((e) => p(e).date === D1);
    expect(auctions).toHaveLength(6);
    for (const a of auctions) expect(p(a).sheetSeqs).toEqual(sheets.map((s) => s.seq));
    expect((await w.of("fills.executed")).filter((e) => p(e).tradingDate === D1)).toHaveLength(13);
    await replay(await w.all(), w.values, { holidayTables: w.holidayTables });
  });
});

describe("LLM の答えが夜のうちに返らないとき", () => {
  it("17:50 は待ち、23:50 に返れば、その夜に確定する", async () => {
    const w = await nightWorld();
    for (const [h, m] of [[6, 50], [9, 35], [16, 35]] as const) await w.runAt(D0, h, m);
    expect(nextOf(await w.runAt(D0, 17, 50), "llm.collect")).toMatchObject({ status: "waiting", date: D1 });
    answerAll(w);
    expect(nextOf(await w.runAt(D0, 23, 50), "llm.collect")).toMatchObject({ status: "written", date: D1 });
    const llmSheets = (await sheetsOf(w, D1)).filter((s) => LLM_IDS.includes(p(s).agentId as string));
    expect(llmSheets.map((s) => s.recordedAt)).toEqual(LLM_IDS.map(() => jst(D0, 23, 50)));
  });
});

describe("遅れた実行", () => {
  it("締めのあとに動いた実行は、これまでどおり判断を飛ばし（締めに間に合わなかった印）、次の取引日の判断もまだしない", async () => {
    const w = await nightWorld();
    w.deps.decideNext = false; // 前の日の夜の判断がなかった日を作る
    await w.runAt(D0, 6, 50);
    await w.runAt(D0, 9, 35);
    w.deps.decideNext = true;
    const r = await w.runAt(D1, 10, 15);
    expect(r.find((x) => x.stage === "decide")).toMatchObject({ status: "skipped", detail: expect.stringMatching(/^after the cutoff: /) });
    expect(missedCutoff(r)).toBe(true);
    expect(r.some((x) => x.date !== undefined)).toBe(false);
    expect(await sheetsOf(w, D1)).toEqual([]);
  });
});

describe("土日をまたぐ1週間（毎日の実行の時刻どおり）", async () => {
  const w = await nightWorld();
  answerAll(w);
  const week = ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"];
  const days = [...DAYS.slice(0, 3), ...week];
  const results: StageResult[][] = [];
  for (const d of days) for (const [h, m] of [[4, 50], [6, 50], [7, 20], [9, 35], [16, 35], [17, 50], [23, 50]] as const) results.push(await w.runAt(d, h, m));
  const events = await w.all();
  const of = (type: LogEvent["type"]) => events.filter((e) => e.type === type);

  it("土日も止まらずに、毎日、全員が受け付けの時間の中で注文票を確定し、板寄せ・評価が進む", () => {
    expect(results.some((r) => missedCutoff(r))).toBe(false);
    expect(results.flat().filter((x) => x.stage === "day")).toEqual([]);
    expect(of("order_sheet.rejected")).toEqual([]);
    for (const d of days) {
      const sheets = of("order_sheet.committed").filter((e) => p(e).tradingDate === d);
      // 11/9 の LLM の AI は、依頼（前の取引日の 16:35）がないので注文しない
      expect(sheets, d).toHaveLength(d === D0 ? 10 : 13);
      for (const s of sheets) expect(s.recordedAt).toBeLessThan(cutoffOf(d));
      if (d !== D0) for (const s of sheets) expect(s.recordedAt).toBeGreaterThanOrEqual(decisionOpensAt(d, marketClosedDays(new Set())));
      expect(of("auction.cleared").filter((e) => p(e).date === d), d).toHaveLength(6);
      expect(of("valuation.recorded").filter((e) => p(e).date === d && String(p(e).agentId).startsWith("ai-")), d).toHaveLength(6);
    }
  });

  it("LLM の依頼は、毎日の 16:35 に、次の暦日の取引日の分（金曜の夜は土曜の分）", () => {
    const subs = of("llm.batch.submitted");
    for (const [i, d] of days.slice(0, -1).entries()) {
      const mine = subs.filter((e) => p(e).tradingDate === days[i + 1]);
      expect(mine.map((e) => p(e).agentId).sort(), d).toEqual([...LLM_IDS].sort());
      for (const e of mine) expect(e.recordedAt).toBe(jst(d, 16, 35));
    }
  });

  it("記録だけから作り直した台帳と一致する", async () => {
    const ledger = await replay(events, w.values, { holidayTables: w.holidayTables });
    for (const id of LLM_IDS) expect(ledger.account(id)).toEqual(w.store.account(id));
  });
});
