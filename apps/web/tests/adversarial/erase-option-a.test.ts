// 検証（verifier、#179・PR #182 の 7f7406e と deed733）：本文を消す関数の案A（#179 の lead の判断 6）を、実装とは別に確かめる。
// 文書（lead の判断 6、EVENT_LOG §5.2・§6.1、PR #182 の本文）から成り立つはずのこと：
// - 本文は、003 の決まり（同じ本文の投稿がすべて本文を消す印つきで取り下げられ、ほかの記録が本文のハッシュを指していない）に合えば、必ず消える
// - 判断の出力は、確かめがすべて通ったときだけ一緒に消える。通らなければ残り、手順書（db/ops/erase_body.sql）の確かめに出続ける
// - アプリの接続（ffr_app）で足した偽の記録で、本物の判断の出力を消させられない（毎日の実行の前・途中・後のどこで足しても）
// - 出力を消す途中で例外が起きても、出力の削除だけが取り消され、本文は消える
// 欠陥の再現は、前半（通常の it）が前提を確かめて手順を進め、後半（it.fails）が結果だけを見る形にする（前提が崩れれば前半が赤になる）。
import { decisionOpensAt, marketClosedDays } from "../../src/ledger/ledger";
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productionSetup, runDaily, verifyDatabase } from "../../scripts/daily-lib";
import type { LogEvent } from "../../src/events/types";
import { holidayTable } from "../../src/holidays";
import type { RunnerAgent } from "../../src/runner/day";
import { readSnapshot } from "../../src/store/pg-reader";
import { PgEventStore, readAllEvents } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate, type SqlDb } from "../../src/store/sql";
import { FakeClock, jst } from "../contracts/fakes";
import { openPglite, resetSchema } from "../store/pglite";

let pg: PGlite;
let db: SqlDb;
beforeAll(async () => {
  ({ pg, db } = await openPglite());
  await pg.exec("CREATE ROLE ffr_app");
}, 60_000);
afterAll(() => db.close());

const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11"];
/** 取引日 d の判断の受け付けの始まり（前の取引日の引け 16:30。#228）。d の判断の記録は、この時刻から d の締めまでにある（前は d の 0:00 から探していた） */
const opensOf = (d: string) => decisionOpensAt(d, marketClosedDays(new Set()));
const holidayTables = new Map([[holidayTable.contentSha256, holidayTable]]);
const pl = (e: LogEvent) => e.payload as Record<string, unknown>;
const has = async (hash: string) => (await db.query("SELECT 1 FROM stored_values WHERE hash = $1 AND kind = 'body'", [hash])).rows.length === 1;
const erase = async (seq: number) => (await db.query<{ h: string | null }>("SELECT erase_withdrawn_body($1) AS h", [seq])).rows[0]!.h;
const skip = async (seq: number) => (await db.query<{ p: string | null }>("SELECT withdrawn_post_skip(current_schema(), $1) AS p", [seq])).rows[0]!.p;
const opsStatements = () =>
  readFileSync(new URL("../../db/ops/erase_body.sql", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("--"))
    .join("\n")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
type Listed = { seq: number; outputs_to_erase: number; outputs_kept_because: string | null };
const listed = async (seq: number) => (await db.query<Listed>(opsStatements()[0]!)).rows.filter((r) => Number(r.seq) === seq).map((r) => [Number(r.outputs_to_erase), r.outputs_kept_because]);
const discrepancies = async (seq: number) => (await db.query<{ seq: number; problem: string }>(opsStatements()[1]!)).rows.filter((r) => Number(r.seq) === seq).map((r) => r.problem);

async function asApp<T>(fn: () => Promise<T>): Promise<T> {
  await pg.exec("SET ROLE ffr_app");
  try {
    return await fn();
  } finally {
    await pg.exec("RESET ROLE");
  }
}

function world() {
  const clock = new FakeClock(jst(DAYS[0]!, 7));
  const waitUntil = async (at: number) => void (at > clock.now() && clock.set(at));
  const run = (d: string, over: Partial<Parameters<typeof runDaily>[1]> = {}) => runDaily(d, { db, clock, prepare: productionSetup, holidayTable, waitUntil, ...over });
  return { clock, run };
}
const openStore = async (clock: FakeClock) => {
  const values = await PgValueStore.open(db);
  return { values, store: await PgEventStore.open(db, { values, holidayTables, clock }) };
};
async function fresh() {
  await resetSchema(pg);
  await migrate(db);
  return world();
}
async function threeDays() {
  const w = await fresh();
  for (const d of DAYS) await w.run(d);
  const events = await readAllEvents(db);
  const post = events.find((e) => e.type === "post.published");
  expect(post, "投稿がない（試験の前提が崩れた）").toBeDefined();
  return { ...w, events, post: post! };
}
async function withdraw(clock: FakeClock, target: number, reason = "権利者からの申し出") {
  const { store } = await openStore(clock);
  const r = await store.append({ type: "content.withdrawn", actor: "operator:owner", refs: [target], payload: { targetSeq: target, reason, bodyErased: true } });
  if (!r.ok) throw new Error(r.reason);
  return r.event.seq;
}
const decisionRuns = (events: readonly LogEvent[], run: LogEvent) => events.filter((e) => e.type === "agent.run" && pl(e).agentId === pl(run).agentId && JSON.stringify(pl(e).inputSeqs) === JSON.stringify(pl(run).inputSeqs));

/** アプリの接続で、判断 order と同じ AI・同じ入力の一覧の投稿用の run（出力は outputText）と、本文 body の投稿を足す */
async function forgePost(clock: FakeClock, order: LogEvent, body: string, outputText: string) {
  return asApp(async () => {
    const { values, store } = await openStore(clock);
    const outputHash = await values.putBody(outputText);
    const run = await store.append({ type: "agent.run", actor: "system", refs: order.refs, payload: { ...pl(order), purpose: "post", outputHash, startedAt: clock.now(), finishedAt: clock.now() } } as never);
    if (!run.ok) throw new Error(`agent.run: ${run.reason}`);
    const agentId = pl(order).agentId as string;
    const bodyHash = await values.putBody(body);
    const post = await store.append({ type: "post.published", actor: `agent:${agentId}`, refs: [run.event.seq], payload: { agentId, board: "全体", bodyHash, citeSeqs: [], runSeq: run.event.seq } } as never);
    if (!post.ok) throw new Error(`post.published: ${post.reason}`);
    return { run: run.event, post: post.event, bodyHash };
  });
}

describe("本文はいつも消え、出力を残すときは手順書に出る", { timeout: 180_000 }, () => {
  it("確かめが通るふつうの投稿：1つ目の文に出力2件が出て、消したあと2つ目の文は空。本文と出力の両方が消える", async () => {
    const { clock, events, post } = await threeDays();
    const runs = decisionRuns(events, events.find((e) => e.seq === pl(post).runSeq)!);
    await withdraw(clock, post.seq);
    expect(await listed(post.seq)).toEqual([[2, null]]);
    expect(await erase(post.seq)).toBe(pl(post).bodyHash);
    for (const r of runs) expect(await has(pl(r).outputHash as string)).toBe(false);
    expect(await discrepancies(post.seq)).toEqual([]);
    expect(await listed(post.seq)).toEqual([]);
  });

  it("同じ AI の別の日の判断の出力に同じ文があるとき（text_outside_decision）：本文は消え、出力は残り、2つ目の文に出る", async () => {
    const { clock, events, post } = await threeDays();
    const id = pl(post).agentId as string;
    const runs = decisionRuns(events, events.find((e) => e.seq === pl(post).runSeq)!);
    const { values } = await openStore(clock);
    const text = values.body(pl(post).bodyHash as string)!.value;
    // アプリの接続で、別の日（3日目）の判断に、同じ文を含む投稿用の run を足す（偽の投稿は足さない）
    const day3 = events.find((e) => e.type === "agent.run" && pl(e).agentId === id && pl(e).purpose === "order" && e.recordedAt >= opensOf(DAYS[2]!))!;
    await asApp(async () => {
      const { values: v, store } = await openStore(clock);
      const outputHash = await v.putBody(JSON.stringify({ post: { text } }));
      const r = await store.append({ type: "agent.run", actor: "system", refs: day3.refs, payload: { ...pl(day3), purpose: "post", outputHash } } as never);
      if (!r.ok) throw new Error(r.reason);
    });
    await withdraw(clock, post.seq);
    expect(await listed(post.seq)).toEqual([[0, "text_outside_decision"]]);
    expect(await erase(post.seq)).toBe(pl(post).bodyHash);
    for (const r of runs) expect(await has(pl(r).outputHash as string)).toBe(true);
    expect(await discrepancies(post.seq)).toEqual(["output_unverifiable"]);
  });

  it("出力のハッシュをアプリの接続で別の記録に書かれたとき（output_not_erasable）：本文は消え、出力は残り、2つ目の文に出る", async () => {
    const { clock, events, post } = await threeDays();
    const runs = decisionRuns(events, events.find((e) => e.seq === pl(post).runSeq)!);
    const order = runs.find((e) => pl(e).purpose === "order")!;
    // 運営者を名乗る、本文を残す取り下げの理由に、注文用の run の出力のハッシュを書く（アプリの接続でも書ける）
    await asApp(async () => {
      const { store } = await openStore(clock);
      const r = await store.append({ type: "content.withdrawn", actor: "operator:owner", refs: [post.seq], payload: { targetSeq: post.seq, reason: `x ${pl(order).outputHash as string}`, bodyErased: false } });
      if (!r.ok) throw new Error(r.reason);
    });
    await withdraw(clock, post.seq);
    expect(await listed(post.seq)).toEqual([[0, "output_not_erasable"]]);
    expect(await erase(post.seq)).toBe(pl(post).bodyHash);
    for (const r of runs) expect(await has(pl(r).outputHash as string)).toBe(true);
    expect(await discrepancies(post.seq)).toEqual(["output_unverifiable"]);
  });

  it("出力を消す途中で削除の見張りが断っても（元の run の出力だけを断る見張りに差し替え）、出力の削除は全部取り消され、本文は消える", async () => {
    const { clock, events, post } = await threeDays();
    const postRun = events.find((e) => e.seq === pl(post).runSeq)!;
    const runs = decisionRuns(events, postRun);
    const source = pl(postRun).outputHash as string;
    await withdraw(clock, post.seq);
    expect(await skip(post.seq)).toBeNull();
    // 関数は元の run の出力を最後に消すので、注文用の run の出力を消したあとで断られる。
    // 見張りを、元の run の出力だけを断り、ほかは 004 と同じ判定をするものに差し替える（試験の DB だけ。次の試験で作り直す）
    await db.exec(`
      CREATE OR REPLACE FUNCTION stored_values_guard_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
      DECLARE ok boolean := false;
      BEGIN
        IF OLD.hash = '${source}' THEN
          RAISE EXCEPTION 'test: refuse the source output' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF current_setting('ffr.erase_body', true) IS NOT DISTINCT FROM OLD.hash AND OLD.kind = 'body' THEN
          EXECUTE format('SELECT %1$I.stored_values_erasable($1, $2) OR %1$I.stored_values_output_erasable($1, $2)', TG_TABLE_SCHEMA) INTO ok USING TG_TABLE_SCHEMA, OLD.hash;
        END IF;
        IF NOT ok THEN
          RAISE EXCEPTION 'stored_values is append-only' USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN OLD;
      END $f$;`);
    const before = await readAllEvents(db);
    expect(await erase(post.seq)).toBe(pl(post).bodyHash);
    expect(await has(pl(post).bodyHash as string)).toBe(false);
    // 先に消した注文用の run の出力も戻っている（出力の削除だけが取り消される）
    for (const r of runs) expect(await has(pl(r).outputHash as string), `run ${r.seq}`).toBe(true);
    expect(await discrepancies(post.seq)).toEqual(["output_unverifiable"]);
    expect(await readAllEvents(db)).toEqual(before);
    await verifyDatabase(db, holidayTable);
  });

  it("出力を消す途中で、見張りが別の種類の例外（raise_exception）を出しても、本文は消える", async () => {
    const { clock, events, post } = await threeDays();
    const runs = decisionRuns(events, events.find((e) => e.seq === pl(post).runSeq)!);
    await withdraw(clock, post.seq);
    await db.exec(`
      CREATE OR REPLACE FUNCTION stored_values_guard_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
      BEGIN
        IF OLD.hash <> '${pl(post).bodyHash as string}' THEN
          RAISE EXCEPTION 'test: refuse every output';
        END IF;
        RETURN OLD;
      END $f$;`);
    expect(await erase(post.seq)).toBe(pl(post).bodyHash);
    for (const r of runs) expect(await has(pl(r).outputHash as string)).toBe(true);
  });
});

describe("本文を消せない道（003 の決まり）", { timeout: 120_000 }, () => {
  // 案A は「本文は必ず消す」が、003 の決まり（ほかの記録が本文のハッシュを指していれば消さない）は残っている（PR #182 の platform の報告の「決めきれなかったこと」）。
  // アプリの接続は、運営者を名乗る記録を書けるので、本文のハッシュを書いた記録を1件足すだけで、その本文を二度と消せなくする
  it("（いまの決まり）アプリの接続で、運営者を名乗る取り下げの理由に本文のハッシュを書くと、その本文は運営者が取り下げても二度と消せない", async () => {
    const { clock, post } = await threeDays();
    const h = pl(post).bodyHash as string;
    await asApp(async () => {
      const { store } = await openStore(clock);
      const r = await store.append({ type: "content.withdrawn", actor: "operator:owner", refs: [post.seq], payload: { targetSeq: post.seq, reason: `参考 ${h}`, bodyErased: false } });
      expect(r.ok, "書けなければ、この道は閉じている").toBe(true);
    });
    await withdraw(clock, post.seq);
    await expect(erase(post.seq)).rejects.toThrow("may not be erased");
    expect(await has(h)).toBe(true);
    // 手順書の2つ目の文には not_erased として出る（気づける）
    expect(await discrepancies(post.seq)).toContain("not_erased");
    const snap = await readSnapshot(db, { warn: () => undefined });
    expect(snap.bodyOf(h)).toBeDefined();
  });
});


// --- deed733（not_daily_run と、回し直しが判断の記録どうしを比べること）の確かめ ---

/** DB に直接、記録を1件足す（アプリの検査を通らない。連鎖のハッシュは偽物だが、消す関数は連鎖を見ない） */
async function insertRaw(type: string, actor: string, payload: unknown) {
  const last = (await db.query<{ seq: string; hash: string; recorded_at: string }>("SELECT seq, hash, recorded_at FROM events ORDER BY seq DESC LIMIT 1")).rows[0]!;
  const seq = Number(last.seq) + 1;
  await db.query("INSERT INTO events (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) VALUES ($1, 1, $2, $3, $4, '[]'::jsonb, '[]'::jsonb, $5::jsonb, $6, $7)", [seq, type, Number(last.recorded_at), actor, JSON.stringify(payload), last.hash, seq.toString(16).padStart(64, "e")]);
  return seq;
}
const putBody = async (text: string) => (await PgValueStore.open(db)).putBody(text);
const out = (text: string, post: { board: string; text: string } | null) => JSON.stringify({ note: text, orders: [], post });

/**
 * DB に直接、投稿用の run（出力 postOut）→ 投稿（本文 body・掲示板 board）→ 注文用の run（出力 orderOut。null なら行のないハッシュ）→ 注文票 → 本文を消す取り下げ、を続けて書く。
 * 書き手は毎日の実行と同じ（system・agent:ai-hold）を名乗る。入力の一覧は、ほかの判断と重ならないもの
 */
async function rawDecision(o: { postOut: string; body: string; board?: string; orderOut: string | null; inputSeqs?: number[] }) {
  const agentId = "ai-hold";
  const inputSeqs = o.inputSeqs ?? [1, 2, 3];
  const a = await putBody(o.postOut);
  const run = await insertRaw("agent.run", "system", { agentId, purpose: "post", inputSeqs, outputHash: a, ok: true });
  const bodyHash = await putBody(o.body);
  const post = await insertRaw("post.published", `agent:${agentId}`, { agentId, board: o.board ?? "全体", bodyHash, citeSeqs: [], runSeq: run });
  const b = o.orderOut === null ? "0".repeat(64) : await putBody(o.orderOut);
  const order = await insertRaw("agent.run", "system", { agentId, purpose: "order", inputSeqs, outputHash: b, ok: true });
  await insertRaw("order_sheet.committed", `agent:${agentId}`, { agentId, tradingDate: DAYS[2], orders: [], runSeq: order, inputSeqs });
  await insertRaw("content.withdrawn", "operator:owner", { targetSeq: post, reason: "申し出", bodyErased: true });
  return { post, bodyHash, postOutput: a, orderOutput: b };
}

describe("偽の記録を、毎日の実行の判断と注文用の run の間に足す（deed733 の後）", { timeout: 240_000 }, () => {
  // 7f7406e では、毎日の実行がその AI の判断を受け取ってから注文用の run を書くまでの間（LLM の答えを待つ間など）に、
  // アプリの接続で投稿用の run と投稿を足すと、本物の注文用の run の出力を消させられた（中）。回し直しは偽の出力を判断に使った（低）。
  it("【中・低は直った】判断と注文用の run の間に、出力の違う偽の投稿用の run と投稿を足すと、回し直しは止まり、偽の出力で注文票を拒否にしない", async () => {
    // 1回目：その AI の2日目の判断（入力の一覧と出力）を知る（規則の AI なので、同じ時計なら毎回同じ）
    const first = await threeDays();
    const id = pl(first.post).agentId as string;
    const order1 = first.events.find((e) => e.type === "agent.run" && pl(e).agentId === id && e.recordedAt >= opensOf(DAYS[1]!) && e.recordedAt < opensOf(DAYS[2]!))!;
    expect(pl(order1).purpose, "2日目は注文用の run だけのはず").toBe("order");
    const { values: v1 } = await openStore(first.clock);
    const note = (JSON.parse(v1.body(pl(order1).outputHash as string)!.value) as { note: string }).note;

    // 2回目：同じ世界を回し、2日目のその AI の判断のあとで、偽の記録を足す
    const w = await fresh();
    await w.run(DAYS[0]!);
    let forged: Awaited<ReturnType<typeof forgePost>> | undefined;
    const prepare: typeof productionSetup = async (ctx) =>
      (await productionSetup(ctx)).map((a): RunnerAgent =>
        a.id !== id
          ? a
          : {
              ...a,
              decide: async (input) => {
                const d = await a.decide(input);
                if (input.tradingDate === DAYS[1] && !forged) forged = await forgePost(w.clock, order1, note, JSON.stringify({ post: { board: "全体", text: note } }));
                return d;
              },
            },
      );
    await expect(w.run(DAYS[1]!, { prepare })).rejects.toThrow("does not match the recorded event");
    expect(forged, "偽の記録を足せていない").toBeDefined();
    // 回し直しは、偽の投稿用の run と本物の注文用の run の出力が違うので止まる（何度回しても止まる）
    await expect(w.run(DAYS[1]!, { prepare })).rejects.toThrow(/run \d+ does not match the decision of run \d+ \(output or inputs differ/);
    await expect(w.run(DAYS[1]!, { prepare })).rejects.toThrow("does not match the decision of run");
    const events = await readAllEvents(db);
    const order = events.find((e) => e.type === "agent.run" && pl(e).agentId === id && pl(e).purpose === "order" && e.recordedAt >= opensOf(DAYS[1]!))!;
    expect(order.seq).toBe(forged!.post.seq + 1);
    // 偽の出力で注文票が拒否（invalid_order）にならない。注文票はまだない（運営者が偽の記録を調べるまで、その日は止まる）
    expect(events.filter((e) => e.type.startsWith("order_sheet.") && pl(e).runSeq === order.seq)).toEqual([]);
    // 毎日の実行の止まり方：判断の段の例外なので、その AI よりあとの AI もその日は判断しない（安全な側。偽の記録を足せるのはアプリの接続を持つ者だけ）
    const later = events.filter((e) => e.type === "agent.run" && e.seq > order.seq);
    expect(later).toEqual([]);
    await verifyDatabase(db, holidayTable);
  });

  it("【中は直った】DB に直接、偽の投稿用の run → 偽の投稿 → 本物の注文用の run → 注文票 を作ると、not_daily_run で、本文は消え、本物の注文用の出力は残る", async () => {
    const body = "偽の投稿の本文（中）";
    const genuine = out(body, null); // 投稿しない判断の、本物の注文用の出力（note に同じ文がある）
    for (const [name, postOut] of [
      ["偽の出力が本物と全文で同じ（post が null）", genuine],
      ["偽の出力に post を足した", out(body, { board: "全体", text: body })],
    ] as const) {
      await fresh();
      await w0();
      const d = await rawDecision({ postOut, body, orderOut: genuine });
      expect(await skip(d.post), name).toBe("not_daily_run");
      expect(await listed(d.post), name).toEqual([[0, "not_daily_run"]]);
      expect(await erase(d.post), name).toBe(d.bodyHash);
      expect(await has(d.bodyHash), name).toBe(false);
      expect(await has(d.orderOutput), `${name}：本物の注文用の出力`).toBe(true);
      expect(await has(d.postOutput), name).toBe(true);
      expect(await discrepancies(d.post), name).toEqual(["output_unverifiable"]);
    }
  });

  it("（対照）同じ並びで、2つの出力の全文が同じで post の本文と掲示板が投稿と同じなら、書き手を名乗るだけで毎日の実行の形として消える（書き手の一致は守りではなく、出力の全文が守り）", async () => {
    await fresh();
    await w0();
    const body = "対照の本文";
    const both = out(body, { board: "全体", text: body });
    const d = await rawDecision({ postOut: both, body, orderOut: both });
    expect(await skip(d.post)).toBeNull();
    expect(await erase(d.post)).toBe(d.bodyHash);
    expect([await has(d.postOutput), await has(d.orderOutput)]).toEqual([false, false]);
    // 掲示板だけ違えば当たる
    await fresh();
    await w0();
    const e = await rawDecision({ postOut: both, body, board: "LPO1", orderOut: both });
    expect(await skip(e.post)).toBe("not_daily_run");
  });

  it("「注文用の run の出力の行がない」ときは全文を比べないが、それで消えるのは偽の判断の行だけで、本物の判断の出力は残る", async () => {
    const { clock, events } = await threeDays();
    const genuineOutputs = events.filter((e) => e.type === "agent.run" && pl(e).agentId === "ai-hold").map((e) => pl(e).outputHash as string);
    const { values } = await openStore(clock);
    // 本物の1日目の投稿の本文を使う（本物の判断の出力にも同じ文がある）
    const firstPost = events.find((e) => e.type === "post.published")!;
    const body = values.body(pl(firstPost).bodyHash as string)!.value;
    const board = pl(firstPost).board as string;
    const d = await rawDecision({ postOut: out(body, { board, text: body }), body, board, orderOut: null });
    // 偽の本文は本物と同じ文なので、003 の決まりで、本物の投稿も取り下げないと本文を消せない。別の判断の出力に同じ文があるので text_outside_decision
    expect(await skip(d.post)).toBe("text_outside_decision");
    // 本物と重ならない文なら、全文を比べずに通り、偽の行だけが消える
    const e = await rawDecision({ postOut: out("重ならない文", { board, text: "重ならない文" }), body: "重ならない文", board, orderOut: null, inputSeqs: [4, 5, 6] });
    expect(await skip(e.post)).toBeNull();
    expect(await erase(e.post)).toBe(e.bodyHash);
    expect(await has(e.postOutput)).toBe(false);
    for (const h of genuineOutputs) expect(await has(h), h).toBe(true);
    // 注文用の run が、ほかの判断の本物の出力のハッシュを指すと、その行は2つの判断に指されるので消せない
    const genuineOrder = events.find((x) => x.type === "agent.run" && pl(x).agentId === "ai-hold" && pl(x).purpose === "order" && x.recordedAt >= opensOf(DAYS[1]!))!;
    const a = await putBody(out("三つ目", { board, text: "三つ目" }));
    const run = await insertRaw("agent.run", "system", { agentId: "ai-hold", purpose: "post", inputSeqs: [7], outputHash: a, ok: true });
    const bodyHash = await putBody("三つ目");
    const post = await insertRaw("post.published", "agent:ai-hold", { agentId: "ai-hold", board, bodyHash, citeSeqs: [], runSeq: run });
    const order = await insertRaw("agent.run", "system", { agentId: "ai-hold", purpose: "order", inputSeqs: [7], outputHash: pl(genuineOrder).outputHash, ok: true });
    await insertRaw("order_sheet.committed", "agent:ai-hold", { agentId: "ai-hold", tradingDate: DAYS[2], orders: [], runSeq: order, inputSeqs: [7] });
    await insertRaw("content.withdrawn", "operator:owner", { targetSeq: post, reason: "申し出", bodyErased: true });
    expect(await skip(post)).toBe("not_daily_run"); // 出力が違うので全文の比較で当たる
    await erase(post);
    expect(await has(pl(genuineOrder).outputHash as string)).toBe(true);
  });

  for (const [name, crashOn] of [
    ["投稿を書く前", "post.published"],
    ["注文用の run を書く前", "agent.run:order"],
  ] as const) {
    it(`毎日の実行が${name}に落ちて回し直した日でも、本物の投稿を消せば、判断の出力2件も消える（not_daily_run に当たらない）`, async () => {
      const w = await fresh();
      let crashed = false;
      const prepare: typeof productionSetup = async (ctx) => {
        const agents = await productionSetup(ctx);
        const append = ctx.store.append.bind(ctx.store);
        ctx.store.append = async (d) => {
          const kind = d.type === "agent.run" ? `agent.run:${String((d.payload as Record<string, unknown>).purpose)}` : d.type;
          if (!crashed && kind === crashOn && (d.payload as Record<string, unknown>).agentId === "ai-hold" && (crashOn !== "agent.run:order" || (await readAllEvents(db)).some((e) => e.type === "post.published"))) {
            crashed = true;
            throw new Error("test: crash");
          }
          return append(d);
        };
        return agents;
      };
      await expect(w.run(DAYS[0]!, { prepare })).rejects.toThrow("test: crash");
      await w.run(DAYS[0]!, { prepare });
      const events = await readAllEvents(db);
      const post = events.find((e) => e.type === "post.published")!;
      const runs = decisionRuns(events, events.find((e) => e.seq === pl(post).runSeq)!);
      expect(runs.map((r) => r.seq)).toEqual([post.seq - 1, post.seq + 1]);
      await withdraw(w.clock, post.seq);
      expect(await skip(post.seq)).toBeNull();
      expect(await erase(post.seq)).toBe(pl(post).bodyHash);
      for (const r of runs) expect(await has(pl(r).outputHash as string)).toBe(false);
    });
  }
});

/** 1日目だけ回す（DB に直接書く試験の土台。投稿の本文のハッシュと重ならない世界） */
async function w0() {
  const clock = new FakeClock(jst(DAYS[0]!, 7));
  const waitUntil = async (at: number) => void (at > clock.now() && clock.set(at));
  await runDaily(DAYS[0]!, { db, clock, prepare: productionSetup, holidayTable, waitUntil });
}

describe("not_daily_run の穴", { timeout: 300_000 }, () => {
  // 投稿の停止は、毎日の実行に投稿を書かせない。not_daily_run は「投稿の時点で停止されていない」を見るが、
  // アプリの接続は運営者を名乗る記録（agent.resumed）も書ける。停止中の AI の判断に投稿があるとき、判断を受け取ってから
  // 注文用の run を書くまでの間に、運営者を名乗る停止の解除・本物と全文で同じ出力の投稿用の run・その post の本文の投稿を足すと、
  // 毎日の実行の形にそろい、運営者がその投稿を取り下げて本文を消すと、本物の注文用の run の出力も消える。
  // 全文を当てるには、出力を前もって知る必要がある（いまの規則の AI は決まった入力で毎回同じ出力。LLM では難しい）
  const r: { ran?: boolean; outputKept?: boolean } = {};
  const id = "ai-hold"; // 1日目に投稿する AI
  const withSuspension = (hook?: (input: { tradingDate: string }) => Promise<void>): typeof productionSetup => {
    let suspended = false;
    return async (ctx) => {
      const agents = await productionSetup(ctx);
      if (!suspended) {
        suspended = true;
        const s = await ctx.store.append({ type: "agent.suspended", actor: "operator:owner", refs: [], payload: { agentId: id, scope: "posts", reason: "停止" } });
        if (!s.ok) throw new Error(s.reason);
      }
      return agents.map((a): RunnerAgent => (a.id !== id || !hook ? a : { ...a, decide: async (input) => (await hook(input), a.decide(input)) }));
    };
  };
  it("【欠陥・低の前提】投稿の停止中の AI の判断の間に、運営者を名乗る停止の解除と、本物と全文で同じ出力の投稿用の run・投稿を足し、運営者がその投稿を取り下げて消す", async () => {
    // 1回目：停止中の1日目の判断の出力（post つき）を知る
    const a = await fresh();
    await a.run(DAYS[0]!, { prepare: withSuspension() });
    const ev1 = await readAllEvents(db);
    expect(ev1.filter((e) => e.type === "post.published"), "停止中なので投稿はない").toEqual([]);
    const order1 = ev1.find((e) => e.type === "agent.run" && pl(e).agentId === id)!;
    expect(pl(order1).purpose).toBe("order");
    const { values: v1 } = await openStore(a.clock);
    const text = v1.body(pl(order1).outputHash as string)!.value;
    const post = (JSON.parse(text) as { post: { board: string; text: string } | null }).post;
    expect(post, "判断には投稿がある（停止で書かれなかった）").not.toBeNull();

    // 2回目：同じ世界で、判断の間に偽の記録を足す
    const w = await fresh();
    let forged: { run: LogEvent; post: LogEvent; bodyHash: string } | undefined;
    const prepare = withSuspension(async (input) => {
      if (input.tradingDate !== DAYS[0] || forged) return;
      forged = await asApp(async () => {
        const { values, store } = await openStore(w.clock);
        const resumed = await store.append({ type: "agent.resumed", actor: "operator:owner", refs: [], payload: { agentId: id, scope: "posts", reason: "解除" } });
        if (!resumed.ok) throw new Error(resumed.reason);
        const run = await store.append({ type: "agent.run", actor: "system", refs: order1.refs, payload: { ...pl(order1), purpose: "post", outputHash: await values.putBody(text) } } as never);
        if (!run.ok) throw new Error(run.reason);
        const bodyHash = await values.putBody(post!.text);
        const p = await store.append({ type: "post.published", actor: `agent:${id}`, refs: [run.event.seq], payload: { agentId: id, board: post!.board, bodyHash, citeSeqs: [], runSeq: run.event.seq } } as never);
        if (!p.ok) throw new Error(p.reason);
        return { run: run.event, post: p.event, bodyHash };
      });
    });
    await expect(w.run(DAYS[0]!, { prepare })).rejects.toThrow("does not match the recorded event");
    await w.run(DAYS[0]!, { prepare });
    expect(forged, "偽の記録を足せていない").toBeDefined();
    const events = await readAllEvents(db);
    const order = events.find((e) => e.type === "agent.run" && pl(e).agentId === id && pl(e).purpose === "order")!;
    expect([forged!.run.seq + 1, forged!.post.seq + 1]).toEqual([forged!.post.seq, order.seq]);
    const { values } = await openStore(w.clock);
    expect(values.body(pl(order).outputHash as string)!.value, "注文用の run の出力は本物の判断").toBe(text);
    expect(events.some((e) => e.type === "order_sheet.committed" && pl(e).runSeq === order.seq)).toBe(true);
    await verifyDatabase(db, holidayTable);

    await withdraw(w.clock, forged!.post.seq);
    expect(await skip(forged!.post.seq), "確かめのどれにも当たらない").toBeNull();
    expect(await erase(forged!.post.seq)).toBe(forged!.bodyHash);
    r.outputKept = await has(pl(order).outputHash as string);
    await verifyDatabase(db, holidayTable);
    r.ran = true;
  });
  it.fails("【欠陥・低】上の状態で、本物の判断（注文用の run）の出力の行が全文ごと消える（直れば残る）", () => {
    expect(r.ran, "前提の試験が動いていない").toBe(true);
    expect(r.outputKept).toBe(true);
  });

  // 毎日の実行（src/runner/day.ts の suspended）とアプリの検査（src/events/append.ts の isSuspended）は、全員の停止（agentId "*"）も見る。
  // deed733 の not_daily_run は "*" を見なかった（5ab0f3b で直った）
  it("全員の投稿の停止（agentId \"*\"）の間に DB に直接書いた投稿は、毎日の実行が書かないものなので、not_daily_run に当たる", async () => {
    await fresh();
    await w0();
    await insertRaw("agent.suspended", "operator:owner", { agentId: "*", scope: "posts", reason: "全員の停止" });
    const body = "全員の停止中の本文";
    const both = out(body, { board: "全体", text: body });
    const d = await rawDecision({ postOut: both, body, orderOut: both });
    expect(await skip(d.post)).toBe("not_daily_run");
  });
});
