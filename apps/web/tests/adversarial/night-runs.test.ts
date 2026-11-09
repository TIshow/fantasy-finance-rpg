// 検証役（#228、platform の PR #231）：夜の実行（17:50・23:50・04:50）と、GitHub の定時の実行の遅れ・抜けを壊しにいく。
// 成り立つはずのこと（#228 の lead の決定）：
// (1) 実行が何時間遅れても、抜けても、同じ取引日の注文票・LLM の依頼・引け後の処理は1回だけ。あとの実行は、済んだ段を書き直さない
// (2) 締めのあとに初めて動いた実行は、その日の判断を飛ばし（締めに間に合わなかった印）、注文票を書かない
// (3) 引けのあとの最初の実行が 23:50 や 04:50 でも、引け後の処理 → LLM の依頼 → 判断の順に、1回ずつ進む
// (4) LLM の答えが夜に返れば、夜のうちに注文票を確定する（試運転の日は確定しない）
// 実行の日付は、毎日の実行のコマンドと同じく「日本時間の今日」（04:50 の実行は D の日付、23:50 の実行は D-1 の日付）。
// 偽の提供元と架空の市場の世界（tests/runner/llm-world.ts）を使う。本物の API は呼ばない。欠陥の再現は it.fails。
import { describe, expect, it } from "vitest";
import { jstDate, missedCutoff } from "../../scripts/daily-lib";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { cutoffOf, decisionOpensAt, marketClosedDays } from "../../src/ledger/ledger";
import type { LlmPolicy } from "../../src/contracts";
import type { StageResult } from "../../src/runner/day";
import { jst } from "../contracts/fakes";
import { answer } from "../runner/llm-fakes";
import { DAYS, LLM_IDS, llmWorld, p } from "../runner/llm-world";

const [D0, D1, D2] = [DAYS[0]!, DAYS[1]!, DAYS[2]!];
const good = JSON.stringify({ post: null, orders: [{ symbol: "VRN1", side: "buy", qty: 100 }], note: "買う" });
const CLOSED = marketClosedDays(new Set());

async function nightWorld(policy: LlmPolicy = { dailyCostLimit: 1000, dryRun: false }) {
  const w = await llmWorld(policy, { manualClock: true });
  // 毎日の実行（runDaily）と同じ
  w.deps.decideNext = true;
  /** 毎日の実行のコマンドと同じく、時刻の日本時間の日付で回す */
  const at = (t: number) => (w.clock.set(t), w.run(jstDate(t)));
  return { ...w, at };
}
type World = Awaited<ReturnType<typeof nightWorld>>;
const answerAll = (w: World) => {
  for (const f of Object.values(w.llm.providers)) f.outcome = () => answer(good);
};
const sheetsOf = async (w: World, date: string) => (await w.of("order_sheet.committed")).filter((e) => p(e).tradingDate === date);
const written = (r: readonly StageResult[]) => r.filter((x) => x.status === "written");
/** 同じ記録が2回書かれていない（一意の中身ごとに1件） */
const dupes = (events: readonly LogEvent[]) => {
  const key = (e: LogEvent) => {
    const x = p(e);
    if (e.type === "order_sheet.committed" || e.type === "order_sheet.rejected") return `sheet:${String(x.agentId)}:${String(x.tradingDate)}`;
    if (e.type === "llm.batch.submitted") return `llm:${String(x.agentId)}:${String(x.tradingDate)}`;
    if (e.type === "valuation.recorded") return `val:${String(x.agentId)}:${String(x.date)}`;
    if (e.type === "corporate_actions.applied") return `ca:${String(x.agentId)}:${String(x.asOf)}:${String(x.closedSeq ?? "")}`;
    if (e.type === "auction.cleared") return `auction:${String(x.symbol)}:${String(x.date)}`;
    if (e.type === "fills.executed") return `fills:${String(x.agentId)}:${String(x.tradingDate)}`;
    return null;
  };
  const seen = new Map<string, number>();
  for (const e of events) {
    const k = key(e);
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
};

describe("遅れた実行と抜けた実行で、二重に書かない", () => {
  it("16:35 が 20:10 に、17:50 が 21:40 に、23:50 が翌 02:10（D の日付）に、04:50 が 07:55 に動いても、注文票・依頼・引け後の処理は1回ずつ", async () => {
    const w = await nightWorld();
    await w.at(jst(D0, 6, 50));
    await w.at(jst(D0, 11, 5)); // 09:35 の実行が1時間半遅れた
    answerAll(w);
    const times = [jst(D0, 20, 10), jst(D0, 21, 40), jst(D1, 2, 10), jst(D1, 7, 55), jst(D1, 8, 20)];
    const counts: number[] = [];
    for (const t of times) {
      const r = await w.at(t);
      expect(missedCutoff(r), new Date(t).toISOString()).toBe(false);
      counts.push((await w.all()).length);
    }
    // 最初の 20:10 の実行が、引け後の処理・依頼・判断・（答えが返っていれば）LLM の確定まで済ませ、あとの実行は何も書かない
    expect(new Set(counts.slice(0, -1)).size, JSON.stringify(counts)).toBe(1);
    expect(counts.at(-1)).toBe(counts[0]);
    const sheets = await sheetsOf(w, D1);
    expect(sheets).toHaveLength(13);
    for (const s of sheets) {
      expect(s.recordedAt).toBeGreaterThanOrEqual(decisionOpensAt(D1, CLOSED));
      expect(s.recordedAt).toBeLessThan(cutoffOf(D1));
    }
    await w.at(jst(D1, 12, 0)); // 09:35 の実行が遅れて昼に動く
    await w.at(jst(D1, 16, 35));
    const events = await w.all();
    expect(dupes(events)).toEqual([]);
    expect(events.filter((e) => e.type === "order_sheet.rejected")).toEqual([]);
    await replay(events, w.values, { holidayTables: w.holidayTables });
  });

  it("同じ時刻の実行が2つ続けて動いても（GitHub が同じ回を2回動かした）、2つ目は何も書かない", async () => {
    const w = await nightWorld();
    for (const t of [jst(D0, 6, 50), jst(D0, 9, 35)]) await w.at(t);
    answerAll(w);
    for (const t of [jst(D0, 16, 35), jst(D0, 23, 50), jst(D1, 4, 50), jst(D1, 6, 50)]) {
      await w.at(t);
      const n = (await w.all()).length;
      const again = await w.at(t);
      expect(written(again), new Date(t).toISOString()).toEqual([]);
      expect((await w.all()).length).toBe(n);
    }
    expect(dupes(await w.all())).toEqual([]);
  });
});

describe("締めのあとの実行", () => {
  it("夜の実行がすべて抜け、最初の実行が 08:45 なら、判断を飛ばし（締めに間に合わなかった印）、LLM の答えがあっても注文票を書かない", async () => {
    const w = await nightWorld();
    for (const t of [jst(D0, 6, 50), jst(D0, 9, 35), jst(D0, 16, 35)]) await w.at(t);
    // 16:35 の実行は判断も済ませるので、その判断を「なかったこと」にはできない。ここでは D1 の次の日（D2）で、16:35 から先がすべて抜けた日を作る
    w.deps.decideNext = false;
    for (const t of [jst(D1, 9, 35), jst(D1, 16, 35)]) await w.at(t);
    w.deps.decideNext = true;
    answerAll(w);
    const before = (await w.all()).length;
    const r = await w.at(jst(D2, 8, 45));
    expect(r.find((x) => x.stage === "decide")).toMatchObject({ status: "skipped", detail: expect.stringMatching(/^after the cutoff/) });
    expect(missedCutoff(r)).toBe(true);
    const after = (await w.all()).slice(before);
    expect(after.filter((e) => e.type === "order_sheet.committed" || e.type === "agent.run" && p(e).ok === true && p(e).purpose === "order")).toEqual([]);
    // 次の取引日（D3）の判断もしない（D2 の引けの前）
    expect(r.some((x) => x.date !== undefined)).toBe(false);
  });
});

describe("夜の判断を一度したあと", () => {
  it("09:35・16:35・17:50 が抜け、23:50 に初めて判断したあと、04:50・06:50・07:20 の実行は何も書かない", async () => {
    const w = await nightWorld();
    await w.at(jst(D0, 6, 50));
    answerAll(w);
    const night = await w.at(jst(D0, 23, 50));
    // 23:50（D0 の日付）の実行が、D0 の板寄せと引け後の処理・D1 の依頼・D1 の判断と受け取りをする（架空の6社だけなので、引け後の処理は板寄せの段で書く）
    expect(written(night).map((x) => [x.stage, x.date ?? D0])).toEqual(expect.arrayContaining([["open", D0], ["llm.submit", D0], ["decide", D1], ["llm.collect", D1]]));
    const n = (await w.all()).length;
    for (const t of [jst(D1, 4, 50), jst(D1, 6, 50), jst(D1, 7, 20)]) {
      const r = await w.at(t);
      // 答えが 23:50 に返っていれば受け取りも済んでいる。返っていなかった LLM の受け取りだけが、あとの実行に残る
      expect(written(r), new Date(t).toISOString()).toEqual([]);
    }
    expect((await w.all()).length).toBe(n);
  });

  it("LLM の答えが 04:50 に返れば、04:50（D の日付）の実行で注文票を確定する。試運転の日は確定しない", async () => {
    for (const dryRun of [false, true]) {
      const w = await nightWorld({ dailyCostLimit: 1000, dryRun });
      for (const t of [jst(D0, 6, 50), jst(D0, 9, 35), jst(D0, 16, 35), jst(D0, 17, 50), jst(D0, 23, 50)]) await w.at(t);
      expect((await sheetsOf(w, D1)).filter((s) => LLM_IDS.includes(p(s).agentId as string)), String(dryRun)).toEqual([]);
      answerAll(w);
      await w.at(jst(D1, 4, 50));
      const llmSheets = (await sheetsOf(w, D1)).filter((s) => LLM_IDS.includes(p(s).agentId as string));
      if (dryRun) expect(llmSheets).toEqual([]);
      else expect(llmSheets.map((s) => s.recordedAt)).toEqual(LLM_IDS.map(() => jst(D1, 4, 50)));
      expect((await w.of("order_sheet.rejected")).filter((e) => LLM_IDS.includes(p(e).agentId as string)), String(dryRun)).toEqual([]);
    }
  });
});

describe("16:35 が抜け、引けのあとの最初の実行が 23:50 か 04:50 のとき", () => {
  for (const [label, first] of [["23:50（D0 の日付）", jst(D0, 23, 50)], ["04:50（D1 の日付）", jst(D1, 4, 50)]] as const) {
    it(`${label}：D0 の板寄せと引け後の処理 → D1 の LLM の依頼 → D1 の判断の順に、1回ずつ進み、LLM の答えは朝に受け取れる`, async () => {
      const w = await nightWorld();
      // 09:35 と 16:35・17:50 が抜けた日（架空の6社だけなので、引け後の処理は板寄せのあとに書く）
      await w.at(jst(D0, 6, 50));
      const before = (await w.all()).length;
      const r = await w.at(first);
      expect(missedCutoff(r)).toBe(false);
      const wrote = (await w.all()).slice(before);
      const firstSeq = (pred: (e: LogEvent) => boolean) => wrote.find(pred)?.seq ?? Number.POSITIVE_INFINITY;
      const lastSeq = (pred: (e: LogEvent) => boolean) => wrote.filter(pred).at(-1)?.seq ?? Number.NEGATIVE_INFINITY;
      const postClose = (e: LogEvent) => e.type === "corporate_actions.applied" && p(e).asOf === D0;
      const submitted = (e: LogEvent) => e.type === "llm.batch.submitted" && p(e).tradingDate === D1;
      const sheet = (e: LogEvent) => e.type === "order_sheet.committed" && p(e).tradingDate === D1;
      // D0 の引け後の処理が全員分あり、そのあとに D1 の依頼（3社）、そのあとに D1 の規則の AI の注文票
      expect(wrote.filter(postClose).length).toBeGreaterThan(0);
      expect(wrote.filter(submitted).map((e) => p(e).agentId).sort()).toEqual([...LLM_IDS].sort());
      expect(lastSeq(postClose)).toBeLessThan(firstSeq(submitted));
      expect(lastSeq(submitted)).toBeLessThan(firstSeq(sheet));
      expect(wrote.filter(sheet)).toHaveLength(10);
      // 依頼の取引日と時刻は、D1 の受け付けの中
      for (const e of wrote.filter(submitted)) expect(p(e).submittedAt as number).toBeGreaterThanOrEqual(decisionOpensAt(D1, CLOSED));
      // あとの実行は二重に書かず、答えが返れば朝に LLM の注文票を確定する
      answerAll(w);
      for (const t of [jst(D1, 4, 50), jst(D1, 6, 50), jst(D1, 7, 20)].filter((t) => t > first)) await w.at(t);
      const all = await w.all();
      expect(dupes(all)).toEqual([]);
      expect((await sheetsOf(w, D1)).filter((s) => LLM_IDS.includes(p(s).agentId as string))).toHaveLength(LLM_IDS.length);
      await replay(all, w.values, { holidayTables: w.holidayTables });
    });
  }
});
