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

/** 保存済みのログの末尾に1件足して、連鎖を作り直す（追記の検査を通らずに保存されたもの） */
async function withLast(events: readonly LogEvent[], d: Draft): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  for (const e of [...events.map((e) => ({ type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: e.payload })), { ...d, keys: [] }]) out.push(await sealEvent(out.at(-1) ?? null, e));
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

describe("correction.issued の形", () => {
  const fix = (payload: Record<string, unknown>, refs: number[]) => op("correction.issued", jst("2026-11-10", 1), payload, refs);

  it("投稿の訂正と入力データの訂正を書ける。newBodyHash は省ける。refs のほかの seq は引用として書ける", async () => {
    const { log, src, post } = await setup();
    await ok(log, fix({ targetSeq: post, kind: "post", reason: "誤った数字", newBodyHash: HASH }, [post]));
    await ok(log, fix({ targetSeq: post, kind: "post", reason: "x".repeat(500) }, [post, src]));
    await ok(log, fix({ targetSeq: src, kind: "input", reason: "配信元の訂正", newBodyHash: HASH }, [src]));
  });

  it("形に合わない中身は、理由を返して断る", async () => {
    const { log, src, post } = await setup();
    const next = log.events.length + 1;
    const BAD: [Record<string, unknown>, number[], string][] = [
      [{ kind: "post", reason: "r" }, [post], "targetSeq must be the seq of an earlier event"],
      [{ targetSeq: "5", kind: "post", reason: "r" }, [post], "payload refers to 5 outside refs"],
      [{ targetSeq: next, kind: "input", reason: "r" }, [next], `payload refers to ${String(next)} outside refs`],
      [{ targetSeq: post, kind: "post", reason: "r" }, [], `payload refers to ${String(post)} outside refs`],
      [{ targetSeq: post, kind: "data", reason: "r" }, [post], "kind must be one of post, input"],
      [{ targetSeq: post, reason: "r" }, [post], "kind must be one of post, input"],
      [{ targetSeq: post, kind: "post" }, [post], "reason is required (up to 500 characters)"],
      [{ targetSeq: post, kind: "post", reason: "" }, [post], "reason is required (up to 500 characters)"],
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
