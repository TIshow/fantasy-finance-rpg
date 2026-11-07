// 検証（verifier、#179・PR #182）：本文を消すとき、AI の判断の出力（agent.run の outputHash が指す、ログの外の行）に残る同じ文も消す
// DB の関数（db/004_erase_outputs.sql の erase_withdrawn_body・erase_withdrawn_outputs と、削除の見張り）を、実装とは別に確かめる。
// 文書（EVENT_LOG §5.2・§6.1、#29・#157 の lead の指示、PR #182 の本文）から成り立つはずのこと：
// - 消えるのは、運営者が本文を消す印つきで取り下げた投稿を出した判断の出力だけ。表示中の投稿の判断の出力と本文は消えない
// - アプリの接続（ffr_app）で足せる記録（agent.run・post.published など、検査を通るもの）を細工しても、本物の判断の出力や、
//   表示中の投稿の本文を消させられない
// - 削除の見張り（トリガ）は、関数と同じ範囲だけを通す
// - その日の注文票が確定する前には消さない（毎日の実行の回し直しが止まるため）
// - 消したあとも、イベントは変わらず、ハッシュの連鎖と保存の検査（verifyDatabase）が通り、毎日の実行を続けられる
// 欠陥の再現は、前半（通常の it）が前提を確かめて手順を進め、後半（it.fails）が結果だけを見る形にする（前提が崩れれば前半が赤になる）。
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productionSetup, runDaily, verifyDatabase } from "../../scripts/daily-lib";
import { canonicalize } from "../../src/events/canonical";
import { verifyChain } from "../../src/events/chain";
import type { LogEvent } from "../../src/events/types";
import { holidayTable } from "../../src/holidays";
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
  // migrate の前に作っておくと、migrate が本番と同じ権限（events・stored_values に SELECT と INSERT だけ）を与える
  await pg.exec("CREATE ROLE ffr_app");
}, 60_000);
afterAll(() => db.close());

const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11"];
const NEXT_DAY = "2026-11-12";
const holidayTables = new Map([[holidayTable.contentSha256, holidayTable]]);
const pl = (e: LogEvent) => e.payload as Record<string, unknown>;
const has = async (hash: string) => (await db.query("SELECT 1 FROM stored_values WHERE hash = $1 AND kind = 'body'", [hash])).rows.length === 1;
const erase = async (seq: number) => (await db.query<{ h: string | null }>("SELECT erase_withdrawn_body($1) AS h", [seq])).rows[0]!.h;
const eraseOutputs = async (seq: number) => (await db.query<{ h: string }>("SELECT erase_withdrawn_outputs($1) AS h", [seq])).rows.map((r) => r.h);
const problem = async (seq: number) => (await db.query<{ p: string | null }>("SELECT withdrawn_post_problem(current_schema(), $1) AS p", [seq])).rows[0]!.p;
const attempt = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await fn();
  } catch {
    return undefined;
  }
};

/** ffr_app に切り替えて fn を動かし、必ず戻す */
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
  return { clock, waitUntil, run };
}
const openStore = async (clock: FakeClock) => {
  const values = await PgValueStore.open(db);
  return { values, store: await PgEventStore.open(db, { values, holidayTables, clock }) };
};

/** 本番の準備のまま3営業日を回す。規則の AI のうち、投稿するのは1日目の1体だけ（ほかの判断は投稿しない） */
async function threeDays() {
  await resetSchema(pg);
  await migrate(db);
  const w = world();
  for (const d of DAYS) await w.run(d);
  const events = await readAllEvents(db);
  const post = events.find((e) => e.type === "post.published");
  expect(post, "投稿がない（試験の前提が崩れた）").toBeDefined();
  return { ...w, events, post: post! };
}

/** 運営者として、本文を消す印つきで取り下げる */
async function withdraw(clock: FakeClock, target: number) {
  const { store } = await openStore(clock);
  const r = await store.append({ type: "content.withdrawn", actor: "operator:owner", refs: [target], payload: { targetSeq: target, reason: "権利者からの申し出", bodyErased: true } });
  if (!r.ok) throw new Error(r.reason);
  return r.event.seq;
}

/** 同じ判断（同じ AI・同じ入力の一覧）の agent.run */
const decisionRuns = (events: readonly LogEvent[], run: LogEvent) => events.filter((e) => e.type === "agent.run" && pl(e).agentId === pl(run).agentId && JSON.stringify(pl(e).inputSeqs) === JSON.stringify(pl(run).inputSeqs));

/**
 * アプリの接続（ffr_app）で、判断 order（注文用の run）に投稿用の run と投稿を足す。どちらも検査を通る記録で、ハッシュの連鎖も正しい。
 * run の出力は outputText、投稿の本文は body。outputHash を渡せば、新しい行を作らずにそのハッシュを出力に書く
 */
async function forgePost(clock: FakeClock, order: LogEvent, body: string, opts: { outputText?: string; outputHash?: string } = {}) {
  return asApp(async () => {
    const { values, store } = await openStore(clock);
    const outputHash = opts.outputHash ?? (await values.putBody(opts.outputText ?? body));
    const run = await store.append({ type: "agent.run", actor: "system", refs: order.refs, payload: { ...pl(order), purpose: "post", outputHash, startedAt: clock.now(), finishedAt: clock.now() } } as never);
    if (!run.ok) throw new Error(`agent.run: ${run.reason}`);
    const agentId = pl(order).agentId as string;
    const bodyHash = await values.putBody(body);
    const post = await store.append({ type: "post.published", actor: `agent:${agentId}`, refs: [run.event.seq], payload: { agentId, board: "全体", bodyHash, citeSeqs: [], runSeq: run.event.seq } } as never);
    if (!post.ok) throw new Error(`post.published: ${post.reason}`);
    return { run: run.event, post: post.event, bodyHash };
  });
}

describe("投稿しない判断に、アプリの接続で投稿用の run と偽の投稿を足す（PR #182 の「残る限界」）", { timeout: 120_000 }, () => {
  // 毎日の実行では、投稿しない判断（規則の AI のほとんどの日）は注文用の run しか持たない。agent.run は書き手が system で、
  // アプリの接続でも足せる。投稿用の run を足し、その出力の JSON の文字列と同じ本文の投稿を足すと、確かめを通る。
  // つまり「投稿のない投稿用の run」は、ふつうはできなくても、アプリの接続でいつでも作れる（PR #182 の本文の想定より広い）
  const r: { ran?: boolean; outputKept?: boolean; outputHash?: string } = {};
  it("【欠陥・高の前提】2日目の投稿しない判断に、出力の note と同じ本文の偽の投稿を足し、運営者がそれを取り下げて本文を消す", async () => {
    const { clock, events, post } = await threeDays();
    const agentId = pl(post).agentId as string;
    // 投稿した AI の2日目の判断（投稿しない日。出力の note に日付が入るので、ほかの日の出力とは重ならない）
    const day2 = events.filter((e) => e.type === "agent.run" && pl(e).agentId === agentId && e.recordedAt >= jst(DAYS[1]!, 0) && e.recordedAt < jst(DAYS[2]!, 0));
    expect(day2.map((e) => pl(e).purpose), "2日目は注文用の run だけのはず").toEqual(["order"]);
    const order = day2[0]!;
    r.outputHash = pl(order).outputHash as string;
    const { values } = await openStore(clock);
    const output = values.body(r.outputHash)!.value;
    const note = (JSON.parse(output) as { note: string }).note;
    expect(output).toContain(JSON.stringify(note));
    const before = await readAllEvents(db);

    // ffr_app で足す：投稿用の run（出力は本物と同じ文）と、本文が note の投稿
    const forged = await forgePost(clock, order, note, { outputText: output });
    await verifyDatabase(db, holidayTable);
    // 運営者が（偽と気づかずに）取り下げ、手順書の1つ目の文に出るのを見てから消す
    await withdraw(clock, forged.post.seq);
    expect(await problem(forged.post.seq)).toBeNull();
    await attempt(() => erase(forged.post.seq));
    r.outputKept = await has(r.outputHash);
    // 消えても、イベントは変わらず、連鎖と保存の検査は通る（本物の判断の出力が消えたことは、検査では分からない）
    const after = await readAllEvents(db);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(await verifyChain(after)).toEqual([]);
    await verifyDatabase(db, holidayTable);
    r.ran = true;
  });
  it.fails("【欠陥・高】上の状態で、本物の判断（注文用の run）の出力の行が、全文ごと消える（直れば残る）", () => {
    expect(r.ran, "前提の試験が動いていない").toBe(true);
    expect(r.outputKept).toBe(true);
  });

  it("（上の欠陥の影響の範囲）表示中の投稿の本文の行を、偽の run の出力として指させても、本文は消えない（ほかの記録が指すハッシュは消せない）", async () => {
    const { clock, events, post } = await threeDays();
    const agentId = pl(post).agentId as string;
    const order = events.find((e) => e.type === "agent.run" && pl(e).agentId === agentId && pl(e).purpose === "order" && e.recordedAt >= jst(DAYS[1]!, 0))!;
    const victim = pl(post).bodyHash as string;
    const { values } = await openStore(clock);
    const text = values.body(victim)!.value;
    const forged = await forgePost(clock, order, text, { outputHash: victim });
    await withdraw(clock, forged.post.seq);
    await attempt(() => erase(forged.post.seq));
    await attempt(() => eraseOutputs(forged.post.seq));
    expect(await has(victim)).toBe(true);
    expect(await has(pl(order).outputHash as string)).toBe(true);
    const snap = await readSnapshot(db, { warn: () => undefined });
    expect(snap.bodyOf(victim)).toBe(text);
  });
});

describe("本物の投稿と同じ本文の写しを足す", { timeout: 120_000 }, () => {
  // 写しの投稿（本文のハッシュが同じ）は run_has_many_posts に数えない。erase_withdrawn_body は 003 の決まり（写しがすべて取り下げられるまで
  // 本文を消せない）で断るが、erase_withdrawn_outputs（運営者が直接呼べる）と削除の見張りは、写しだけの取り下げで本物の判断の出力を通す
  const r: { ran?: boolean; viaFunction?: boolean; viaGuard?: boolean } = {};
  it("【欠陥・低の前提】アプリの接続で、表示中の投稿の写しを足し、写しだけを取り下げる", async () => {
    const { clock, events, post } = await threeDays();
    const runs = decisionRuns(events, events.find((e) => e.seq === pl(post).runSeq)!);
    expect(runs.map((e) => pl(e).purpose).sort()).toEqual(["order", "post"]);
    const outputs = [...new Set(runs.map((e) => pl(e).outputHash as string))];
    const twin = await asApp(async () => {
      const { store } = await openStore(clock);
      const t = await store.append({ type: "post.published", actor: post.actor, refs: post.refs, payload: { ...pl(post) } } as never);
      if (!t.ok) throw new Error(t.reason);
      return t.event;
    });
    await withdraw(clock, twin.seq);
    // 本文を消す関数は断る（本物の投稿は表示中）
    await expect(erase(twin.seq)).rejects.toThrow("may not be erased");
    expect(await problem(twin.seq)).toBeNull();
    // 削除の見張りが使う判定は、本物の判断の出力を「消してよい」と言う
    const guard = await Promise.all(outputs.map(async (h) => (await db.query<{ ok: boolean }>("SELECT stored_values_output_erasable(current_schema(), $1) AS ok", [h])).rows[0]!.ok));
    r.viaGuard = guard.every((ok) => !ok);
    // 出力だけを消す関数を、運営者が写しの seq で呼ぶ
    await attempt(() => eraseOutputs(twin.seq));
    r.viaFunction = (await Promise.all(outputs.map(has))).every(Boolean);
    expect(await has(pl(post).bodyHash as string), "本物の投稿の本文は残る").toBe(true);
    await verifyDatabase(db, holidayTable);
    r.ran = true;
  });
  it.fails("【欠陥・低】上の状態で、削除の見張りの判定（stored_values_output_erasable）が、表示中の投稿の判断の出力を消してよいと言う（直れば言わない）", () => {
    expect(r.ran, "前提の試験が動いていない").toBe(true);
    expect(r.viaGuard).toBe(true);
  });
  it.fails("【欠陥・低】上の状態で、erase_withdrawn_outputs が、表示中の投稿の判断の出力（投稿用と注文用）を消す（直れば残る）", () => {
    expect(r.ran, "前提の試験が動いていない").toBe(true);
    expect(r.viaFunction).toBe(true);
  });
});

describe("細工が断られること", { timeout: 120_000 }, () => {
  it("本物の投稿の run を指す、別の本文の偽の投稿を取り下げて消そうとしても断られ、本物の出力も本文も残る", async () => {
    const { clock, events, post } = await threeDays();
    const runs = decisionRuns(events, events.find((e) => e.seq === pl(post).runSeq)!);
    const forged = await asApp(async () => {
      const { values, store } = await openStore(clock);
      const bodyHash = await values.putBody("note");
      const f = await store.append({ type: "post.published", actor: post.actor, refs: post.refs, payload: { ...pl(post), bodyHash } } as never);
      if (!f.ok) throw new Error(f.reason);
      return f.event;
    });
    await withdraw(clock, forged.seq);
    await expect(erase(forged.seq)).rejects.toThrow("run_has_many_posts");
    await expect(eraseOutputs(forged.seq)).rejects.toThrow("run_has_many_posts");
    for (const r of runs) expect(await has(pl(r).outputHash as string)).toBe(true);
    expect(await has(pl(post).bodyHash as string)).toBe(true);
  });

  it("（いまの決まり）本物の投稿の判断に、アプリの接続で投稿用の run を足すと、本物の投稿の本文を消せなくなる（decision_unclear）", async () => {
    const { clock, events, post } = await threeDays();
    const order = decisionRuns(events, events.find((e) => e.seq === pl(post).runSeq)!).find((e) => pl(e).purpose === "order")!;
    await forgePost(clock, order, "偽の投稿");
    await withdraw(clock, post.seq);
    await expect(erase(post.seq)).rejects.toThrow("decision_unclear");
    expect(await has(pl(post).bodyHash as string)).toBe(true);
  });

  it("アプリの接続で、運営者を名乗る取り下げを足せても、関数を呼べず、見張りも通らない", async () => {
    const { clock, post } = await threeDays();
    const out = pl(post).runSeq as number;
    await asApp(async () => {
      const { store } = await openStore(clock);
      const w = await store.append({ type: "content.withdrawn", actor: "operator:owner", refs: [post.seq], payload: { targetSeq: post.seq, reason: "なりすまし", bodyErased: true } });
      expect(w.ok).toBe(true);
      await expect(erase(post.seq)).rejects.toThrow(/permission denied/);
      await expect(eraseOutputs(post.seq)).rejects.toThrow(/permission denied/);
      await expect(db.query("DELETE FROM stored_values WHERE kind = 'body'")).rejects.toThrow(/permission denied/);
    });
    const events = await readAllEvents(db);
    for (const r of decisionRuns(events, events.find((e) => e.seq === out)!)) expect(await has(pl(r).outputHash as string)).toBe(true);
  });
});

describe("削除の見張りと関数の範囲", { timeout: 120_000 }, () => {
  it("取り下げた投稿の判断の出力だけを、持ち主が印を入れて直接消せる。ほかの判断の出力は消せない。元の run の出力を先に消すと、残りは消せない", async () => {
    const { clock, events, post } = await threeDays();
    await withdraw(clock, post.seq);
    const postRun = events.find((e) => e.seq === pl(post).runSeq)!;
    const runs = decisionRuns(events, postRun);
    const own = new Set(runs.map((e) => pl(e).outputHash as string));
    const del = (h: string) =>
      db.transaction(async (tx) => {
        await tx.query("SELECT set_config('ffr.erase_body', $1, true)", [h]);
        await tx.query("DELETE FROM stored_values WHERE hash = $1", [h]);
      });
    // ほかの判断の出力
    for (const e of events.filter((x) => x.type === "agent.run" && !own.has(pl(x).outputHash as string)).slice(0, 5)) {
      await expect(del(pl(e).outputHash as string)).rejects.toThrow(/append-only/);
    }
    // 毎日の実行の判断は、投稿用と注文用で出力の全文が同じだが、乱数が違うので行は2つ
    expect(own.size).toBe(2);
    const source = pl(postRun).outputHash as string;
    const other = [...own].find((h) => h !== source)!;
    // 関数が選ぶ行と、見張りが通す行は同じ
    const chosen = (await db.query<{ h: string }>("SELECT withdrawn_post_outputs(current_schema(), $1) AS h", [post.seq])).rows.map((x) => x.h).sort();
    expect(chosen).toEqual([...own].sort());
    await del(source);
    await expect(del(other)).rejects.toThrow(/append-only/);
    expect(await has(other)).toBe(true);
  });
});

describe("注文票の確定の前に消すと断る", { timeout: 180_000 }, () => {
  it("投稿のあと、その AI の注文票の確定の前に落ち、その間に運営者が本文を消そうとすると、断られて何も消えない。回し直してから消せる", async () => {
    // 1回目：投稿する AI と日を知る
    const first = await threeDays();
    const id = pl(first.post).agentId as string;
    const d = DAYS.filter((x) => jst(x, 0) <= first.post.recordedAt).at(-1)!;
    // 2回目：その日のその AI の注文票の確定で1回だけ落とす
    await resetSchema(pg);
    await migrate(db);
    const w = world();
    for (const x of DAYS.slice(0, DAYS.indexOf(d))) await w.run(x);
    let hits = 0;
    const hit = (t: string, q?: readonly unknown[]) => {
      if (hits > 0 || !t.startsWith("INSERT INTO events") || !q) return false;
      const vals = q.filter((v): v is string => typeof v === "string");
      return vals.includes("order_sheet.committed") && vals.some((v) => v.includes(`"agentId":"${id}"`));
    };
    const crashing: SqlDb = { ...db, transaction: (fn) => db.transaction((tx) => fn({ ...tx, query: (t, q) => (hit(t, q) ? (hits++, Promise.reject(new Error("crash"))) : tx.query(t, q)) })) };
    await expect(w.run(d, { db: crashing })).rejects.toThrow("crash");
    expect(hits).toBe(1);
    const events = await readAllEvents(db);
    const post = events.find((e) => e.type === "post.published" && pl(e).agentId === id)!;
    const runs = decisionRuns(events, events.find((e) => e.seq === pl(post).runSeq)!);
    expect(runs.map((e) => pl(e).purpose).sort(), "投稿用と注文用の run は書いたあと").toEqual(["order", "post"]);
    expect(events.some((e) => e.type === "order_sheet.committed" && pl(e).agentId === id && e.recordedAt >= jst(d, 0))).toBe(false);
    await withdraw(w.clock, post.seq);
    await expect(erase(post.seq)).rejects.toThrow("sheet_not_settled");
    await expect(eraseOutputs(post.seq)).rejects.toThrow("sheet_not_settled");
    expect(await has(pl(post).bodyHash as string)).toBe(true);
    for (const r of runs) expect(await has(pl(r).outputHash as string)).toBe(true);
    // 回し直すと、その日を最後まで進め、そのあと消せる
    await w.run(d);
    for (const x of DAYS.slice(DAYS.indexOf(d) + 1)) await w.run(x);
    const before = await readAllEvents(db);
    expect(await erase(post.seq)).toBe(pl(post).bodyHash);
    for (const r of runs) expect(await has(pl(r).outputHash as string)).toBe(false);
    expect(await readAllEvents(db)).toEqual(before);
    expect(await verifyChain(before)).toEqual([]);
    await verifyDatabase(db, holidayTable);
    // 次の営業日も止まらない
    await w.run(NEXT_DAY);
    const after = await readAllEvents(db);
    expect(after.some((e) => e.type === "valuation.recorded" && pl(e).date === NEXT_DAY)).toBe(true);
    expect((await verifyDatabase(db, holidayTable)).lastHash).toBe(after.at(-1)!.hash);
  });
});

describe("出力が本文を持つかの決め方（output_has_body）", { timeout: 60_000 }, () => {
  it("毎日の実行が書く形（正規化した JSON）なら、引用符・逆斜線・改行・タブ・制御文字・絵文字・U+2028 でも（正規化は NFC でない文字列を断るので、結合文字の差は起きない）、本文を持つと判定する", async () => {
    await resetSchema(pg);
    await migrate(db);
    const texts = ['"引用"と\\逆斜線', "改行\nと\tタブ\r", "制御\u0001\u001f\u007f", "絵文字\u{1F600}と\u{20BB7}", "行区切り\u2028段落\u2029", "</script>", "A"];
    for (const t of texts) {
      const out = canonicalize({ note: "x", orders: [], post: { board: "全体", text: t } });
      const ok = (await db.query<{ ok: boolean }>("SELECT output_has_body($1, $2) AS ok", [out, t])).rows[0]!.ok;
      expect(ok, JSON.stringify(t)).toBe(true);
    }
  });

  it("（いまの決まり・限界）出力が本文を \\u の書き方や別の形で持つと、本文を持たないと判定し、本文も消せない（output_without_body）", async () => {
    await resetSchema(pg);
    await migrate(db);
    const t = "買い";
    for (const out of [JSON.stringify({ text: t }).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`), `text: ${t}`, `{"text": "${t}です"}`]) {
      const ok = (await db.query<{ ok: boolean }>("SELECT output_has_body($1, $2) AS ok", [out, t])).rows[0]!.ok;
      expect(ok, out).toBe(false);
    }
  });
});
