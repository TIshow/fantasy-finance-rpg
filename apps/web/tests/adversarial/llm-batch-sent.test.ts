// 検証役（#179、PR #210）：送る前に予約を記録する形（2026-11-08 の lead の決定）を壊しにいく。
// ① llm.batch.submitted（送る前の予約。バッチのIDなし。1日の上限をここで確かめる）→ ② 送る → ③ llm.batch.sent（①を指し、バッチのIDを足す）→ llm.batch.closed。
// 期待は lead の決定から書く。欠陥の再現は it.fails（直ったら、ふつうの試験に戻す）。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { sealEvent } from "../../src/events/chain";
import { LLM_DAILY_COST_LIMIT, llmCostProblems, llmCostUsed, llmReservationOf, llmSentOf, llmTicketOf } from "../../src/events/llm-cost";
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

/** 上限のトークン数1・1でも予約が1で済む、ごく安い料金（maxCost 1 の予約に使う。2962eda で上限のトークン数は1以上） */
const CHEAP = { inputCentsPer10MTok: 1, outputCentsPer10MTok: 1 };
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
const sent = (at: number, s: LogEvent, extra: Record<string, unknown> = {}): Draft => ({
  type: "llm.batch.sent",
  recordedAt: at,
  actor: "system",
  refs: [s.seq],
  payload: { batchSeq: s.seq, agentId: (s.payload as { agentId: string }).agentId, provider: (s.payload as { provider: string }).provider, batchId: `batch_${s.seq}`, ...extra },
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
    expect(await reason(log, sent(jst(DAY, 16, 37), a))).toMatch(new RegExp(`duplicate key llmsent:${a.seq}\\b`));
    expect(await reason(log, sent(jst(DAY, 16, 37), a, { batchId: "batch_other" }))).toMatch(new RegExp(`duplicate key llmsent:${a.seq}$`));
    const forged = await forge([...log.events.map(draftOf), { ...draftOf(log.events.at(-1)!), recordedAt: jst(DAY, 16, 37), keys: [], payload: { batchSeq: a.seq, agentId: "alpha", provider: "anthropic", batchId: "batch_other" } }]);
    expect(await admitAll(forged)).toMatch(new RegExp(`duplicate key llmsent:${a.seq}$`));
    // 控えは最初の③から作る
    expect((llmSentOf(log.events, a.seq)!.payload as { batchId: string }).batchId).toBe(`batch_${a.seq}`);
  });

  it("閉じたあとの①には③を書けない（費用0・予約した費用のどちらで閉じても）。並べ替えた保存済みのログも照合で落ちる", async () => {
    for (const [cost, extra] of [[0, { result: "failed", notCreatedError: "rate_limited" }], [100, { result: "failed", costUnknown: true }]] as const) {
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
  it("答えを受け取っていない閉じ方（failed・expired）は費用0にできない（トークン数0でも、料金を0にしても）。予約した費用（costUnknown）か、トークン数から出した実費なら閉じられる", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    const zero = "a sent batch that was not collected cannot cost 0";
    for (const result of ["failed", "expired"]) {
      expect(await reason(log, close(jst(DAY, 17), a, 0, { result })), result).toBe(zero);
      expect(await reason(log, close(jst(DAY, 17), a, 0, { result, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 })), result).toBe(zero);
      expect(await reason(log, close(jst(DAY, 17), a, 0, { result, inputCentsPer10MTok: 0, outputCentsPer10MTok: 0 })), result).not.toBe("ok");
    }
    await ok(log, close(jst(DAY, 17), a, 600, { result: "failed", costUnknown: true }));
    expect(llmCostUsed(log.events, DAY)).toBe(600);
    // 実際に使ったトークンの分だけの failed は書ける（一部だけ課金された失敗）
    const b = await okSent(log, sub(jst(DAY, 17, 1), "beta", TD, 300));
    await ok(log, close(jst(DAY, 17, 2), b, 7, { result: "failed", outputTokens: 7 }));
    expect(llmCostUsed(log.events, DAY)).toBe(607);
  });

  // 前の【高・穴】（③のある①を費用0の expired・collected で閉じて、予約を数えから消せる）は 1ce37a0 で直った
  it("③のある①を、トークン数0・費用0の expired で閉じることはできない（1ce37a0 で直った）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    expect(await reason(log, close(jst(DAY, 17), a, 0, { result: "expired" }))).toBe("a sent batch that was not collected cannot cost 0");
  });

  it("③のある①を、トークン数0・費用0の collected で閉じることはできない（1ce37a0 で直った）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    expect(await reason(log, close(jst(DAY, 17), a, 0))).toBe("a collected batch must have output tokens");
    // 入力だけあって出力0の受け取りも断る
    expect(await reason(log, close(jst(DAY, 17), a, 5, { inputTokens: 5, outputTokens: 0 }))).toBe("a collected batch must have output tokens");
  });

  it("費用0で閉じて枠をあけ、同じ日に上限を超える予約を重ねることはできない（1ce37a0 で直った）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    expect(await reason(log, close(jst(DAY, 17), a, 0, { result: "expired" }))).not.toBe("ok");
    expect(await reason(log, sub(jst(DAY, 17, 1), "beta", TD, 1000))).toBe("daily LLM cost limit exceeded (1600 > 1000)");
  });

  it("保存済みのログで、予約した費用（costUnknown）の expired を費用0の expired に書き換えると、照合で落ちる（1ce37a0 で直った）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    await ok(log, close(jst(TD, 8, 30), a, 600, { result: "expired", costUnknown: true }));
    const d = log.events.map(draftOf);
    const dropped = await forge([...d.slice(0, -1), { ...d.at(-1)!, payload: { batchSeq: a.seq, agentId: "alpha", result: "expired", cost: 0, inputTokens: 0, outputTokens: 0, ...PRICE } }]);
    expect(await admitAll(dropped)).toMatch(/a sent batch that was not collected cannot cost 0/);
  });

  // 前の【中・穴】の一部（入力0の受け取り）は 2962eda で直った。キャッシュの読み出しだけ・書き込みだけの入力は数える
  it("入力0の collected は断る。キャッシュの読み出し・書き込みだけでも入力として数える（2962eda で直った）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    const want = "a collected batch must have input tokens";
    expect(await reason(log, close(jst(DAY, 17), a, 1, { inputTokens: 0, outputTokens: 1 }))).toBe(want);
    expect(await reason(log, close(jst(DAY, 17), a, 1, { inputTokens: 0, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }))).toBe(want);
    // cacheReadInputTokens だけで入力を満たす（キャッシュの読み出しは入力と同じ単価）
    await ok(log, close(jst(DAY, 17), a, 2, { inputTokens: 0, outputTokens: 1, cacheReadInputTokens: 1 }));
  });

  // 前の【中・穴】（ごく小さな費用で閉じて予約の枠をあける）は、lead の決定3で、許す動きと決まった：提供元が実際の費用を返したら、
  // その費用（0.1円単位に切り上げ、0より大きければ最低0.1円）で記録する。分からないときだけ予約した費用で数える。
  // トークン数が本当かは、提供元の請求でしか確かめられない（記録からは見分けられない）
  it("③のある①を、入力1・出力1トークン（費用2）の collected で閉じられ、実際の費用だけが数えに残る（lead の決定3）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    await ok(log, close(jst(DAY, 17), a, 2, { inputTokens: 1, outputTokens: 1 }));
    expect(llmCostUsed(log.events, DAY)).toBe(2);
    // トークン数から出した費用と合わない費用は断る（切り上げの外へは書けない）
    const b = await okSent(log, sub(jst(DAY, 17, 1), "beta", TD, 300));
    expect(await reason(log, close(jst(DAY, 17, 2), b, 1, { inputTokens: 1, outputTokens: 1 }))).not.toBe("ok");
  });

  it("費用1で閉じたあとは、その分だけ枠があき、同じ日に 999 の予約が通る（lead の決定3。1,000 ちょうどまで）", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    await ok(log, close(jst(DAY, 17), a, 1, { result: "expired", inputTokens: 0, outputTokens: 1 }));
    expect(await reason(log, sub(jst(DAY, 17, 1), "beta", TD, 1000))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    await ok(log, sub(jst(DAY, 17, 1), "beta", TD, 999));
    expect(llmCostUsed(log.events, DAY)).toBe(1000);
  });

  it("0.1円に満たない実際の費用は、切り上げて 0.1円（1）で記録する。0 や切り捨ては断る", async () => {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 600, CHEAP));
    for (const cost of [0, 2]) expect(await reason(log, close(jst(DAY, 17), a, cost, { inputTokens: 1, outputTokens: 1, ...CHEAP })), String(cost)).not.toBe("ok");
    await ok(log, close(jst(DAY, 17), a, 1, { inputTokens: 1, outputTokens: 1, ...CHEAP }));
  });
});

describe("③のない①を費用0で閉じるときの、送れなかった理由（notCreatedError）", () => {
  it("費用0で閉じるときは必須で、timeout・rate_limited・provider_error のどれか", async () => {
    for (const e of ["timeout", "rate_limited", "provider_error"]) {
      const log = await setup();
      const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
      await ok(log, close(jst(DAY, 16, 36), a, 0, { result: "failed", notCreatedError: e }));
      expect(llmCostUsed(log.events, DAY)).toBe(0);
    }
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    expect(await reason(log, close(jst(DAY, 16, 36), a, 0, { result: "failed" }))).toBe("notCreatedError is required exactly when a batch that was not sent closes with cost 0");
    for (const e of ["invalid_output", "TIMEOUT", "", null, 0, true, ["timeout"]]) {
      expect(await reason(log, close(jst(DAY, 16, 36), a, 0, { result: "failed", notCreatedError: e })), JSON.stringify(e)).toBe("notCreatedError must be timeout, rate_limited or provider_error");
    }
  });

  it("ほかの閉じ方（予約した費用で閉じる・③のある①）には書けない", async () => {
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    const only = "notCreatedError is required exactly when a batch that was not sent closes with cost 0";
    expect(await reason(log, close(jst(DAY, 16, 36), a, 600, { result: "failed", costUnknown: true, notCreatedError: "timeout" }))).toBe(only);
    const b = await okSent(log, sub(jst(DAY, 16, 37), "beta", TD, 300));
    expect(await reason(log, close(jst(DAY, 16, 38), b, 0, { result: "failed", notCreatedError: "timeout" }))).toBe(only);
    expect(await reason(log, close(jst(DAY, 16, 38), b, 300, { result: "failed", costUnknown: true, notCreatedError: "timeout" }))).toBe(only);
    expect(await reason(log, close(jst(DAY, 16, 38), b, 7, { result: "failed", outputTokens: 7, notCreatedError: "provider_error" }))).toBe(only);
    expect(await reason(log, close(jst(DAY, 16, 38), b, 7, { outputTokens: 7, notCreatedError: "timeout" }))).toBe(only);
    // 照合でも同じ：③のある①の予約した費用の閉じ方に notCreatedError を足して連鎖を作り直すと落ちる
    await ok(log, close(jst(DAY, 16, 38), b, 300, { result: "failed", costUnknown: true }));
    const d = log.events.map(draftOf);
    const forged = await forge([...d.slice(0, -1), { ...d.at(-1)!, payload: { ...d.at(-1)!.payload, notCreatedError: "timeout" } }]);
    expect(await admitAll(forged)).toMatch(/notCreatedError is required exactly/);
  });

  it("③のない①を費用0で閉じたあとは、③を書けず、同じ取引日にもう一度予約することもできない（その日は送れない）", async () => {
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 600));
    await ok(log, close(jst(DAY, 16, 36), a, 0, { result: "failed", notCreatedError: "rate_limited" }));
    expect(await reason(log, sent(jst(DAY, 16, 37), a))).toBe("the batch is already closed");
    expect(await reason(log, sub(jst(DAY, 16, 38), "alpha", TD, 600, { customId: "retry" }))).toMatch(/duplicate key llmbatch:alpha:2026-11-10$/);
  });
});

describe("①の customId と bodyMaxOutputTokens", () => {
  it("customId の末尾は「-」＋sentBodyHash の先頭16文字。合わない・15文字・17文字・大文字・区切りなしは断る", async () => {
    const log = await setup();
    const at = jst(DAY, 16, 35);
    const h = BODY.slice(0, 16);
    const want = "customId must end with - and the first 16 characters of sentBodyHash";
    const other = "a".repeat(64);
    for (const id of [`alpha-${h.slice(0, 15)}`, `alpha-${h}b`, `alpha${h}`, `alpha-${h.toUpperCase()}`, `alpha_${h}`, `alpha-${other.slice(0, 16)}`, h]) {
      const d = sub(at, "alpha", TD, 100);
      expect(await reason(log, { ...d, payload: { ...d.payload, customId: id } }), id).toBe(want);
    }
    // 本文のハッシュを変えたのに customId を前の本文のまま
    const d = sub(at, "alpha", TD, 100);
    expect(await reason(log, { ...d, payload: { ...d.payload, sentBodyHash: other } })).toBe(want);
    // 「-」＋16文字だけ（前の部分が空）は通る。名前に agentId や取引日を入れるかは、記録の検査では縛らない
    await ok(log, { ...d, payload: { ...d.payload, customId: `-${h}` } });
  });

  it("customId は64文字まで。末尾の17文字を除いた部分は47文字まで", async () => {
    const log = await setup();
    const at = jst(DAY, 16, 35);
    const h = BODY.slice(0, 16);
    const d = sub(at, "alpha", TD, 100);
    expect(await reason(log, { ...d, payload: { ...d.payload, customId: `${"x".repeat(48)}-${h}` } })).toBe("customId must match ^[A-Za-z0-9_-]{1,64}$");
    await ok(log, { ...d, payload: { ...d.payload, customId: `${"x".repeat(47)}-${h}` } });
  });

  it("bodyMaxOutputTokens は1以上・maxOutputTokens 以下の整数（ちょうどは通り、1超えは断る）", async () => {
    const log = await setup();
    const at = jst(DAY, 16, 35);
    const want = "bodyMaxOutputTokens must be a positive integer up to maxOutputTokens";
    const base = { maxOutputTokens: 500 };
    for (const v of [501, 0, -1, 1.5, "1", null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      const d = sub(at, "alpha", TD, 1000, { ...base, bodyMaxOutputTokens: v });
      if (v === undefined) delete d.payload.bodyMaxOutputTokens;
      expect(await reason(log, d), String(v)).toBe(want);
    }
    // 出力の上限が0なら、どんな本文の上限も書けない（出力のない依頼は予約できない）
    expect(await reason(log, sub(at, "alpha", TD, 1000, { maxOutputTokens: 0, bodyMaxOutputTokens: 1 }))).toBe("prices and max token counts must be at least 1");
    await ok(log, sub(at, "alpha", TD, 1000, { ...base, bodyMaxOutputTokens: 500 }));
  });
});

describe("1日の上限（1,000＝100円）は①の追記で断る", () => {
  it("1つの予約で 1,000 ちょうどは通り、1,001 は断る（ほかに何もない日でも）", async () => {
    expect(LLM_DAILY_COST_LIMIT).toBe(1000);
    const log = await setup();
    expect(await reason(log, sub(jst(DAY, 16, 35), "alpha", TD, 1001))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 1000));
    expect(await reason(log, sub(jst(DAY, 16, 36), "beta", TD, 1, CHEAP))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
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
    expect(await reason(log, sub(jst(DAY, 16, 51), "beta", TD, 1, CHEAP))).toBe("daily LLM cost limit exceeded (1201 > 1000)");
    // 出力のトークン数（1,199）が本文の出力の上限（1）を超えているので、output_tokens も挙がる
    expect(llmCostProblems(log.events).map((p) => p.kind)).toEqual(["total", "output_tokens"]);
  });

  it("日をまたぐ：23:59:59.999 と 00:00:00.000 は別の日の枠。submittedAt を1時間さかのぼって前の日の枠に入れても、前の日が埋まっていれば断る", async () => {
    const log = await setup();
    await okSent(log, sub(jst(DAY, 23, 59, 59, 999), "alpha", TD, 1000));
    await okSent(log, sub(jst(TD, 0, 0), "beta", TD, 1000));
    expect(llmCostUsed(log.events, DAY)).toBe(1000);
    expect(llmCostUsed(log.events, TD)).toBe(1000);
    // 0:30 に記録し、submittedAt を前の日の 23:40 にする（取引日は同じ）。前の日は埋まっているので断る
    expect(await reason(log, sub(jst(TD, 0, 30), "gamma", TD, 1, { ...CHEAP, submittedAt: jst(DAY, 23, 40) }))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    // 記録した日（今日）の枠も埋まっている
    expect(await reason(log, sub(jst(TD, 0, 30), "gamma", TD, 1, CHEAP))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    // 翌日の分（取引日 11-11）は 11-10 の枠で数えるので、締めのあとでも 11-10 中は断る
    expect(await reason(log, sub(jst(TD, 16, 35), "gamma", "2026-11-11", 1, CHEAP))).toBe("daily LLM cost limit exceeded (1001 > 1000)");
    await okSent(log, sub(jst("2026-11-11", 0, 0), "gamma", "2026-11-11", 1000));
  });

  it("上限を超える予約は、③も閉じた記録も書けない（①がないので、その依頼は送られない）", async () => {
    const log = await setup();
    await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 1000));
    const before = log.events.length;
    expect(await reason(log, sub(jst(DAY, 16, 36), "beta", TD, 1, CHEAP))).toMatch(/daily LLM cost limit exceeded/);
    expect(log.events.length).toBe(before);
    expect(log.events.filter((e) => e.type === "llm.batch.submitted" && (e.payload as { agentId: string }).agentId === "beta")).toEqual([]);
  });
});

describe("③の provider と、同じバッチのID（llmbatchid:<provider>:<batchId>）", () => {
  it("③の provider は①と同じでなければ断る（違う・欠けている・大文字小文字だけ違う）", async () => {
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 100));
    const want = "provider must equal the batch submission";
    for (const provider of ["openai", "Anthropic", "anthropic ", "", null, undefined]) {
      const d = sent(jst(DAY, 16, 36), a, { provider });
      if (provider === undefined) delete d.payload.provider;
      expect(await reason(log, d), String(provider)).toBe(want);
    }
    await ok(log, sent(jst(DAY, 16, 36), a));
  });

  // 前の【低・穴】（同じバッチのIDを別の①の③に書ける）は 1ce37a0 で直った
  it("同じ提供元の同じバッチのIDを、別の AI の①の③に書くことはできない（1ce37a0 で直った）。保存済みのログでも照合で落ちる", async () => {
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 100));
    const b = await ok(log, sub(jst(DAY, 16, 36), "beta", TD, 100));
    await ok(log, sent(jst(DAY, 16, 37), a, { batchId: "batch_shared" }));
    expect(await reason(log, sent(jst(DAY, 16, 38), b, { batchId: "batch_shared" }))).toMatch(/duplicate key llmbatchid:anthropic:batch_shared$/);
    // キーを付けずに足した保存済みのログ
    const forged = await forge([...log.events.map(draftOf), { ...draftOf(log.events.at(-1)!), recordedAt: jst(DAY, 16, 38), refs: [b.seq], keys: [], payload: { batchSeq: b.seq, agentId: "beta", provider: "anthropic", batchId: "batch_shared" } }]);
    expect(await admitAll(forged)).toMatch(/duplicate key llmbatchid:anthropic:batch_shared$/);
  });

  it("提供元が違えば、同じバッチのIDでも書ける（IDは提供元ごと）", async () => {
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 100));
    const b = await ok(log, sub(jst(DAY, 16, 36), "beta", TD, 100, { provider: "openai" }));
    await ok(log, sent(jst(DAY, 16, 37), a, { batchId: "batch_shared" }));
    await ok(log, sent(jst(DAY, 16, 38), b, { batchId: "batch_shared" }));
  });

  // 【低・宛先 core】①の provider は100文字までの自由な文字列で、決まった名前（anthropic・openai・gemini）と突き合わせない。
  // そのため、①の provider を "anthropic" と "Anthropic" のように書き分ければ、同じ提供元の同じバッチのIDを2つの①の③に書ける（一意キーが別になる）。
  // runner が書く値なので、今の流れでは起きない。直し方の方針：①の provider を決まった名前の一覧に限る
  it.fails("【低・穴】①の provider の書き方を変えても、同じバッチのIDを2つの①の③に書くことはできない（今は書ける）", async () => {
    const log = await setup();
    const a = await ok(log, sub(jst(DAY, 16, 35), "alpha", TD, 100));
    const b = await ok(log, sub(jst(DAY, 16, 36), "beta", TD, 100, { provider: "Anthropic" }));
    await ok(log, sent(jst(DAY, 16, 37), a, { batchId: "batch_shared" }));
    expect(await reason(log, sent(jst(DAY, 16, 38), b, { batchId: "batch_shared" }))).not.toBe("ok");
  });
});

describe("受け取った答えのトークン数が予約の上限を超えたとき（llmCostProblems の input_tokens・output_tokens。2962eda）", () => {
  /** 入力の上限100・本文の出力の上限50（予約の見積もりの出力の上限は60）の①を書き、③も書く */
  async function reserved() {
    const log = await setup();
    const a = await okSent(log, sub(jst(DAY, 16, 35), "alpha", TD, 200, { maxInputTokens: 100, maxOutputTokens: 60, bodyMaxOutputTokens: 50 }));
    return { log, a };
  }
  const kinds = (log: EventLog) => llmCostProblems(log.events).map((p) => `${p.kind}:${p.used}/${p.limit}`);

  it("上限ちょうどは挙げず、1超えは挙げる。閉じる記録そのものは断らない", async () => {
    const { log, a } = await reserved();
    await ok(log, close(jst(DAY, 17), a, 150, { inputTokens: 100, outputTokens: 50 }));
    expect(kinds(log)).toEqual([]);
    const { log: log2, a: a2 } = await reserved();
    const c = await ok(log2, close(jst(DAY, 17), a2, 152, { inputTokens: 101, outputTokens: 51 }));
    expect(llmCostProblems(log2.events)).toEqual([
      { day: DAY, kind: "input_tokens", seq: c.seq, used: 101, limit: 100 },
      { day: DAY, kind: "output_tokens", seq: c.seq, used: 51, limit: 50 },
    ]);
  });

  it("出力の上限は、予約の見積もりの maxOutputTokens（60）ではなく、本文に書いた bodyMaxOutputTokens（50）で比べる", async () => {
    const { log, a } = await reserved();
    await ok(log, close(jst(DAY, 17), a, 61, { inputTokens: 1, outputTokens: 60 }));
    expect(kinds(log)).toEqual(["output_tokens:60/50"]);
  });

  it("入力は、キャッシュへの書き込み・読み出しを足して比べる（それぞれは上限以内でも、合計で超えれば挙げる）", async () => {
    const { log, a } = await reserved();
    const usage = { inputTokens: 40, outputTokens: 1, cacheCreationInputTokens: 40, cacheReadInputTokens: 21 };
    const cost = 1 + 40 + 40 * 2 + 21; // キャッシュへの書き込みは入力の2倍（この料金では1トークン＝1）
    expect(await reason(log, close(jst(DAY, 17), a, cost, usage))).toBe("ok");
    expect(kinds(log)).toEqual(["input_tokens:101/100"]);
  });

  // 【低・宛先 core】トークン数の上限を確かめるのは collected だけ。打ち切り（expired）や失敗（failed）で一部だけ課金されたときに、
  // トークン数が予約の上限を超えていても挙がらない（費用が予約を超えれば total では挙がるが、トークン数の設定の誤りとしては見えない）。
  // 直し方の方針：トークン数のある閉じた記録は、結果によらず同じように比べる
  it.fails("【低・穴】expired で、トークン数が予約の上限を超えていれば挙げる（今は collected だけ）", async () => {
    const { log, a } = await reserved();
    await ok(log, close(jst(DAY, 17), a, 152, { result: "expired", inputTokens: 101, outputTokens: 51 }));
    expect(kinds(log)).toEqual(["input_tokens:101/100", "output_tokens:51/50"]);
  });

  it("保存済みのログでトークン数を上限の外に書き換えるなら、費用も合わせないと照合で落ちる。合わせれば照合は通るが、検査が挙げる", async () => {
    const { log, a } = await reserved();
    await ok(log, close(jst(DAY, 17), a, 150, { inputTokens: 100, outputTokens: 50 }));
    const d = log.events.map(draftOf);
    const last = d.at(-1)!;
    const bad = await forge([...d.slice(0, -1), { ...last, payload: { ...last.payload, outputTokens: 500 } }]);
    expect(await admitAll(bad)).toMatch(/cost must be 600/);
    const both = await forge([...d.slice(0, -1), { ...last, payload: { ...last.payload, outputTokens: 500, cost: 600 } }]);
    expect(await admitAll(both)).toBeNull();
    expect(llmCostProblems(both).map((p) => p.kind)).toEqual(["output_tokens"]);
  });
});

describe("予約の控えの reservedAt と、契約どおりに作った customId（2962eda）", () => {
  it("reservedAt は①を書いた時刻（recordedAt）で、submittedAt（依頼を決めた時刻）ではない", async () => {
    const log = await setup();
    // 17:30 に記録し、16:40 に決めた依頼（11/10 の受け付けは 11/9 の引け 16:30 から。#228）
    const at = jst(DAY, 17, 30);
    const a = await ok(log, sub(at, "alpha", TD, 100, { submittedAt: at - 3_000_000 }));
    expect(llmReservationOf(a)).toMatchObject({ reservedAt: at, submittedAt: at - 3_000_000, sentBodyHash: BODY });
    const s = await ok(log, sent(at + 1, a));
    expect(llmTicketOf(a, s)).toMatchObject({ reservedAt: at, batchId: `batch_${a.seq}` });
  });

  /** 契約（LlmPreparedBatch.customId）の作り方を、文から書き写したもの：前半「agentId-YYYYMMDD」を47文字まで（長ければ agentId を切り詰める）＋「-」＋ハッシュの先頭16文字 */
  const contractCustomId = (agentId: string, tradingDate: string, hash: string) => {
    const date = tradingDate.replaceAll("-", "");
    const id = agentId.slice(0, 47 - 1 - date.length);
    return `${id}-${date}-${hash.slice(0, 16)}`;
  };

  it("長い agentId（100文字）でも、切り詰めた customId は64文字ちょうどで記録の検査を通る", async () => {
    const long = `a${"x".repeat(99)}`;
    const log = await setup([long]);
    const id = contractCustomId(long, TD, BODY);
    expect(id).toHaveLength(64);
    const d = sub(jst(DAY, 16, 35), long, TD, 100);
    await ok(log, { ...d, payload: { ...d.payload, customId: id } });
    // 切り詰めずに作ると64文字を超えて断られる
    const naive = `${long}-${TD.replaceAll("-", "")}-${BODY.slice(0, 16)}`;
    const d2 = sub(jst(DAY, 16, 36), long, "2026-11-10", 100);
    expect(await reason(log, { ...d2, payload: { ...d2.payload, customId: naive } })).toBe("customId must match ^[A-Za-z0-9_-]{1,64}$");
  });

  // 記録の検査は customId の前半の形（agentId-YYYYMMDD）を確かめない。先頭の38文字が同じ長い agentId を持つ2体が、同じ本文のハッシュで頼むと、
  // customId がまったく同じになる。契約の find は「時刻の範囲で、その名前の候補がちょうど1つ」のときだけ found とし、2つなら not_found にして
  // 予約した費用のまま閉じる（安全側）ので、費用の数え漏れにはならない。今の動きを書き留める
  it("先頭38文字が同じ長い agentId の2体は、同じ本文なら customId が同じになるが、記録はどちらも受け入れる（find が安全側で扱う）", async () => {
    const one = `a${"x".repeat(40)}1`;
    const two = `a${"x".repeat(40)}2`;
    const log = await setup([one, two]);
    const id1 = contractCustomId(one, TD, BODY);
    const id2 = contractCustomId(two, TD, BODY);
    expect(id1).toBe(id2);
    const d1 = sub(jst(DAY, 16, 35), one, TD, 100);
    const d2 = sub(jst(DAY, 16, 36), two, TD, 100);
    await ok(log, { ...d1, payload: { ...d1.payload, customId: id1 } });
    await ok(log, { ...d2, payload: { ...d2.payload, customId: id2 } });
  });
});
