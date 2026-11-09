// 夜の実行（#228）：判断の受け付けは前の取引日の引け（16:30）のあとから。引けのあとに始めた実行（16:35・17:50・23:50）は、
// 次の取引日の判断と LLM の受け取りも進める。毎日の実行と同じく decideNext を付け、決まった時刻まで待たずに時計を合わせて回す。
// 本物の API は呼ばない（偽の提供元）。
import { describe, expect, it } from "vitest";
import { missedCutoff } from "../../scripts/daily-lib";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { cutoffOf, decisionOpensAt, marketClosedDays } from "../../src/ledger/ledger";
import { INVESTOR_PROMPT_VERSION, PAST_INVESTOR_PROMPTS } from "../../src/llm/investor-prompt";
import { type StageResult, runDay } from "../../src/runner/day";
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
      // 11/9 の LLM の依頼は、前の取引日（11/6）の夜の実行がないので、11/9 の 04:50 の実行が出す
      expect(sheets, d).toHaveLength(13);
      for (const s of sheets) expect(s.recordedAt).toBeLessThan(cutoffOf(d));
      if (d !== D0) for (const s of sheets) expect(s.recordedAt).toBeGreaterThanOrEqual(decisionOpensAt(d, marketClosedDays(new Set())));
      expect(of("auction.cleared").filter((e) => p(e).date === d), d).toHaveLength(6);
      expect(of("valuation.recorded").filter((e) => p(e).date === d && String(p(e).agentId).startsWith("ai-")), d).toHaveLength(6);
    }
  });

  it("LLM の依頼は、毎日の 16:35 に、次の暦日の取引日の分（金曜の夜は土曜の分）", () => {
    const subs = of("llm.batch.submitted");
    expect(subs.filter((e) => p(e).tradingDate === D0).map((e) => e.recordedAt)).toEqual(LLM_IDS.map(() => jst(D0, 4, 50)));
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

describe("前の日の夜の実行がすべて抜けたとき（日付が変わってから最初の実行）", () => {
  for (const [label, h, m] of [["04:50 の実行", 4, 50], ["00:10 まで遅れた 23:50 の実行", 0, 10]] as const) {
    it(`${label}が、その日の分の LLM の依頼を出し、規則の AI の判断と LLM の受け取りまで進める。あとの実行は何も書かない`, async () => {
      const w = await nightWorld();
      await w.runAt(D0, 6, 50);
      await w.runAt(D0, 9, 35);
      answerAll(w);
      const r = await w.runAt(D1, h, m);
      const stages = r.map((x) => `${x.stage}:${x.status}`);
      // 引け後の処理（9:35 に済み）→ 依頼 → 規則の AI の判断 → 受け取り の順
      expect(stages.indexOf("llm.submit:written")).toBeGreaterThan(-1);
      expect(stages.indexOf("llm.submit:written")).toBeLessThan(stages.indexOf("decide:written"));
      expect(stages.indexOf("decide:written")).toBeLessThan(stages.indexOf("llm.collect:written"));
      const subs = (await w.of("llm.batch.submitted")).filter((e) => p(e).tradingDate === D1);
      expect(subs.map((e) => p(e).agentId).sort()).toEqual([...LLM_IDS].sort());
      for (const e of subs) expect(e.recordedAt).toBe(jst(D1, h, m));
      expect(await sheetsOf(w, D1)).toHaveLength(13);
      const before = (await w.all()).length;
      for (const [hh, mm] of [[6, 50], [7, 20]] as const) expect((await w.runAt(D1, hh, mm)).filter((x) => x.status === "written")).toEqual([]);
      expect(await w.all()).toHaveLength(before);
      await replay(await w.all(), w.values, { holidayTables: w.holidayTables });
    });
  }
});

describe("臨時休場の日（market.closed）をはさむ夜の実行", () => {
  it("休場の日の実行は「取引日でない」を返し、続けて次の取引日の判断と LLM の依頼をする", async () => {
    const w = await nightWorld();
    const D2 = DAYS[2]!;
    const D3 = DAYS[3]!;
    for (const [h, m] of [[6, 50], [9, 35]] as const) await w.runAt(D0, h, m);
    // D0 の夜の実行が抜け、D1 の朝に D1 の判断をして、板寄せと引け後の処理を済ませる
    for (const [h, m] of [[6, 50], [9, 35]] as const) await w.runAt(D1, h, m);
    // D1 の日中に、D2 を臨時休場にする。D1 の夜の実行も抜ける
    expect(await w.store.append({ type: "market.closed", actor: "operator:owner", refs: [], payload: { date: D2, reason: "試験" } })).toMatchObject({ ok: true });
    answerAll(w);
    const r = await w.runAt(D2, 7, 0);
    expect(r[0]).toEqual({ stage: "day", status: "skipped", detail: "not a trading day" });
    expect(r.find((x) => x.stage === "llm.submit")).toMatchObject({ status: "written" });
    expect(nextOf(r, "decide")).toMatchObject({ status: "written", date: D3 });
    const sheets = await sheetsOf(w, D3);
    expect(sheets).toHaveLength(13);
    for (const s of sheets) expect(s.recordedAt).toBe(jst(D2, 7));
    expect((await w.of("llm.batch.submitted")).filter((e) => p(e).tradingDate === D2)).toEqual([]);
    expect(await sheetsOf(w, D2)).toEqual([]);
    await replay(await w.all(), w.values, { holidayTables: w.holidayTables });
  });
});

describe("夜の判断と朝の判断の入力", () => {
  it("同じ取引日を、前の日の夜に判断しても、朝に判断しても、記録の入力（inputSeqs）は同じ", async () => {
    const inputsOf = async (night: boolean) => {
      const w = await nightWorld();
      for (const [h, m] of [[6, 50], [9, 35]] as const) await w.runAt(D0, h, m);
      // 朝に判断する側は、16:35 の実行で次の取引日の判断をしない（その日の依頼までは同じ）
      w.deps.decideNext = night;
      await w.runAt(D0, 16, 35);
      w.deps.decideNext = true;
      if (!night) await w.runAt(D1, 6, 50);
      const events = await w.all();
      const sheets = events.filter((e) => e.type === "order_sheet.committed" && p(e).tradingDate === D1);
      expect(sheets).toHaveLength(10);
      return Object.fromEntries(sheets.map((s) => [p(s).agentId as string, { sheet: p(s).inputSeqs, run: p(events[(p(s).runSeq as number) - 1]!).inputSeqs }]));
    };
    const night = await inputsOf(true);
    const morning = await inputsOf(false);
    expect(Object.keys(night).sort()).toEqual(Object.keys(morning).sort());
    expect(night).toEqual(morning);
  });
});

describe("判断の受け付けの始まりより前", () => {
  it("前の取引日の引けより前に判断の段を動かしても、書かずに待つ（保管に拒否を残さない）", async () => {
    const w = await nightWorld();
    const D2 = DAYS[2]!;
    for (const [h, m] of [[6, 50], [9, 35], [16, 35]] as const) await w.runAt(D0, h, m);
    // D2 の受け付けは D1 の 16:30 から。D1 の 8:00（D1 の締めの前で、D1 の板寄せはまだ）に D2 の日付で回す
    w.clock.set(jst(D1, 8));
    const before = (await w.all()).length;
    const r = await runDay(D2, w.deps);
    expect(r.find((x) => x.stage === "decide")).toEqual({ stage: "decide", status: "waiting", detail: `before the decision window of ${D2}` });
    expect(await w.all()).toHaveLength(before);
    expect(await w.of("order_sheet.rejected")).toEqual([]);
  });
});

describe("前の版のプロンプトで出した依頼を、今の版で受け取る", () => {
  it("判断なしの失敗を残し、記録のプロンプトは依頼の版（2）のもの。段の詳細に版の違いが出る", async () => {
    const w = await nightWorld();
    for (const [h, m] of [[6, 50], [9, 35]] as const) await w.runAt(D0, h, m);
    // 依頼だけを版 2 で作る（作り直しには clock つきの口を使うので、そちらは今の版のまま）
    const llm = w.deps.llm!;
    const portOf = llm.portOf;
    llm.portOf = (provider, c) => {
      const port = portOf(provider, c);
      if (c) return port;
      const prepare: typeof port.prepare = (r) => port.prepare({ ...r, prompt: PAST_INVESTOR_PROMPTS["2"]! });
      return new Proxy(port, { get: (t, k) => (k === "prepare" ? prepare : typeof Reflect.get(t, k) === "function" ? Reflect.get(t, k).bind(t) : Reflect.get(t, k)) });
    };
    await w.runAt(D0, 16, 35);
    llm.portOf = portOf;
    expect((await w.of("llm.batch.submitted")).filter((e) => p(e).tradingDate === D1).map((e) => p(e).promptVersion)).toEqual(LLM_IDS.map(() => "2"));
    answerAll(w);
    const r = await w.runAt(D0, 17, 50);
    expect(nextOf(r, "llm.collect")!.detail).toContain(`prompt version 2 was replaced by ${INVESTOR_PROMPT_VERSION}`);
    const runs = (await w.of("agent.run")).filter((e) => LLM_IDS.includes(p(e).agentId as string) && e.recordedAt === jst(D0, 17, 50));
    expect(runs.map((e) => [p(e).ok, p(e).errorCode, p(e).prompt])).toEqual(LLM_IDS.map(() => [false, "provider_error", PAST_INVESTOR_PROMPTS["2"]]));
    expect((await sheetsOf(w, D1)).filter((s) => LLM_IDS.includes(p(s).agentId as string))).toEqual([]);
    const before = (await w.all()).length;
    await w.runAt(D0, 23, 50);
    expect(await w.all()).toHaveLength(before);
  });
});
