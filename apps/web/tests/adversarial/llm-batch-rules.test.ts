// 検証役（#179、PR #193 のコミット 47e2e46）：レビューのあとに足された決まりを壊しにいく。
// - llm.batch.submitted の submittedAt（依頼を決めた時刻。取引日と費用の暦日をこれで決める）
// - EventLog.canAppend（書かずに追記と同じ検査だけをする）
// - 実際の費用＝トークン数と料金から出した値ちょうど（料金は予約の料金以下）、キャッシュの欄、maxCost と上限のトークン数
// - agent.run の batchSeq（元になったバッチの閉じた記録）
// 欠陥の再現は it.fails。記録からは見分けられないことは、ふつうの試験で今の動きを書き留める（報告は #179）。
import { describe, expect, it } from "vitest";
import { EventLog, LLM_RECORD_WINDOW_MS, type Draft } from "../../src/events/append";
import { sealEvent } from "../../src/events/chain";
import { jstDayOf, llmCostProblems, llmCostUsed, llmTokenCost } from "../../src/events/llm-cost";
import type { LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/table";
import { newAccount } from "../../src/ledger/ledger";
import { tradingDateFor } from "../../src/ledger/calendar";
import { INITIAL_CASH } from "../../src/ledger/types";
import { batchCostDeciyen } from "../../src/llm/cost";
import { GEMINI_PRICE_SWITCH_AT, geminiBatchCostDeciyen, geminiBatchPrice } from "../../src/llm/gemini-pricing";

const jst = (date: string, hh: number, mm = 0, ss = 0, ms = 0) =>
  Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}+09:00`);
const H = "c".repeat(64);
const H2 = "d".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set(["2026-11-23"]) };
// 11-10（火）を休みにした一覧（送る前の確かめと記録のあいだに採用される場合）
const TABLE2: HolidayTable = { ...TABLE, contentSha256: H2, dates: new Set(["2026-11-10", "2026-11-23"]) };
const CTX = { holidayTables: new Map([[H, TABLE], [H2, TABLE2]]) };
const newLog = () => new EventLog({ ...CTX, accountOf: () => newAccount() });

async function ok(log: EventLog, d: Draft): Promise<LogEvent> {
  const r = await log.append(d);
  if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
  return r.event;
}
const reason = async (log: EventLog, d: Draft) => {
  const r = await log.append(d);
  return r.ok ? "ok" : r.reason;
};

async function setup(agents = ["alpha", "beta", "gamma"]) {
  const log = newLog();
  await ok(log, { type: "holidays.adopted", recordedAt: 0, actor: "operator:owner", refs: [], payload: { holidaysSha256: H } });
  for (const agentId of agents) {
    await ok(log, { type: "agent.registered", recordedAt: jst("2026-11-09", 8), actor: "operator:owner", refs: [], payload: { agentId, startDate: "2026-11-09", initialCash: INITIAL_CASH } });
  }
  return log;
}

/** 1トークン＝0.1円ちょうどになる料金（1ドル160円） */
const PRICE = { inputCentsPer10MTok: 625_000, outputCentsPer10MTok: 625_000 };
/** Anthropic の Sonnet 5.5 のバッチの料金（100万トークンあたり1ドル・5ドル）を1,000万トークンあたりのセントにしたもの */
const SONNET = { inputCentsPer10MTok: 1_000, outputCentsPer10MTok: 5_000 };
const BODY = "b".repeat(64);

const sub = (at: number, agentId: string, tradingDate: string, maxCost: number, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.submitted",
  recordedAt: at,
  actor: "system",
  refs: [],
  payload: {
    agentId, provider: "anthropic", modelId: "m", promptVersion: "v1", sentBodyHash: BODY, maxCost, tradingDate,
    submittedAt: at, yenPerUsd: 160, ...PRICE, maxInputTokens: 1, maxOutputTokens: 1, bodyMaxOutputTokens: 1, ...extra,
    // customId の末尾は「-」＋本文のハッシュの先頭16文字（PR #210 の 1ce37a0）。extra.customId は、その前の部分
    customId: `${String(extra.customId ?? `${agentId}-${tradingDate}`)}-${String(extra.sentBodyHash ?? "b".repeat(64)).slice(0, 16)}`,
  },
});
const close = (at: number, s: LogEvent, cost: number, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.closed",
  recordedAt: at,
  actor: "system",
  refs: [s.seq],
  payload: {
    batchSeq: s.seq, agentId: (s.payload as { agentId: string }).agentId, // 受け取り（collected）は入力・出力のトークン数がどちらも1以上（2962eda）。1トークン＝1なので、費用2以上なら入力1・出力（費用−1）にする
    result: "collected", cost, ...((extra.result ?? "collected") === "collected" && cost >= 2 ? { inputTokens: 1, outputTokens: cost - 1 } : { inputTokens: 0, outputTokens: cost }),
    ...(extra.costUnknown === true ? {} : PRICE), ...extra,
  },
});
/** ③ 送った記録（llm.batch.sent）。①（s）を指し、提供元のバッチのIDを足す */
const sent = (at: number, s: LogEvent, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.sent",
  recordedAt: at,
  actor: "system",
  refs: [s.seq],
  payload: { batchSeq: s.seq, agentId: (s.payload as { agentId: string }).agentId, provider: (s.payload as { provider: string }).provider, batchId: `batch_${s.seq}`, ...extra },
});
/** ① を書き、すぐに ③ も書く（送れた依頼）。① を返す */
async function okSent(log: EventLog, d: Draft): Promise<LogEvent> {
  const s = await ok(log, d);
  await ok(log, sent(d.recordedAt, s));
  return s;
}
const run = (at: number, agentId: string, batchSeq: number | undefined, extra: Record<string, unknown> = {}): Draft => ({
  type: "agent.run",
  recordedAt: at,
  actor: "system",
  refs: batchSeq === undefined ? [] : [batchSeq],
  payload: { agentId, purpose: "order", inputSeqs: [], ok: true, sentBodyHash: BODY, ...(batchSeq === undefined ? {} : { batchSeq }), ...extra },
});

const DAY = "2026-11-09";

describe("submittedAt（依頼を決めた時刻）で、費用の日と取引日を動かす", () => {
  it("submittedAt は recordedAt 以下で、差は1時間以内（ちょうど1時間は通り、1ミリ秒でも超えれば断る）", async () => {
    const log = await setup();
    const at = jst(DAY, 17);
    expect(LLM_RECORD_WINDOW_MS).toBe(3_600_000);
    expect(await reason(log, sub(at, "alpha", "2026-11-10", 100, { submittedAt: at + 1 }))).toBe("submittedAt must be within an hour before recordedAt");
    expect(await reason(log, sub(at, "alpha", "2026-11-10", 100, { submittedAt: at - 3_600_001 }))).toBe("submittedAt must be within an hour before recordedAt");
    await okSent(log, sub(at, "alpha", "2026-11-10", 100, { submittedAt: at - 3_600_000 }));
  });

  it("submittedAt に、文字列・小数・負・null・NaN・大きすぎる数は使えない", async () => {
    const log = await setup();
    const at = jst(DAY, 17);
    for (const v of [String(at), at - 0.5, -1, null, Number.NaN, 2 ** 53, true]) {
      expect(await reason(log, sub(at, "alpha", "2026-11-10", 100, { submittedAt: v })), String(v)).toBe("submittedAt must be within an hour before recordedAt");
    }
  });

  it("前回の低の指摘：0時をまたいで記録しても、費用は依頼を決めた日（submittedAt の日本時間）に付く（直った）", async () => {
    const log = await setup();
    await okSent(log, sub(jst("2026-11-10", 0, 0, 0, 500), "alpha", "2026-11-10", 600, { submittedAt: jst(DAY, 23, 59, 59, 999) }));
    expect(llmCostUsed(log.events, DAY)).toBe(600);
    expect(llmCostUsed(log.events, "2026-11-10")).toBe(0);
  });

  // 【低・記録からは見分けられない】submittedAt は runner が自分の時計から書く値で、記録の検査は「recordedAt の1時間前まで」しか縛らない。
  // 0:30 に送った依頼を 23:31 に決めたと書けば、前の日の枠の残りを使える。実際の暦日（記録した日）では1日に 1,400 を使っても、検査は何も挙げない
  it("submittedAt を最大1時間さかのぼると、前の日の枠の残りで払える（実際の暦日では100円を超えても挙がらない）", async () => {
    const log = await setup();
    await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 600));
    await okSent(log, sub(jst("2026-11-10", 0, 30), "beta", "2026-11-10", 400, { submittedAt: jst(DAY, 23, 31) }));
    await okSent(log, sub(jst("2026-11-10", 0, 31), "gamma", "2026-11-10", 1000));
    expect(llmCostProblems(log.events)).toEqual([]);
    const byRecordedDay = log.events.filter((e) => e.type === "llm.batch.submitted" && jstDayOf(e.recordedAt) === "2026-11-10").reduce((s, e) => s + (e.payload as { maxCost: number }).maxCost, 0);
    expect(byRecordedDay).toBe(1400);
  });

  it("8:30 の前に決めて 8:30 のあとに記録した依頼は当日の取引日になるが、その答えは当日の判断に使えない（記録の時刻は戻らない）", async () => {
    const log = await setup();
    const at = jst("2026-11-10", 8, 30, 1);
    expect(await reason(log, sub(at, "alpha", "2026-11-11", 100, { submittedAt: jst("2026-11-10", 8, 29, 59) }))).toBe("tradingDate must be the next trading date");
    const s = await okSent(log, sub(at, "alpha", "2026-11-10", 100, { submittedAt: jst("2026-11-10", 8, 29, 59) }));
    const c = await ok(log, close(jst("2026-11-10", 8, 31), s, 50));
    expect(await reason(log, run(jst("2026-11-10", 8, 32), "alpha", c.seq))).toBe("the run must be recorded before the cutoff of the batch's trading date");
  });

  it("submittedAt をさかのぼっても、同じ AI・同じ取引日の2つ目の依頼にはならない", async () => {
    const log = await setup();
    await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100));
    expect(await reason(log, sub(jst("2026-11-10", 8, 40), "alpha", "2026-11-10", 100, { submittedAt: jst("2026-11-10", 8, 0), customId: "x" }))).toMatch(/duplicate key llmbatch:alpha:2026-11-10$/);
  });
});

// 2026-11-08 の lead の決定で、送る前の確かめは ①（予約）の追記そのものになった。前の「batchId が null の仮の記録を canAppend に通す」前提はなくなった。
// ここでは、canAppend と append が同じ答えを返すこと、①を書いたあとの ②（送る）・③（送った記録）で予約が消えないことを確かめる
describe("送る前の予約（①）と、送ったあとの記録（③）の食い違い", () => {
  it("canAppend は何も書かない（何度呼んでも、そのあと本物の予約を書ける）。書いたあとは同じ取引日を断る", async () => {
    const log = await setup();
    const at = jst(DAY, 16, 35);
    const before = log.events.length;
    expect(await log.canAppend(sub(at, "alpha", "2026-11-10", 100))).toBeNull();
    expect(await log.canAppend(sub(at, "alpha", "2026-11-10", 100))).toBeNull();
    expect(log.events.length).toBe(before);
    const s = await ok(log, sub(at + 1000, "alpha", "2026-11-10", 100, { submittedAt: at }));
    expect(await log.canAppend(sub(at + 2000, "alpha", "2026-11-10", 100))).toMatch(/duplicate key llmbatch:alpha:2026-11-10$/);
    expect(await log.canAppend({ ...sub(at, "alpha", "2026-11-10", 100), type: "order_sheet.committed" })).toBe("use commitSheet");
    // ③ も canAppend で確かめられ、何も書かない
    expect(await log.canAppend(sent(at + 3000, s))).toBeNull();
    expect(log.events.length).toBe(before + 1);
  });

  it("提供元が返した batchId が形に合わなければ③は断られる。そのときも①の予約は残り、予約した費用で閉じるほかない", async () => {
    const log = await setup();
    const at = jst(DAY, 16, 35);
    const s = await ok(log, sub(at, "alpha", "2026-11-10", 100));
    for (const batchId of ["a".repeat(257), "batch 1", "batché", "", null, 1, undefined]) {
      expect(await reason(log, sent(at + 1000, s, { batchId })), String(batchId)).toBe("batchId must be a provider batch id");
    }
    expect(llmCostUsed(log.events, DAY)).toBe(100);
    // ③がないので、受け取り・打ち切りでは閉じられない
    expect(await reason(log, close(at + 2000, s, 0, { result: "expired" }))).toBe("a batch that was not sent can only close as failed");
    await ok(log, close(at + 2000, s, 100, { result: "failed", costUnknown: true }));
    expect(llmCostUsed(log.events, DAY)).toBe(100);
  });

  // 前は【低】「送るのに1時間より長くかかると、送ったあとの記録を書けない」だった。新しい形では①を送る前に書くので、送るのが遅れても予約は記録にある。
  // ③には時刻の決まりがない（1時間を過ぎても、取引日の締めを過ぎても書ける）。締めのあとの答えは agent.run の検査で使えない
  it("送るのに1時間より長くかかっても、①はもう書けていて、③は時刻に関係なく書ける", async () => {
    const log = await setup();
    const at = jst(DAY, 16, 35);
    const s = await ok(log, sub(at, "alpha", "2026-11-10", 100));
    await ok(log, sent(at + LLM_RECORD_WINDOW_MS + 1, s));
    const t = await ok(log, sub(at + LLM_RECORD_WINDOW_MS + 2, "beta", "2026-11-10", 100));
    await ok(log, sent(jst("2026-11-12", 9), t));
    expect(llmCostUsed(log.events, DAY)).toBe(200);
  });

  it("同じ AI の canAppend が2回続けて通っても、2つ目の予約は一意キーで断られる（同時に動いた2つの実行の片方だけが送れる）", async () => {
    const log = await setup();
    const at = jst(DAY, 16, 35);
    expect(await log.canAppend(sub(at, "alpha", "2026-11-10", 100))).toBeNull();
    expect(await log.canAppend(sub(at, "alpha", "2026-11-10", 100, { customId: "b2" }))).toBeNull();
    await okSent(log, sub(at, "alpha", "2026-11-10", 100));
    expect(await reason(log, sub(at, "alpha", "2026-11-10", 100, { customId: "b2" }))).toMatch(/duplicate key llmbatch:alpha:2026-11-10$/);
  });

  it("別の AI の予約が同時に canAppend を通っても、合わせて上限を超える2つ目は追記で断る", async () => {
    const log = await setup();
    const at = jst(DAY, 16, 35);
    await okSent(log, sub(at, "alpha", "2026-11-10", 400));
    expect(await log.canAppend(sub(at, "beta", "2026-11-10", 500))).toBeNull();
    expect(await log.canAppend(sub(at, "gamma", "2026-11-10", 500))).toBeNull();
    await ok(log, sub(at, "beta", "2026-11-10", 500));
    expect(await reason(log, sub(at, "gamma", "2026-11-10", 500))).toBe("daily LLM cost limit exceeded (1400 > 1000)");
  });

  it("canAppend のあとに祝日の一覧が変わると、取引日が変わって本物の記録は断られる", async () => {
    const log = await setup();
    const at = jst(DAY, 16, 35);
    expect(await log.canAppend(sub(at, "alpha", "2026-11-10", 100))).toBeNull();
    await ok(log, { type: "holidays.adopted", recordedAt: at, actor: "operator:owner", refs: [], payload: { holidaysSha256: H2 } });
    expect(await reason(log, sub(at, "alpha", "2026-11-10", 100))).toBe("tradingDate must be the next trading date");
    // 記録が書けたあとは、その取引日を休みにする一覧には変えられない（逆向きは守られている）
    const log2 = await setup();
    await okSent(log2, sub(at, "alpha", "2026-11-10", 100));
    expect(await reason(log2, { type: "holidays.adopted", recordedAt: at, actor: "operator:owner", refs: [], payload: { holidaysSha256: H2 } })).toMatch(/changes 2026-11-10, which the log already used/);
  });

  it("無作為の下書き（シード固定）で、canAppend の答えと append の結果が必ず一致する", async () => {
    let seed = 0x179;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const log = await setup();
    let at = jst(DAY, 16, 0);
    const mismatches: string[] = [];
    /** 断られた理由ごとの数（試した範囲が偏っていないかを、失敗の出力で見られるように） */
    const refused = new Map<string, number>();
    for (let i = 0; i < 2400; i++) {
      at += pick([0, 1, 60_000, 60_000, 3_600_000]);
      const agentId = pick(["alpha", "beta", "gamma", "delta"]);
      const subs = log.events.filter((e) => e.type === "llm.batch.submitted");
      const closes = log.events.filter((e) => e.type === "llm.batch.closed");
      let d: Draft;
      const kind = pick(["sub", "sent", "sent", "close", "run", "run"]);
      if (kind === "sub" || subs.length === 0) {
        const next = tradingDateFor(at, TABLE.dates);
        const td = pick([next, next, next, "2026-11-10", "2026-11-11", "2026-11-12"]);
        d = sub(at, agentId, td, pick([1, 2, 100, 100, 1000]), {
          submittedAt: at - pick([0, 0, 1, 3_600_000, 3_600_001]),
          maxInputTokens: pick([0, 1, 1, 100, 10_000_000]),
          yenPerUsd: pick([160, 160, 0, 1]),
          // ①に batchId を書くのは、知らない項目として断られるはず
          ...(rnd() < 0.15 ? { batchId: pick([null, `b${i}`]) } : {}),
        });
      } else if (kind === "sent") {
        const s = pick(subs);
        d = sent(at, s, pick([{}, {}, { batchId: "x y" }, { agentId }, { batchSeq: s.seq + 1 }]));
        if ((d.payload as { batchSeq: number }).batchSeq !== s.seq) d = { ...d, refs: [(d.payload as { batchSeq: number }).batchSeq] };
      } else if (kind === "close" || closes.length === 0) {
        // 受け取りの記録（と、それを指す実行）も試せるよう、多くは③のある①を閉じる
        const sentSeqs = new Set(log.events.filter((e) => e.type === "llm.batch.sent").map((e) => (e.payload as { batchSeq: number }).batchSeq));
        const withSent = subs.filter((e) => sentSeqs.has(e.seq));
        const s = withSent.length > 0 && rnd() < 0.7 ? pick(withSent) : pick(subs);
        const cost = pick([0, 1, 2, 2, 50, (s.payload as { maxCost: number }).maxCost]);
        d = close(at, s, cost, pick([{}, {}, {}, { result: "expired", costUnknown: true }, { result: "failed" }, { outputTokens: cost + 1 }, { inputCentsPer10MTok: 700_000 }, { cacheReadInputTokens: 1 }]));
        if (rnd() < 0.2) d = { ...d, payload: { ...d.payload, agentId } };
      } else {
        const collected = closes.filter((e) => (e.payload as { result: string }).result === "collected");
        // 締めの前に指せるよう、多くは最後に受け取った記録を指す
        const c = collected.length > 0 && rnd() < 0.7 ? collected.at(-1)! : pick(closes);
        d = run(at, pick([agentId, (c.payload as { agentId: string }).agentId]), c.seq, pick([{}, { sentBodyHash: "a".repeat(64) }]));
      }
      const can = await log.canAppend(d);
      const r = await log.append(d);
      if (!r.ok) refused.set(`${d.type}: ${r.reason}`, (refused.get(`${d.type}: ${r.reason}`) ?? 0) + 1);
      if ((can === null) !== r.ok || (!r.ok && can !== r.reason)) mismatches.push(`#${i} ${JSON.stringify(d)} can=${String(can)} append=${r.ok ? "ok" : r.reason}`);
    }
    expect(mismatches).toEqual([]);
    // 通る記録と断られる記録の両方を比べたことを確かめる
    const written = (t: string) => log.events.filter((e) => e.type === t).length;
    const counts = ["llm.batch.submitted", "llm.batch.sent", "llm.batch.closed", "agent.run"].map(written);
    expect(counts.every((n) => n >= 2), `${counts.join("/")} ${JSON.stringify([...refused])}`).toBe(true);
  });
});

describe("実際の費用は、トークン数と料金から出した値ちょうど", () => {
  it("1つ少ない・1つ多い費用は断る。値は src/llm/cost.ts の batchCostDeciyen と同じ", async () => {
    const log = await setup();
    const s = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 1000, { ...SONNET }));
    const tokens = { inputTokens: 123_457, outputTokens: 6_789 };
    const want = llmTokenCost(tokens, { yenPerUsd: 160, ...SONNET })!;
    expect(want).toBe(batchCostDeciyen({ ...tokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, { inputCentsPerMTok: 100, outputCentsPerMTok: 500 }, 160));
    for (const cost of [want - 1, want + 1, 0]) {
      expect(await reason(log, close(jst(DAY, 17), s, cost, { ...tokens, ...SONNET })), String(cost)).toBe(`cost must be ${want} (from the tokens and the price)`);
    }
    await ok(log, close(jst(DAY, 17), s, want, { ...tokens, ...SONNET }));
  });

  it("閉じた記録の料金を予約より下げて（0まで）費用を小さく書くことはできない（d4bb3e4 で直った）", async () => {
    const log = await setup();
    const s = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 1000, { ...SONNET }));
    for (const price of [{ inputCentsPer10MTok: 0, outputCentsPer10MTok: 0 }, { inputCentsPer10MTok: 999, outputCentsPer10MTok: 5_000 }, { inputCentsPer10MTok: 1_000, outputCentsPer10MTok: 4_999 }]) {
      const want = llmTokenCost({ inputTokens: 5_000_000, outputTokens: 1_000_000 }, { yenPerUsd: 160, ...price })!;
      expect(await reason(log, close(jst(DAY, 17), s, want, { inputTokens: 5_000_000, outputTokens: 1_000_000, ...price })), JSON.stringify(price)).toBe("the price must equal the reserved price");
    }
  });

  // 前の【低】（予約の料金を0にすれば、閉じた記録の費用も0になる）は、2962eda で単価と上限のトークン数を1以上にして断るようになった
  it("単価0・上限のトークン数0の予約は断る（2962eda で直った）", async () => {
    const log = await setup();
    const at = jst(DAY, 16, 35);
    const want = "prices and max token counts must be at least 1";
    for (const extra of [{ inputCentsPer10MTok: 0 }, { outputCentsPer10MTok: 0 }, { inputCentsPer10MTok: 0, outputCentsPer10MTok: 0 }, { maxInputTokens: 0 }, { maxOutputTokens: 0, bodyMaxOutputTokens: 0 }, { maxInputTokens: 0, maxOutputTokens: 0 }]) {
      expect(await reason(log, sub(at, "beta", "2026-11-10", 1, { maxInputTokens: 10_000_000, maxOutputTokens: 10_000_000, ...extra })), JSON.stringify(extra)).toBe(want);
    }
  });

  // 【低・記録からは見分けられない】単価そのものは、記録の検査では本物の料金表と突き合わせない。単価を1（1,000万トークンあたり1セント）にすれば、
  // 1,000万トークンずつ使っても使用済みはごくわずか。料金が本物かは、runner が料金表から入れることに頼る（前と同じ、残る限界）
  it("単価を1まで下げれば、1,000万トークンずつ使っても使用済みはわずかで済む（記録の検査の外）", async () => {
    const log = await setup();
    const tiny = { inputCentsPer10MTok: 1, outputCentsPer10MTok: 1 };
    const t = await okSent(log, sub(jst(DAY, 16, 35), "beta", "2026-11-10", 32, { ...tiny, maxInputTokens: 10_000_000, maxOutputTokens: 10_000_000, bodyMaxOutputTokens: 10_000_000 }));
    const want = llmTokenCost({ inputTokens: 10_000_000, outputTokens: 10_000_000 }, { yenPerUsd: 160, ...tiny })!;
    await ok(log, close(jst(DAY, 17), t, want, { inputTokens: 10_000_000, outputTokens: 10_000_000, ...tiny }));
    expect(llmCostUsed(log.events, DAY)).toBe(want);
    // 合わせて2,000万トークンでも3.2円
    expect(want).toBe(32);
  });

  it("予約と違う料金・料金の欠け・悪い値は断る。費用が分からない記録に料金があれば断る。閉じた記録に yenPerUsd は書けない", async () => {
    const log = await setup();
    const s = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 1000));
    const bad = "the price must equal the reserved price";
    expect(await reason(log, close(jst(DAY, 17), s, 2, { inputCentsPer10MTok: 625_001 }))).toBe(bad);
    expect(await reason(log, close(jst(DAY, 17), s, 2, { outputCentsPer10MTok: 625_001 }))).toBe(bad);
    for (const v of [-1, 0.5, "625000", null, undefined, 625_000.0000001]) {
      expect(await reason(log, close(jst(DAY, 17), s, 2, { inputCentsPer10MTok: v })), String(v)).toBe(bad);
    }
    expect(await reason(log, close(jst(DAY, 17), s, 1000, { result: "expired", costUnknown: true, ...PRICE }))).toBe("an unknown cost has no price");
    expect(await reason(log, close(jst(DAY, 17), s, 1000, { result: "expired", costUnknown: true, inputCentsPer10MTok: 0 }))).toBe("an unknown cost has no price");
    expect(await reason(log, close(jst(DAY, 17), s, 1, { yenPerUsd: 1 }))).toBe("unknown field in a batch closing");
  });

  // 【低・宛先 platform】Gemini の料金は 2027-01-01（UTC+14。2026-12-31T10:00Z）から倍になり、src/llm/gemini-pricing.ts の geminiBatchPrice は
  // 「時刻＋48時間」で料金を選ぶ。契約（d4bb3e4）は「予約の料金を submittedAt の時点で一度だけ決め、閉じたときも同じ料金」とした。
  // そのため、境目の直前に決めて直後に作られたバッチは、提供元は倍の料金で請求するのに、記録は古い料金のまま少なく残る（数ミリ秒の幅で一度だけ起きうる）
  it("Gemini の料金が倍になる境目：予約が古い料金なら、閉じた記録も古い料金でしか書けず、費用は本当の請求より少なく残る", async () => {
    const model = "gemini-3.8-flash";
    const created = GEMINI_PRICE_SWITCH_AT - 48 * 3_600_000; // これ以後に作ったバッチは倍の料金
    const decided = created - 1;
    const old = geminiBatchPrice(model, decided)!;
    const doubled = geminiBatchPrice(model, created)!;
    expect(doubled.inputCentsPer10MTok).toBe(old.inputCentsPer10MTok * 2);
    const oldPrice = { inputCentsPer10MTok: old.inputCentsPer10MTok, outputCentsPer10MTok: old.outputCentsPer10MTok };
    const newPrice = { inputCentsPer10MTok: doubled.inputCentsPer10MTok, outputCentsPer10MTok: doubled.outputCentsPer10MTok };
    const maxTok = { inputTokens: 200_000, outputTokens: 100_000 };
    const maxCost = llmTokenCost(maxTok, { yenPerUsd: 160, ...oldPrice })!;
    const log = await setup();
    const s = await okSent(log, sub(decided + 500, "alpha", "2026-12-30", maxCost, { provider: "gemini", modelId: model, submittedAt: decided, ...oldPrice, maxInputTokens: maxTok.inputTokens, maxOutputTokens: maxTok.outputTokens }));
    const real = geminiBatchCostDeciyen({ ...maxTok, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, model, created, 160)!;
    expect(real).toBe(llmTokenCost(maxTok, { yenPerUsd: 160, ...newPrice }));
    expect(await reason(log, close(decided + 60_000, s, real, { ...maxTok, ...newPrice }))).toBe("the price must equal the reserved price");
    await ok(log, close(decided + 60_000, s, maxCost, { ...maxTok, ...oldPrice }));
    expect(llmCostUsed(log.events, jstDayOf(decided))).toBe(maxCost);
    expect(real).toBe(maxCost * 2);
  });

  it("Gemini の半セントの料金でも、費用は gemini-pricing.ts の計算と同じ（無作為の100組、シード固定）", () => {
    let x = 12345;
    const next = () => (x = (x * 1103515245 + 12345) % 2 ** 31);
    for (let i = 0; i < 100; i++) {
      const t = { inputTokens: next() % 3_000_000, outputTokens: next() % 500_000 };
      const at = i % 2 === 0 ? Date.parse("2026-11-09T00:00Z") : GEMINI_PRICE_SWITCH_AT;
      const p = geminiBatchPrice("gemini-3.8-flash", at)!;
      const got = llmTokenCost(t, { yenPerUsd: 160, inputCentsPer10MTok: p.inputCentsPer10MTok, outputCentsPer10MTok: p.outputCentsPer10MTok });
      expect(got, JSON.stringify(t)).toBe(geminiBatchCostDeciyen({ ...t, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, "gemini-3.8-flash", at, 160));
    }
  });
});

describe("キャッシュのトークン", () => {
  it("キャッシュへの書き込みは入力の2倍、読み出しは入力と同じ単価で数える（batchCostDeciyen と同じ）。数えずに安く書けば断る", async () => {
    const log = await setup();
    const s = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 1000, { ...SONNET }));
    const usage = { inputTokens: 1_000, outputTokens: 2_000, cacheCreationInputTokens: 300_000, cacheReadInputTokens: 700_000 };
    const want = llmTokenCost(usage, { yenPerUsd: 160, ...SONNET })!;
    expect(want).toBe(batchCostDeciyen(usage, { inputCentsPerMTok: 100, outputCentsPerMTok: 500 }, 160));
    const noCache = llmTokenCost({ inputTokens: 1_000, outputTokens: 2_000 }, { yenPerUsd: 160, ...SONNET })!;
    expect(await reason(log, close(jst(DAY, 17), s, noCache, { ...usage, ...SONNET }))).toBe(`cost must be ${want} (from the tokens and the price)`);
    await ok(log, close(jst(DAY, 17), s, want, { ...usage, ...SONNET }));
  });

  it("キャッシュの欄に、負・小数・文字列・null は使えない", async () => {
    const log = await setup();
    const s = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 1000));
    for (const f of ["cacheCreationInputTokens", "cacheReadInputTokens"]) {
      for (const v of [-1, 0.5, "1", null, 2 ** 53]) {
        expect(await reason(log, close(jst(DAY, 17), s, 1, { [f]: v })), `${f}=${String(v)}`).toBe("cost and token counts must be non-negative integers");
      }
    }
  });

  // 【低・宛先 platform】maxCost の下限（maxInputTokens・maxOutputTokens から出す費用）は、キャッシュへの書き込み（入力の2倍）を数えない。
  // キャッシュを使う依頼では、実際の費用が予約を超えうる。超えた分は、上限の検査がその日の合計で挙げる（予約の時点では止まらない）
  it("上限のトークン数ちょうどの予約でも、キャッシュへの書き込みがあれば実際の費用は予約を超え、その日の合計で挙がる", async () => {
    const log = await setup();
    // 受け取った記録は出力のトークン数が1以上なので、出力の上限も1にする（1ce37a0）
    const maxTok = { inputTokens: 300_000, outputTokens: 1 };
    const maxCost = llmTokenCost(maxTok, { yenPerUsd: 160, ...SONNET })!;
    const s = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", maxCost, { ...SONNET, maxInputTokens: maxTok.inputTokens, maxOutputTokens: 1 }));
    await okSent(log, sub(jst(DAY, 16, 36), "beta", "2026-11-10", 1000 - maxCost));
    const usage = { inputTokens: 0, outputTokens: 1, cacheCreationInputTokens: 300_000 };
    const cost = llmTokenCost(usage, { yenPerUsd: 160, ...SONNET })!;
    expect(cost).toBeGreaterThanOrEqual(maxCost * 2 - 1);
    await ok(log, close(jst(DAY, 17), s, cost, { ...usage, ...SONNET }));
    expect(llmCostProblems(log.events).map((p) => p.kind)).toEqual(["total"]);
  });
});

describe("maxCost と上限のトークン数", () => {
  it("maxCost は上限のトークン数の費用以上（ちょうどは通り、1つ少なければ断る）。Gemini の半セントの料金でも同じ", async () => {
    for (const price of [SONNET, { inputCentsPer10MTok: 375, outputCentsPer10MTok: 1875 }]) {
      const log = await setup();
      const maxTok = { inputTokens: 123_457, outputTokens: 65_537 };
      const bound = llmTokenCost(maxTok, { yenPerUsd: 160, ...price })!;
      const extra = { ...price, maxInputTokens: maxTok.inputTokens, maxOutputTokens: maxTok.outputTokens };
      expect(await reason(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", bound - 1, extra))).toBe(`maxCost must be at least ${bound} (the cost of the max tokens)`);
      await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", bound, extra));
    }
  });

  it("上限のトークン数・料金・yenPerUsd に悪い値は使えない。費用が安全な整数を超えると断る（例外にならない）", async () => {
    const log = await setup();
    const at = jst(DAY, 16, 35);
    for (const f of ["maxInputTokens", "maxOutputTokens", "inputCentsPer10MTok", "outputCentsPer10MTok"]) {
      for (const v of [-1, 0.5, "1", null, 2 ** 53]) {
        expect(await reason(log, sub(at, "alpha", "2026-11-10", 100, { [f]: v })), `${f}=${String(v)}`).toBe("prices and max token counts must be non-negative integers");
      }
    }
    for (const v of [0, -1, 1.5, "160", null]) {
      expect(await reason(log, sub(at, "alpha", "2026-11-10", 100, { yenPerUsd: v })), String(v)).toBe("yenPerUsd must be a positive integer");
    }
    const huge = { maxInputTokens: Number.MAX_SAFE_INTEGER, inputCentsPer10MTok: Number.MAX_SAFE_INTEGER, yenPerUsd: Number.MAX_SAFE_INTEGER };
    expect(await reason(log, sub(at, "alpha", "2026-11-10", Number.MAX_SAFE_INTEGER, huge))).toBe("maxCost must be at least null (the cost of the max tokens)");
    const s = await okSent(log, sub(at, "alpha", "2026-11-10", 100));
    expect(await reason(log, close(at + 1, s, 1, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER, cacheCreationInputTokens: Number.MAX_SAFE_INTEGER }))).toBe("cost must be null (from the tokens and the price)");
  });

  // 記録に残る yenPerUsd で確かめる決まり（core の判断）。owner の決めた160と違う値でも通る。値が正しいかは記録の検査の外
  it("yenPerUsd は160に決め打ちされていない（1でも通り、費用は160分の1になる）", async () => {
    const log = await setup();
    const s = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 11, { yenPerUsd: 1, ...SONNET, maxInputTokens: 1_000_000 }));
    const want = llmTokenCost({ inputTokens: 1_000_000, outputTokens: 0 }, { yenPerUsd: 1, ...SONNET })!;
    // 出力のない受け取りは書けない（1ce37a0）ので、入力だけ課金された打ち切りとして閉じる
    await ok(log, close(jst(DAY, 17), s, want, { result: "expired", inputTokens: 1_000_000, outputTokens: 0, ...SONNET }));
    expect(want).toBe(10);
    expect(llmTokenCost({ inputTokens: 1_000_000, outputTokens: 0 }, { yenPerUsd: 160, ...SONNET })).toBe(1600);
  });
});

describe("agent.run の batchSeq（元になったバッチ）", () => {
  /** 4体が 11-09 の夕方に 11-10 の分を頼み、alpha と delta は受け取り、beta は期限切れ、gamma は送れずに失敗（③なし・費用0） */
  async function flow() {
    const log = await setup(["alpha", "beta", "gamma", "delta"]);
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100));
    const b = await okSent(log, sub(jst(DAY, 16, 36), "beta", "2026-11-10", 100));
    const g = await ok(log, sub(jst(DAY, 16, 37), "gamma", "2026-11-10", 100));
    const dl = await okSent(log, sub(jst(DAY, 16, 38), "delta", "2026-11-10", 100));
    const ca = await ok(log, close(jst("2026-11-10", 6, 50), a, 40));
    const cb = await ok(log, close(jst("2026-11-10", 6, 51), b, 100, { result: "expired", costUnknown: true }));
    const cg = await ok(log, close(jst("2026-11-10", 6, 52), g, 0, { result: "failed", notCreatedError: "timeout" }));
    const cd = await ok(log, close(jst("2026-11-10", 6, 53), dl, 10));
    return { log, a, ca, cb, cg, cd };
  }
  const notCollected = "batchSeq must be a collected llm.batch.closed of the same agent";

  it("同じ AI の受け取った記録を、締めの前に、同じ本文のハッシュで指せば通る", async () => {
    const { log, ca } = await flow();
    await ok(log, run(jst("2026-11-10", 7), "alpha", ca.seq));
  });

  it("別の AI の受け取った記録・期限切れ・失敗・依頼の記録・閉じた記録でない記録は指せない", async () => {
    const { log, a, ca, cb, cg } = await flow();
    expect(await reason(log, run(jst("2026-11-10", 7), "beta", ca.seq))).toBe(notCollected);
    expect(await reason(log, run(jst("2026-11-10", 7), "beta", cb.seq))).toBe(notCollected);
    expect(await reason(log, run(jst("2026-11-10", 7), "gamma", cg.seq))).toBe(notCollected);
    expect(await reason(log, run(jst("2026-11-10", 7), "alpha", a.seq))).toBe(notCollected);
    expect(await reason(log, run(jst("2026-11-10", 7), "alpha", 1))).toBe(notCollected);
  });

  it("本文のハッシュが依頼と違う・欠けていれば断る。batchSeq を refs に入れなければ断る。数でない batchSeq は断る", async () => {
    const { log, ca } = await flow();
    expect(await reason(log, run(jst("2026-11-10", 7), "alpha", ca.seq, { sentBodyHash: "a".repeat(64) }))).toBe("sentBodyHash must match the batch submission");
    const noHash = run(jst("2026-11-10", 7), "alpha", ca.seq);
    delete noHash.payload.sentBodyHash;
    expect(await reason(log, noHash)).toBe("sentBodyHash must match the batch submission");
    expect(await reason(log, { ...run(jst("2026-11-10", 7), "alpha", ca.seq), refs: [] })).toBe(`payload refers to ${ca.seq} outside refs`);
    expect(await reason(log, { ...run(jst("2026-11-10", 7), "alpha", ca.seq), payload: { ...run(0, "alpha", ca.seq).payload, batchSeq: String(ca.seq) } })).toBe("invalid batchSeq");
  });

  it("その取引日の締め（8:30 ちょうどを含む）のあと・翌日には指せない", async () => {
    const { log, ca } = await flow();
    const late = "the run must be recorded before the cutoff of the batch's trading date";
    expect(await reason(log, run(jst("2026-11-10", 8, 30), "alpha", ca.seq))).toBe(late);
    expect(await reason(log, run(jst("2026-11-11", 7), "alpha", ca.seq))).toBe(late);
    const { log: log2, ca: ca2 } = await flow();
    await ok(log2, run(jst("2026-11-10", 8, 29, 59, 999), "alpha", ca2.seq));
  });

  it("前回の低の指摘：締めのあとに collected で閉じることは今も書けるが、その答えを batchSeq で指す実行は書けない", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100));
    const c = await ok(log, close(jst("2026-11-10", 9), a, 40));
    expect(await reason(log, run(jst("2026-11-10", 9, 1), "alpha", c.seq))).toBe("the run must be recorded before the cutoff of the batch's trading date");
  });

  // 【低・宛先 lead と core】batchSeq は任意。LLM の実行でも batchSeq を書かなければ、締めのあとに受け取った答えと同じ本文のハッシュの実行を、照合を通して書ける。
  // 取引の先読みにはならない（注文票の入力は締めで確かめる）が、「どのバッチの答えか」は記録から確かめられない
  it("batchSeq を書かなければ、締めのあとに受け取った答えと同じ本文のハッシュの実行も書ける", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100));
    await ok(log, close(jst("2026-11-10", 9), a, 40));
    await ok(log, run(jst("2026-11-10", 9, 1), "alpha", undefined, { cost: 40, inputTokens: 0, outputTokens: 40 }));
  });

  // 【低・宛先 core】1つの受け取った記録を、同じ目的の2つの実行が指せた（一意キーがなかった）。72f340b で一意キー llmrun:<batchSeq>:<purpose> が入り、2つ目は断られる
  it("1つの受け取った記録を、同じ目的（order）の2つの実行は指せない", async () => {
    const { log, ca } = await flow();
    await ok(log, run(jst("2026-11-10", 7), "alpha", ca.seq));
    expect(await reason(log, run(jst("2026-11-10", 7, 1), "alpha", ca.seq, { ok: false, errorCode: "invalid_output" }))).toMatch(new RegExp(`duplicate key llmrun:${ca.seq}:order`));
  });

  // 【中・宛先 core】バッチの答えを使った実行の入力（inputSeqs）に、依頼を送ったあとに記録された情報を入れられる。
  // 送った本文には入っていなかった情報を「判断に使った」と記録でき、発言と情報の取得の順序（AGENTS.md の不変条件）が記録上で崩れる。
  // 直し方の方針：batchSeq があるとき、inputSeqs はすべて元の依頼（llm.batch.submitted）の seq より小さいことを求める（72f340b で直った）
  it("バッチの答えを使った実行の入力に、依頼のあとに取り込んだ情報は入れられない", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", "2026-11-10", 100));
    const src = await ok(log, { type: "source.captured", recordedAt: jst(DAY, 20), actor: "system", refs: [], payload: { publishedAt: jst(DAY, 19), fetchedAt: jst(DAY, 20) } });
    const c = await ok(log, close(jst("2026-11-10", 6, 50), a, 40));
    expect(src.seq).toBeGreaterThan(a.seq);
    expect(await reason(log, { ...run(jst("2026-11-10", 7), "alpha", c.seq, { inputSeqs: [src.seq] }), refs: [c.seq, src.seq] })).toBe("inputSeqs must be recorded before the batch submission");
  });

  it("保存済みのログで、実行の batchSeq を別の AI の受け取った記録に書き換えると、照合で落ちる", async () => {
    const { log, ca, cd: b2 } = await flow();
    await ok(log, run(jst("2026-11-10", 7), "alpha", ca.seq));
    const drafts = log.events.map((e) => ({ type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: e.payload as Record<string, unknown> }));
    const last = drafts.at(-1)!;
    const forgedDrafts = [...drafts.slice(0, -1), { ...last, refs: [b2.seq], payload: { ...last.payload, batchSeq: b2.seq } }];
    const forged: LogEvent[] = [];
    for (const d of forgedDrafts) forged.push(await sealEvent(forged.at(-1) ?? null, d));
    const fresh = newLog();
    let problem: string | null = null;
    for (const e of forged) if ((problem = await fresh.admit(e))) break;
    expect(problem).toMatch(/batchSeq must be a collected llm.batch.closed of the same agent/);
  });
});
