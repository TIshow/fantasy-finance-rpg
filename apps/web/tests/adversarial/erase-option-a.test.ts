// 検証（verifier、#179・PR #182 の 7f7406e）：本文を消す関数の案A（#179 の lead の判断 6）を、実装とは別に確かめる。
// 文書（lead の判断 6、EVENT_LOG §5.2・§6.1、PR #182 の本文）から成り立つはずのこと：
// - 本文は、003 の決まり（同じ本文の投稿がすべて本文を消す印つきで取り下げられ、ほかの記録が本文のハッシュを指していない）に合えば、必ず消える
// - 判断の出力は、確かめがすべて通ったときだけ一緒に消える。通らなければ残り、手順書（db/ops/erase_body.sql）の確かめに出続ける
// - アプリの接続（ffr_app）で足した偽の記録で、本物の判断の出力を消させられない（毎日の実行の前・途中・後のどこで足しても）
// - 出力を消す途中で例外が起きても、出力の削除だけが取り消され、本文は消える
// 欠陥の再現は、前半（通常の it）が前提を確かめて手順を進め、後半（it.fails）が結果だけを見る形にする（前提が崩れれば前半が赤になる）。
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productionSetup, runDaily, verifyDatabase } from "../../scripts/daily-lib";
import { verifyChain } from "../../src/events/chain";
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
const NEXT_DAY = "2026-11-12";
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
    const day3 = events.find((e) => e.type === "agent.run" && pl(e).agentId === id && pl(e).purpose === "order" && e.recordedAt >= jst(DAYS[2]!, 0))!;
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

describe("偽の記録を、毎日の実行の判断と注文用の run の間に足す", { timeout: 240_000 }, () => {
  // 7f7406e の post_after_order は「毎日の実行は投稿用の run と投稿を注文用の run より前に書くので、あとから足した記録は必ず当たる」とする。
  // しかし、毎日の実行がその AI の判断を受け取ってから注文用の run を書くまでの間（LLM の答えを待つ間など）に、アプリの接続で
  // 投稿用の run と投稿を足すと、どちらも注文用の run より前の seq になり、post_after_order に当たらない。
  // 入力の seq の一覧は、判断の前にある記録（終値・口座の根拠など）だけなので、判断の前から分かる
  // 毎日の実行は、足された記録を取り込んで止まらずに進み、注文用の run には本物の判断の出力を書く（下で確かめる）
  const r: { ran?: boolean; outputKept?: boolean; sheet?: string; genuineOrders?: unknown[] } = {};
  it("【欠陥・中の前提】2日目の投稿しない判断の、判断と注文用の run の間に、出力の note と同じ本文の偽の投稿を足し、運営者がそれを取り下げて消す", async () => {
    // 1回目：その AI の2日目の判断（入力の一覧と出力）を知る（規則の AI なので、同じ時計なら毎回同じ）
    const first = await threeDays();
    const id = pl(first.post).agentId as string;
    const order1 = first.events.find((e) => e.type === "agent.run" && pl(e).agentId === id && e.recordedAt >= jst(DAYS[1]!, 0) && e.recordedAt < jst(DAYS[2]!, 0))!;
    expect(pl(order1).purpose, "2日目は注文用の run だけのはず").toBe("order");
    const { values: v1 } = await openStore(first.clock);
    const output = v1.body(pl(order1).outputHash as string)!.value;
    const note = (JSON.parse(output) as { note: string }).note;
    expect(output).toContain(JSON.stringify(note));

    // 2回目：同じ世界を回し、2日目のその AI の判断のあとで、偽の記録を足す
    const w = await fresh();
    await w.run(DAYS[0]!);
    let forged: Awaited<ReturnType<typeof forgePost>> | undefined;
    const prepare: typeof productionSetup = async (ctx) =>
      (await productionSetup(ctx)).map((a): RunnerAgent =>
        a.id !== id
          ? a
          : {
              id: a.id,
              model: a.model,
              prompt: a.prompt,
              decide: async (input) => {
                const d = await a.decide(input);
                if (input.tradingDate === DAYS[1] && !forged) forged = await forgePost(w.clock, order1, note, JSON.stringify({ post: { board: "全体", text: note } }));
                return d;
              },
            },
      );
    // 毎日の実行は、注文用の run を DB に書いたあと、足された記録に気づいて止まる（"does not match the recorded event"）。回し直すと進む
    await expect(w.run(DAYS[1]!, { prepare })).rejects.toThrow("does not match the recorded event");
    await w.run(DAYS[1]!, { prepare });
    await w.run(DAYS[2]!, { prepare });
    expect(forged, "偽の記録を足せていない").toBeDefined();
    const events = await readAllEvents(db);
    const order = events.find((e) => e.type === "agent.run" && pl(e).agentId === id && pl(e).purpose === "order" && e.recordedAt >= jst(DAYS[1]!, 0) && e.recordedAt < jst(DAYS[2]!, 0))!;
    expect(pl(order).inputSeqs, "注文用の run の入力の一覧が、偽の run と同じ").toEqual(pl(forged!.run).inputSeqs);
    expect(forged!.post.seq).toBeLessThan(order.seq);
    const { values } = await openStore(w.clock);
    const genuine = values.body(pl(order).outputHash as string)!.value;
    expect(genuine, "注文用の run の出力は、本物の判断（偽の run の出力ではない）").toBe(output);
    const sheet = events.find((e) => (e.type === "order_sheet.committed" || e.type === "order_sheet.rejected") && pl(e).runSeq === order.seq);
    expect(sheet, "注文票が確定・拒否されていない").toBeDefined();
    r.sheet = sheet!.type;
    r.genuineOrders = (JSON.parse(output) as { orders: unknown[] }).orders;
    await verifyDatabase(db, holidayTable);

    await withdraw(w.clock, forged!.post.seq);
    // 確かめのどれにも当たらない（post_after_order にも当たらない）
    expect(await skip(forged!.post.seq)).toBeNull();
    expect(await listed(forged!.post.seq), "手順書の1つ目の文には、出力2件（偽の run の出力と、本物の注文用の run の出力）が出る").toEqual([[2, null]]);
    const before = await readAllEvents(db);
    expect(await erase(forged!.post.seq)).toBe(forged!.bodyHash);
    r.outputKept = await has(pl(order).outputHash as string);
    // 消えても、イベントは変わらず、連鎖と保存の検査は通る（本物の判断の出力が消えたことは、検査では分からない）
    expect(await readAllEvents(db)).toEqual(before);
    expect(await verifyChain(before)).toEqual([]);
    await verifyDatabase(db, holidayTable);
    await w.run(NEXT_DAY, { prepare });
    r.ran = true;
  });
  it.fails("【欠陥・中】上の状態で、本物の判断（注文用の run）の出力の行が全文ごと消える（直れば残る）", () => {
    expect(r.ran, "前提の試験が動いていない").toBe(true);
    expect(r.outputKept).toBe(true);
  });
  // 回し直しの判断の段（src/runner/day.ts）は、その日の最初の agent.run（ここでは偽の投稿用の run）の出力を判断として使う。
  // 偽の出力には orders がないので、本物の注文用の run（出力は空の注文）を指す注文票が、invalid_order で拒否になる
  it.fails("【欠陥・低】上の状態で、回し直しが偽の投稿用の run の出力を判断に使い、本物の注文用の run の注文票を拒否にする（直れば、注文用の run の出力で確定する）", () => {
    expect(r.ran, "前提の試験が動いていない").toBe(true);
    expect(Array.isArray(r.genuineOrders)).toBe(true);
    expect(r.sheet).toBe("order_sheet.committed");
  });
});
