// 検証役（#179、PR #210）：送る前に予約を記録する形（2026-11-08 の lead の決定）を壊しにいく。
// ① llm.batch.submitted（送る前の予約。バッチのIDなし。1日の上限をここで確かめる）→ ② 送る → ③ llm.batch.sent（①を指し、バッチのIDを足す）→ llm.batch.closed。
// 期待は lead の決定から書く。欠陥の再現は it.fails（直ったら、ふつうの試験に戻す）。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { sealEvent } from "../../src/events/chain";
import { LLM_DAILY_COST_LIMIT, llmCostProblems, llmCostUsed, llmSentOf, llmTicketOf } from "../../src/events/llm-cost";
import type { LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/table";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0, ss = 0, ms = 0) =>
  Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}+09:00`);
const H = "c".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set(["2026-11-23"]) };
const CTX = { holidayTables: new Map([[H, TABLE]]) };
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
const BODY = "b".repeat(64);
const sub = (at: number, agentId: string, tradingDate: string, maxCost: number, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.submitted",
  recordedAt: at,
  actor: "system",
  refs: [],
  payload: {
    agentId, provider: "anthropic", modelId: "m", promptVersion: "v1", sentBodyHash: BODY, customId: `${agentId}-${tradingDate}`, maxCost, tradingDate,
    submittedAt: at, yenPerUsd: 160, ...PRICE, maxInputTokens: 0, maxOutputTokens: 0, ...extra,
  },
});
const sent = (at: number, s: LogEvent, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.sent",
  recordedAt: at,
  actor: "system",
  refs: [s.seq],
  payload: { batchSeq: s.seq, agentId: (s.payload as { agentId: string }).agentId, batchId: `batch_${s.seq}`, ...extra },
});
const close = (at: number, s: LogEvent, cost: number, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.closed",
  recordedAt: at,
  actor: "system",
  refs: [s.seq],
  payload: {
    batchSeq: s.seq, agentId: (s.payload as { agentId: string }).agentId, result: "collected", cost, inputTokens: 0, outputTokens: cost,
    ...(extra.costUnknown === true ? {} : PRICE), ...extra,
  },
});
async function okSent(log: EventLog, d: Draft): Promise<LogEvent> {
  const s = await ok(log, d);
  await ok(log, sent(d.recordedAt, s));
  return s;
}

type Forge = Draft & { keys: string[] };
const draftOf = (e: LogEvent): Forge => ({ type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: e.payload as Record<string, unknown> });
async function forge(drafts: readonly Forge[]): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  for (const d of drafts) out.push(await sealEvent(out.at(-1) ?? null, d));
  return out;
}
async function admitAll(events: readonly LogEvent[]): Promise<string | null> {
  const log = newLog();
  for (const e of events) {
    const p = await log.admit(e);
    if (p) return p;
  }
  return null;
}

const DAY = "2026-11-09";
const TD = "2026-11-10";
const notSub = "batchSeq must be llm.batch.submitted of the same agent";

describe("③ 送った記録（llm.batch.sent）が指す①", () => {
  it("別の AI の①・①でない記録・閉じた記録・③自身は指せない。まだない番号は refs の検査で断る", async () => {
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 100));
    const b = await ok(log, sub(jst(DAY, 16, 36), "beta", TD, 100));
    const at = jst(DAY, 17);
    // 別の AI の①を、自分の名前で指す・相手の名前で自分の①を指す
    expect(await reason(log, { ...sent(at, b), payload: { ...sent(at, b).payload, agentId: "alpha" } })).toBe(notSub);
    expect(await reason(log, { ...sent(at, a), payload: { ...sent(at, a).payload, agentId: "beta" } })).toBe(notSub);
    expect(await reason(log, { ...sent(at, a), payload: { ...sent(at, a).payload, agentId: "delta" } })).toBe("unknown agent delta");
    // agent.registered（seq 2）を指す
    expect(await reason(log, { ...sent(at, a), refs: [2], payload: { batchSeq: 2, agentId: "alpha", batchId: "x" } })).toBe(notSub);
    // 閉じた記録・③を指す
    const sa = await ok(log, sent(at, a));
    expect(await reason(log, { ...sent(at, a), refs: [sa.seq], payload: { batchSeq: sa.seq, agentId: "alpha", batchId: "y" } })).toBe(notSub);
    const cb = await ok(log, close(at, b, 100, { result: "failed", costUnknown: true }));
    expect(await reason(log, { ...sent(at, b), refs: [cb.seq], payload: { batchSeq: cb.seq, agentId: "beta", batchId: "y" } })).toBe(notSub);
    const next = log.events.length + 1;
    expect(await reason(log, { ...sent(at, a), refs: [next], payload: { batchSeq: next, agentId: "alpha", batchId: "z" } })).toBe(`payload refers to ${next} outside refs`);
  });

  it("batchSeq を refs に入れない・数でない・欠けている③は断る。知らない項目（取引日・費用など）も断る", async () => {
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 100));
    const at = jst(DAY, 17);
    expect(await reason(log, { ...sent(at, a), refs: [] })).toBe(`payload refers to ${a.seq} outside refs`);
    for (const batchSeq of [String(a.seq), a.seq + 0.5, null, undefined]) {
      expect(await reason(log, { ...sent(at, a), payload: { ...sent(at, a).payload, batchSeq } }), String(batchSeq)).not.toBe("ok");
    }
    for (const extra of [{ tradingDate: "2026-11-11" }, { maxCost: 1 }, { cost: 0 }, { submittedAt: at }, { sentBodyHash: BODY }]) {
      expect(await reason(log, sent(at, a, extra)), JSON.stringify(extra)).toBe("unknown field in a batch sending");
    }
    await ok(log, sent(at, a));
  });

  it("1つの①に③は1回だけ（同じ・違うバッチのIDでも）。キーを付けずに2つ目を足した保存済みのログは照合で落ちる", async () => {
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 100));
    await ok(log, sent(jst(DAY, 16, 36), a));
    expect(await reason(log, sent(jst(DAY, 16, 37), a))).toMatch(new RegExp(`duplicate key llmsent:${a.seq}$`));
    expect(await reason(log, sent(jst(DAY, 16, 37), a, { batchId: "batch_other" }))).toMatch(new RegExp(`duplicate key llmsent:${a.seq}$`));
    const forged = await forge([...log.events.map(draftOf), { ...draftOf(log.events.at(-1)!), recordedAt: jst(DAY, 16, 37), keys: [], payload: { batchSeq: a.seq, agentId: "alpha", batchId: "batch_other" } }]);
    expect(await admitAll(forged)).toMatch(new RegExp(`duplicate key llmsent:${a.seq}$`));
    // 控えは最初の③から作る
    expect((llmSentOf(log.events, a.seq)!.payload as { batchId: string }).batchId).toBe(`batch_${a.seq}`);
  });

  it("閉じたあとの①には③を書けない（費用0・予約した費用のどちらで閉じても）。並べ替えた保存済みのログも照合で落ちる", async () => {
    for (const [cost, extra] of [[0, { result: "failed" }], [100, { result: "failed", costUnknown: true }]] as const) {
      const log = await setup();
      const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 100));
      await ok(log, close(jst(DAY, 16, 36), a, cost, extra));
      expect(await reason(log, sent(jst(DAY, 16, 37), a)), String(cost)).toBe("the batch is already closed");
    }
    // ③のあとに閉じたログで、③と閉じた記録を入れ替えて連鎖を作り直す
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 100));
    await ok(log, sent(jst(DAY, 16, 36), a));
    await ok(log, close(jst(DAY, 16, 36), a, 100, { result: "expired", costUnknown: true }));
    const d = log.events.map(draftOf);
    const swapped = await forge([...d.slice(0, -2), d.at(-1)!, d.at(-2)!]);
    // 閉じた記録が先に来ると、③のない①を expired で閉じたことになり断られる
    expect(await admitAll(swapped)).toMatch(/a batch that was not sent can only close as failed/);
  });

  it("③は system だけが書ける。①を指していない③から受け取りの控えは作れない", async () => {
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 100));
    const b = await ok(log, sub(jst(DAY, 16, 36), "beta", TD, 100));
    for (const actor of ["agent:alpha", "operator:owner"] as const) {
      expect(await reason(log, { ...sent(jst(DAY, 17), a), actor }), actor).toBe("llm.batch.sent must be written by system");
    }
    const sb = await ok(log, sent(jst(DAY, 17), b));
    expect(llmTicketOf(a, null)).toBeNull();
    expect(() => llmTicketOf(a, sb)).toThrow(RangeError);
    expect(llmTicketOf(b, sb)).toMatchObject({ batchSeq: b.seq, agentId: "beta", batchId: `batch_${b.seq}`, maxCost: 100 });
  });

  it("③があっても、閉じるまでは予約した費用を数える。③だけの依頼の答えは、実行（agent.run）から指せない", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    expect(llmCostUsed(log.events, DAY)).toBe(600);
    const s = log.events.at(-1)!;
    const run: Draft = { type: "agent.run", recordedAt: jst(TD, 7), actor: "system", refs: [s.seq], payload: { agentId: "alpha", purpose: "order", inputSeqs: [], ok: true, sentBodyHash: BODY, batchSeq: s.seq } };
    expect(await reason(log, run)).toBe("batchSeq must be a collected llm.batch.closed of the same agent");
    expect(await reason(log, { ...run, refs: [a.seq], payload: { ...run.payload, batchSeq: a.seq } })).toBe("batchSeq must be a collected llm.batch.closed of the same agent");
  });
});

describe("③のある①の閉じ方", () => {
  it("費用0の failed は断る（トークン数0でも、料金を付けても）。予約した費用（costUnknown）か、トークン数から出した実費なら閉じられる", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    const zero = "a sent batch cannot close as failed with cost 0";
    expect(await reason(log, close(jst(DAY, 17), a, 0, { result: "failed" }))).toBe(zero);
    expect(await reason(log, close(jst(DAY, 17), a, 0, { result: "failed", inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 }))).toBe(zero);
    expect(await reason(log, close(jst(DAY, 17), a, 0, { result: "failed", inputCentsPer10MTok: 0, outputCentsPer10MTok: 0 }))).not.toBe("ok");
    await ok(log, close(jst(DAY, 17), a, 600, { result: "failed", costUnknown: true }));
    expect(llmCostUsed(log.events, DAY)).toBe(600);
    // 実際に使ったトークンの分だけの failed は書ける（一部だけ課金された失敗）
    const b = await okSent(log, sub(jst(DAY, 17, 1), "beta", TD, 300));
    await ok(log, close(jst(DAY, 17, 2), b, 7, { result: "failed", outputTokens: 7 }));
    expect(llmCostUsed(log.events, DAY)).toBe(607);
  });

  // 【高・宛先 core】③のある①（課金されうる依頼）を、トークン数0・費用0の expired や collected で閉じられる。
  // 閉じた記録の費用は実費として数えるので、その日の使用済みから予約が消え、同じ日に新しい予約を書ける。
  // 費用0が本当か（取り消しで課金がなかったか）は記録からは確かめられず、上限（1日100円）が記録の上で守られていても、実際の請求が超えうる。
  // 例：600 の予約を送り、費用0の expired で閉じると、使用済みは0になり、別の AI の 1,000 の予約が通る（実際の請求は最大 1,600）。
  // 直し方の方針：③のある①は、費用0の expired・collected も断り、costUnknown（予約した費用）で閉じさせる（core が直す予定。直ったらふつうの試験に戻す）
  it.fails("【高・穴】③のある①を、トークン数0・費用0の expired で閉じることはできない（今はでき、予約が数えから消える）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    const r = await reason(log, close(jst(DAY, 17), a, 0, { result: "expired" }));
    expect(r).not.toBe("ok");
  });

  it.fails("【高・穴】③のある①を、トークン数0・費用0の collected で閉じることはできない（今はでき、予約が数えから消える）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    const r = await reason(log, close(jst(DAY, 17), a, 0));
    expect(r).not.toBe("ok");
  });

  it.fails("【高・穴】費用0で閉じて空けた枠で、同じ日に上限を超える予約を重ねられない（今は 600 を送ったあと 1,000 の予約が通る）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    await log.append(close(jst(DAY, 17), a, 0, { result: "expired" }));
    const r = await reason(log, sub(jst(DAY, 17, 1), "beta", TD, 1000));
    expect(r).not.toBe("ok");
  });

  it.fails("【高・穴】保存済みのログで、予約した費用（costUnknown）の expired を費用0の expired に書き換えると、照合で落ちる（今は通る）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    await ok(log, close(jst(TD, 8, 30), a, 600, { result: "expired", costUnknown: true }));
    const d = log.events.map(draftOf);
    const dropped = await forge([...d.slice(0, -1), { ...d.at(-1)!, payload: { batchSeq: a.seq, agentId: "alpha", result: "expired", cost: 0, inputTokens: 0, outputTokens: 0, ...PRICE } }]);
    expect(await admitAll(dropped)).not.toBeNull();
  });
});

describe("1日の上限（1,000＝100円）は①の追記で断る", () => {
  it("1つの予約で 1,000 ちょうどは通り、1,001 は断る（ほかに何もない日でも）", async () => {
    expect(LLM_DAILY_COST_LIMIT).toBe(1000);
    const log = await setup();
    expect(await reason(log, sub(jst(DAY, 16, 35), "alpha", TD, 1001))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 1000));
    expect(await reason(log, sub(jst(DAY, 16, 36), "beta", TD, 1))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    expect(llmCostProblems(log.events)).toEqual([]);
  });

  it("閉じた依頼は実費で数える。実費が予約より小さければ、その差の分だけ新しい予約が通る。大きければ、その分だけ減る", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    await ok(log, close(jst(DAY, 16, 50), a, 100));
    expect(await reason(log, sub(jst(DAY, 16, 51), "beta", TD, 901))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    const b = await okSent(log, sub(jst(DAY, 16, 51), "beta", TD, 300));
    // 実費が予約を超えた（キャッシュへの書き込みなど）。合計は 100＋800 で、残りは100
    await ok(log, close(jst(DAY, 16, 52), b, 800));
    expect(await reason(log, sub(jst(DAY, 16, 53), "gamma", TD, 101))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    await ok(log, sub(jst(DAY, 16, 53), "gamma", TD, 100));
  });

  it("実費が予約を超えてその日の合計が上限を超えたあとは、どんな予約も断り、検査は total で挙げる", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 900));
    await ok(log, close(jst(DAY, 16, 50), a, 1200));
    expect(await reason(log, sub(jst(DAY, 16, 51), "beta", TD, 1))).toBe("daily LLM cost limit exceeded (1201 > 1000)");
    expect(llmCostProblems(log.events).map((p) => p.kind)).toEqual(["total"]);
  });

  it("日をまたぐ：23:59:59.999 と 00:00:00.000 は別の日の枠。submittedAt を1時間さかのぼって前の日の枠に入れても、前の日が埋まっていれば断る", async () => {
    const log = await setup();
    await okSent(log, sub(jst(DAY, 23, 59, 59, 999), "alpha", TD, 1000));
    await okSent(log, sub(jst(TD, 0, 0), "beta", TD, 1000));
    expect(llmCostUsed(log.events, DAY)).toBe(1000);
    expect(llmCostUsed(log.events, TD)).toBe(1000);
    // 0:30 に記録し、submittedAt を前の日の 23:40 にする（取引日は同じ）。前の日は埋まっているので断る
    expect(await reason(log, sub(jst(TD, 0, 30), "gamma", TD, 1, { submittedAt: jst(DAY, 23, 40) }))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    // 記録した日（今日）の枠も埋まっている
    expect(await reason(log, sub(jst(TD, 0, 30), "gamma", TD, 1))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    // 翌日の分（取引日 11-11）は 11-10 の枠で数えるので、締めのあとでも 11-10 中は断る
    expect(await reason(log, sub(jst(TD, 16, 35), "gamma", "2026-11-11", 1))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    await okSent(log, sub(jst("2026-11-11", 0, 0), "gamma", "2026-11-11", 1000));
  });

  it("上限を超える予約は、③も閉じた記録も書けない（①がないので、その依頼は送られない）", async () => {
    const log = await setup();
    await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 1000));
    const before = log.events.length;
    expect(await reason(log, sub(jst(DAY, 16, 36), "beta", TD, 1))).toMatch(/daily LLM cost limit exceeded/);
    expect(log.events.length).toBe(before);
    expect(log.events.filter((e) => e.type === "llm.batch.submitted" && (e.payload as { agentId: string }).agentId === "beta")).toEqual([]);
  });
});

describe("判断待ち（低）", () => {
  // 【低・宛先 core】同じ提供元のバッチのIDを、別の①の③に書ける。受け取りのときに同じバッチの答えを2つの AI の答えとして使える道になる
  // （受け取った本文と①のハッシュの突き合わせは runner の責任）。core が一意キーを足すか検討中（#210 のレビュー）。直ったらふつうの試験に戻す
  it.fails("【低】同じバッチのIDを、別の AI の①の③に書くことはできない（今は書ける）", async () => {
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 100));
    const b = await ok(log, sub(jst(DAY, 16, 36), "beta", TD, 100));
    await ok(log, sent(jst(DAY, 16, 37), a, { batchId: "batch_shared" }));
    expect(await reason(log, sent(jst(DAY, 16, 38), b, { batchId: "batch_shared" }))).not.toBe("ok");
  });
});
