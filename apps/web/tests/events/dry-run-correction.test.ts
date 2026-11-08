// 試運転の印（agent.run の dryRun）と、訂正の記録（correction.issued）の形（#179 の lead の決定、2026-11-08）。
// 試運転の日の注文の判断は、あとで試運転を切っても注文票にならない。訂正は targetSeq の1件だけを対象にする。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { sealEvent } from "../../src/events/chain";
import type { LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/index";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Order } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const H = "d".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set() };
const CTX = { holidayTables: new Map([[H, TABLE]]), accountOf: () => newAccount() };
const buy: Order[] = [{ symbol: "AAA", side: "buy", qty: 100 }];
/** 実装とは別に書いた、SHA-256 の16進の例（"abc" のハッシュ） */
const HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });
const op = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "operator:owner", refs, payload });

async function ok(log: EventLog, d: Draft) {
  const r = await log.append(d);
  if (!r.ok) throw new Error(r.reason);
  return r.event.seq;
}
const why = async (log: EventLog, d: Draft) => {
  const r = await log.append(d);
  return r.ok ? "ok" : r.reason;
};

/** 11/9（月）夜に alpha を登録し、出典と、投稿の agent.run と投稿を書いたログ */
async function setup() {
  const log = new EventLog(CTX);
  await ok(log, op("holidays.adopted", 0, { holidaysSha256: H }));
  await ok(log, op("universe.set", 0, { symbols: ["AAA"] }));
  await ok(log, op("agent.registered", jst("2026-11-09", 20), { agentId: "alpha", startDate: "2026-11-10", initialCash: INITIAL_CASH }));
  const src = await ok(log, sys("source.captured", jst("2026-11-09", 21), { publishedAt: jst("2026-11-09", 19), fetchedAt: jst("2026-11-09", 21) }));
  const postRun = await ok(log, sys("agent.run", jst("2026-11-09", 22), { agentId: "alpha", purpose: "post", inputSeqs: [src], ok: true, dryRun: true }, [src]));
  const post = await ok(log, { type: "post.published", recordedAt: jst("2026-11-09", 22, 1), actor: "agent:alpha", refs: [postRun], payload: { agentId: "alpha", board: "AAA", bodyHash: HASH, runSeq: postRun } });
  return { log, src, post };
}

const orderRun = (src: number, extra: Record<string, unknown>) => sys("agent.run", jst("2026-11-09", 23), { agentId: "alpha", purpose: "order", inputSeqs: [src], ok: true, ...extra }, [src]);

/** 保存済みのログを新しい追記の処理で読み直し、最初の問題を返す */
async function admitAll(events: readonly LogEvent[]): Promise<string | null> {
  const log = new EventLog(CTX);
  for (const e of events) {
    const p = await log.admit(e);
    if (p) return p;
  }
  return null;
}

/**
 * 保存済みのログの末尾に1件足して、連鎖を作り直す（追記の検査を通らずに保存されたもの）。
 * 一意キーは追記と同じものを付ける（バッチの答えから書いた agent.run は llmrun:<batchSeq>:<目的>）。キーの違いで落ちないように
 */
async function withLast(events: readonly LogEvent[], d: Draft): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  const keys = d.type === "agent.run" && d.payload.batchSeq !== undefined ? [`llmrun:${String(d.payload.batchSeq)}:${String(d.payload.purpose)}`] : [];
  for (const e of [...events.map((e) => ({ type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: e.payload })), { ...d, keys }]) out.push(await sealEvent(out.at(-1) ?? null, e));
  return out;
}

describe("agent.run の試運転の印（dryRun）", () => {
  it("dryRun は true だけ書ける。false やほかの値は断る（試運転でないことは、書かないことで表す）", async () => {
    const { log, src } = await setup();
    for (const v of [false, "true", 1, null, {}]) expect(await why(log, orderRun(src, { dryRun: v })), JSON.stringify(v)).toBe("dryRun must be true or left out");
    await ok(log, orderRun(src, { dryRun: true }));
  });

  it("試運転の投稿の判断からは、投稿を書ける", async () => {
    const { log, post } = await setup();
    expect(log.events[post - 1]!.type).toBe("post.published");
  });

  it("試運転の注文の判断から作った注文票は、試運転を切ってから出しても確定せず、拒否（invalid_sheet）として残る", async () => {
    const { log, src } = await setup();
    const run = await ok(log, orderRun(src, { dryRun: true }));
    // 8:30 の締めの前に、試運転を切った runner が commitSheet を呼んだとき
    const r = await log.commitSheet(jst("2026-11-10", 8), "alpha", { tradingDate: "2026-11-10", orders: buy, runSeq: run, inputSeqs: [src] });
    expect(r.ok && r.rejected).toBe("invalid_sheet");
    const last = log.events.at(-1)!;
    expect(last.type).toBe("order_sheet.rejected");
    expect(last.payload).toMatchObject({ reason: "invalid_sheet", runSeq: run, orders: buy });
    expect(log.events.some((e) => e.type === "order_sheet.committed")).toBe(false);
    // 照合でも同じ結果になる
    expect(await admitAll(log.events)).toBeNull();
  });

  it("印のない注文の判断からは、これまでどおり確定する", async () => {
    const { log, src } = await setup();
    const run = await ok(log, orderRun(src, {}));
    const r = await log.commitSheet(jst("2026-11-10", 8), "alpha", { tradingDate: "2026-11-10", orders: buy, runSeq: run, inputSeqs: [src] });
    expect(r.ok && r.event.type).toBe("order_sheet.committed");
  });

  it("保存済みのログで、試運転の判断から確定した注文票と、false の印は照合で落ちる", async () => {
    const { log, src } = await setup();
    const run = await ok(log, orderRun(src, {}));
    await log.commitSheet(jst("2026-11-10", 8), "alpha", { tradingDate: "2026-11-10", orders: buy, runSeq: run, inputSeqs: [src] });
    // 確定した注文票の元の run に、試運転の印を足して連鎖を作り直す
    const drafts = log.events.map((e) => ({ type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: e.seq === run ? { ...(e.payload as object), dryRun: true } : e.payload }));
    const out: LogEvent[] = [];
    for (const d of drafts) out.push(await sealEvent(out.at(-1) ?? null, d));
    expect(await admitAll(out)).toMatch(/order_sheet.committed/);
    const withFalse = await withLast(log.events.slice(0, run - 1), orderRun(src, { dryRun: false }));
    expect(await admitAll(withFalse)).toMatch(/dryRun must be true or left out/);
  });
});

/** 依頼（①）・送った記録（③）・閉じた記録まで書き、その答えから書く注文の agent.run の下書きを返す */
async function batchUpTo(log: EventLog, src: number, submittedExtra: Record<string, unknown>) {
  const at = jst("2026-11-09", 22, 30);
  const body = "b".repeat(64);
  const sub = await ok(log, sys("llm.batch.submitted", at, {
    agentId: "alpha", provider: "anthropic", modelId: "m", promptVersion: "v1", sentBodyHash: body, customId: `alpha-20261110-${"b".repeat(16)}`,
    maxCost: 150, tradingDate: "2026-11-10", submittedAt: at, yenPerUsd: 160, inputCentsPer10MTok: 1000, outputCentsPer10MTok: 5000,
    maxInputTokens: 50_000, maxOutputTokens: 8_000, bodyMaxOutputTokens: 8_000, ...submittedExtra,
  }));
  await ok(log, sys("llm.batch.sent", at + 60_000, { batchSeq: sub, agentId: "alpha", provider: "anthropic", batchId: "msgbatch_01" }, [sub]));
  const closed = await ok(log, sys("llm.batch.closed", jst("2026-11-10", 6, 50), { batchSeq: sub, agentId: "alpha", result: "collected", cost: 44, inputTokens: 20_000, outputTokens: 1_500, inputCentsPer10MTok: 1000, outputCentsPer10MTok: 5000 }, [sub]));
  return (extra: Record<string, unknown>) => sys("agent.run", jst("2026-11-10", 7), { agentId: "alpha", purpose: "order", inputSeqs: [src], ok: true, batchSeq: closed, sentBodyHash: body, ...extra }, [src, closed]);
}

describe("依頼の記録（llm.batch.submitted）の試運転の印", () => {
  it("依頼の dryRun も true だけ書ける", async () => {
    for (const v of [false, "true", 1, null]) {
      const { log, src } = await setup();
      await expect(batchUpTo(log, src, { dryRun: v }), JSON.stringify(v)).rejects.toThrow("dryRun must be true or left out");
    }
  });

  it("試運転の依頼から、印のない run は書けない（依頼のあとに試運転を切っても、本物の注文にならない）", async () => {
    const { log, src } = await setup();
    const runOf = await batchUpTo(log, src, { dryRun: true });
    expect(await why(log, runOf({}))).toBe("dryRun must match the batch submission");
    const run = await ok(log, runOf({ dryRun: true }));
    const r = await log.commitSheet(jst("2026-11-10", 8), "alpha", { tradingDate: "2026-11-10", orders: buy, runSeq: run, inputSeqs: [src] });
    expect(r.ok && r.rejected).toBe("invalid_sheet");
    expect(log.events.at(-1)!.type).toBe("order_sheet.rejected");
    expect(await admitAll(log.events)).toBeNull();
  });

  it("試運転でない依頼から、印のある run は書けない。印のない run は確定できる", async () => {
    const { log, src } = await setup();
    const runOf = await batchUpTo(log, src, {});
    expect(await why(log, runOf({ dryRun: true }))).toBe("dryRun must match the batch submission");
    const run = await ok(log, runOf({}));
    const r = await log.commitSheet(jst("2026-11-10", 8), "alpha", { tradingDate: "2026-11-10", orders: buy, runSeq: run, inputSeqs: [src] });
    expect(r.ok && r.event.type).toBe("order_sheet.committed");
  });

  it("保存済みのログで、依頼と run の印が食い違えば照合で落ちる", async () => {
    const { log, src } = await setup();
    const runOf = await batchUpTo(log, src, { dryRun: true });
    const good = log.events.slice();
    expect(await admitAll(await withLast(good, runOf({})))).toMatch(/agent.run.*dryRun must match the batch submission/);
    expect(await admitAll(await withLast(good, runOf({ dryRun: true })))).toBeNull();
    // 試運転でない依頼に、印のある run を足した記録も落ちる
    const real = await setup();
    const realRunOf = await batchUpTo(real.log, real.src, {});
    expect(await admitAll(await withLast(real.log.events, realRunOf({ dryRun: true })))).toMatch(/agent.run.*dryRun must match the batch submission/);
  });
});

describe("correction.issued の形", () => {
  const fix = (payload: Record<string, unknown>, refs: number[]) => op("correction.issued", jst("2026-11-10", 16), payload, refs);

  it("投稿の訂正と入力データの訂正を書ける。newBodyHash は省ける。refs のほかの seq は引用として書ける", async () => {
    const { log, src, post } = await setup();
    const open = await ok(log, sys("prices.open", jst("2026-11-10", 9), { date: "2026-11-10" }));
    await ok(log, fix({ targetSeq: post, kind: "post", reason: "誤った数字", newBodyHash: HASH }, [post]));
    await ok(log, fix({ targetSeq: post, kind: "post", reason: "x".repeat(500) }, [post, src]));
    await ok(log, fix({ targetSeq: open, kind: "input", reason: "配信元の訂正", newBodyHash: HASH }, [open]));
    await ok(log, fix({ targetSeq: open, kind: "input", reason: "値の訂正" }, [open, post, src]));
  });

  it("入力データの訂正の対象は、始値・終値・分割と配当の公表だけ（EVENT_LOG §6.2）", async () => {
    const { log, src, post } = await setup();
    const close = await ok(log, sys("prices.close", jst("2026-11-10", 15, 40), { date: "2026-11-10" }));
    const announced = await ok(log, sys("corporate_action.announced", jst("2026-11-10", 15, 41), { symbol: "AAA", kind: "dividend", exDate: "2026-11-12", announcedAt: jst("2026-11-10", 15), perShare: 100 }));
    await ok(log, fix({ targetSeq: close, kind: "input", reason: "r" }, [close]));
    await ok(log, fix({ targetSeq: announced, kind: "input", reason: "r" }, [announced]));
    const want = "targetSeq of an input correction must be one of prices.open, prices.close, corporate_action.announced";
    for (const t of [src, post, 1, 3]) expect(await why(log, fix({ targetSeq: t, kind: "input", reason: "r" }, [t])), String(t)).toBe(want);
  });

  it("形に合わない中身は、理由を返して断る", async () => {
    const { log, src, post } = await setup();
    const next = log.events.length + 1;
    const BAD: [Record<string, unknown>, number[], string][] = [
      [{ kind: "post", reason: "r" }, [post], "targetSeq must be the seq of an earlier event"],
      [{ targetSeq: "5", kind: "post", reason: "r" }, [post], "payload refers to 5 outside refs"],
      [{ targetSeq: next, kind: "post", reason: "r" }, [next], `payload refers to ${String(next)} outside refs`],
      [{ targetSeq: post, kind: "post", reason: "r" }, [], `payload refers to ${String(post)} outside refs`],
      [{ targetSeq: post, kind: "data", reason: "r" }, [post], "kind must be one of post, input"],
      [{ targetSeq: post, reason: "r" }, [post], "kind must be one of post, input"],
      [{ targetSeq: post, kind: "post" }, [post], "reason is required (up to 500 characters)"],
      [{ targetSeq: post, kind: "post", reason: "" }, [post], "reason is required (up to 500 characters)"],
      [{ targetSeq: post, kind: "post", reason: " \n\t\u3000" }, [post], "reason is required (up to 500 characters)"],
      [{ targetSeq: post, kind: "post", reason: "x".repeat(501) }, [post], "reason is required (up to 500 characters)"],
      [{ targetSeq: post, kind: "post", reason: "r", newBodyHash: "h5" }, [post], "newBodyHash must be a SHA-256 hex digest"],
      [{ targetSeq: post, kind: "post", reason: "r", newBodyHash: HASH.toUpperCase() }, [post], "newBodyHash must be a SHA-256 hex digest"],
      [{ targetSeq: post, kind: "post", reason: "r", newBodyHash: null }, [post], "newBodyHash must be a SHA-256 hex digest"],
      [{ targetSeq: src, kind: "post", reason: "r" }, [src], "targetSeq of a post correction must be a post.published"],
      [{ targetSeq: post, kind: "post", reason: "r", refSeq: post }, [post], "unknown field in a correction"],
      [{ targetSeq: post, kind: "post", reason: "r", bodyHash: HASH }, [post], "unknown field in a correction"],
    ];
    const before = log.events.length;
    for (const [payload, refs, want] of BAD) expect(await why(log, fix(payload, refs)), JSON.stringify(payload)).toBe(want);
    expect(log.events).toHaveLength(before);
  });

  it("運営者のほかは書けない", async () => {
    const { log, post } = await setup();
    expect(await why(log, { ...fix({ targetSeq: post, kind: "post", reason: "r" }, [post]), actor: "system" })).toBe("correction.issued must be written by operator");
  });

  it("保存済みのログでも、形に合わない訂正は照合で落ちる", async () => {
    const { log, post } = await setup();
    const bad = await withLast(log.events, fix({ refSeq: post, kind: "post", newBodyHash: HASH }, [post]));
    expect(await admitAll(bad)).toMatch(/correction.issued.*unknown field in a correction/);
    const good = await withLast(log.events, fix({ targetSeq: post, kind: "post", reason: "r", newBodyHash: HASH }, [post]));
    expect(await admitAll(good)).toBeNull();
  });
});
