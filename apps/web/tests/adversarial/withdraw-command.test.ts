// 検証（verifier、#166・PR #169）：投稿の取り下げを書くコマンド（daily withdraw。scripts/daily-lib.ts の withdrawPost）を、実装とは別に確かめる。
// 文書（EVENT_LOG §3.4・§5.2・§6.1、db/003_erase_body.sql、db/ops/erase_body.sql、issue #166）から成り立つはずのこと：
// - 書けるのは表の持ち主の接続だけ。アプリの接続（ffr_app）は、DATABASE_ADMIN_URL に入れても、search_path・一時テーブル・
//   別の schema の細工でも、本物の記録（public.events）に取り下げを書けない
// - 対象が投稿でない・存在しない・数でないときは、何も書かない。取り下げ済みの投稿を取り下げ直すと、新しい理由が画面に出る
// - 理由は必須。空・空白だけ・見えない文字だけ・改行・制御文字・文字の向きを変える文字・ハッシュに見える文字列は断る
// - --erase-body のとき、消せない本文なら、追記を同じトランザクションで取り消す。取り消したあとも、ほかの保管の状態と DB はずれず、
//   続けて書いた記録・毎日の実行で連鎖が壊れない。毎日の実行と同時に動いても壊れない
// - 書いたあと、照合（daily verify と同じ）が通り、読むだけの口から作った画面のデータで「非表示（理由）」になる。
//   続けて erase_withdrawn_body で本文を消しても、照合が通る
// 欠陥の再現は it.fails（欠陥が直ると落ちるので、直したら it に戻す）。
import { decisionOpensAt, marketClosedDays } from "../../src/ledger/ledger";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTableOwner, productionSetup, runDaily, verifyDatabase, withdrawPost, withdrawReasonProblem } from "../../scripts/daily-lib";
import { canonicalize } from "../../src/events/canonical";
import { verifyChain } from "../../src/events/chain";
import type { LogEvent } from "../../src/events/types";
import { holidayTable } from "../../src/holidays";
import { readSnapshot } from "../../src/store/pg-reader";
import { PgEventStore, readAllEvents } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate, type SqlDb } from "../../src/store/sql";
import { buildBoard } from "../../src/view/board";
import { buildView } from "../../src/view/build";
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
const NEXT_DAY = "2026-11-12";
const count = async (table = "public.events") => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
const bodyHashOf = (e: LogEvent) => (e.payload as { bodyHash: string }).bodyHash;
const hasBody = async (h: string) => (await db.query("SELECT 1 FROM public.stored_values WHERE hash = $1 AND kind = 'body'", [h])).rows.length === 1;
const openStore = async (clock: FakeClock) => PgEventStore.open(db, { values: await PgValueStore.open(db), holidayTables: new Map([[holidayTable.contentSha256, holidayTable]]), clock });

/** 役割を切り替えて fn を動かし、必ず戻す */
async function as<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await pg.exec(`SET ROLE ${role}`);
  try {
    return await fn();
  } finally {
    await pg.exec("RESET ROLE; RESET search_path; DISCARD TEMP");
  }
}

/** 2つ目の投稿の元にする判断：最後の日の、投稿しない AI の注文用の run の中身と、1つ目の投稿の掲示板（回し直しても毎回同じ） */
let secondSource: { payload: Record<string, unknown>; refs: number[]; board: string; output: string } | undefined;
const SECOND_TEXT = "二つ目の投稿の本文";

/** 3営業日を本番の入口で書く。規則の AI はあまり投稿しないので、最後の日に、投稿しない AI の判断に投稿を1つ足す（2つ目の投稿） */
function days() {
  const clock = new FakeClock(jst(DAYS[0]!, 7));
  const waitUntil = async (at: number) => void (at > clock.now() && clock.set(at));
  const run = (d: string) => runDaily(d, { db, clock, prepare: productionSetup, holidayTable, waitUntil });
  return { clock, waitUntil, run };
}
async function setUp() {
  if (!secondSource) {
    const { run } = days();
    // 一度だけ、足さずに最後まで回し、最後の日の判断の入力（どの記録を見たか）を知る
    await resetSchema(pg);
    await migrate(db);
    for (const d of DAYS) await run(d);
    const events = await readAllEvents(db);
    const first = events.find((e) => e.type === "post.published");
    if (!first) throw new Error("no post.published in the production run");
    const lastDay = events.filter((e) => e.type === "agent.run" && e.recordedAt >= opensOf(DAYS.at(-1)!));
    const order = lastDay.find((e) => {
      const p = e.payload as { agentId: string; purpose: string };
      return p.purpose === "order" && p.agentId !== (first.payload as { agentId: string }).agentId && !lastDay.some((x) => (x.payload as { agentId: string; purpose: string }).agentId === p.agentId && (x.payload as { purpose: string }).purpose === "post");
    });
    if (!order) throw new Error("no order run without a post on the last day");
    const output = (await PgValueStore.open(db)).body((order.payload as { outputHash: string }).outputHash)?.value;
    if (output === undefined) throw new Error("the output of the order run is not stored");
    secondSource = { payload: order.payload as Record<string, unknown>, refs: [...order.refs], board: (first.payload as { board: string }).board, output };
  }
  const { clock, waitUntil, run } = days();
  await resetSchema(pg);
  await migrate(db);
  for (const d of DAYS.slice(0, -1)) await run(d);
  // 最後の日の判断の前に、その AI の投稿用の run（入力は毎日の実行が選ぶものと同じ。出力は投稿を足した判断）と投稿を書いておく。
  // 毎日の実行は、記録済みの run の出力をその日の判断として読み直し、注文用の run を同じ入力・同じ出力で書いて注文票を確定する。
  // こうすると、2つ目の投稿は、1つ目の投稿とは別の判断から出た投稿になる（本文を消す関数の「1つの run を指す投稿は1つ」に合う）
  const values = await PgValueStore.open(db);
  const store = await PgEventStore.open(db, { values, holidayTables: new Map([[holidayTable.contentSha256, holidayTable]]), clock });
  const src = secondSource;
  const agentId = src.payload.agentId as string;
  const decision = { ...(JSON.parse(src.output) as Record<string, unknown>), post: { board: src.board, text: SECOND_TEXT } };
  const outputHash = await values.putBody(canonicalize(decision));
  const postRun = await store.append({ type: "agent.run", actor: "system", refs: src.refs, payload: { ...src.payload, purpose: "post", outputHash, startedAt: clock.now(), finishedAt: clock.now() } } as never);
  if (!postRun.ok) throw new Error(`could not add the post run: ${postRun.reason}`);
  const bodyHash = await values.putBody(SECOND_TEXT);
  const second = await store.append({ type: "post.published", actor: `agent:${agentId}`, refs: [postRun.event.seq], payload: { agentId, board: src.board, bodyHash, citeSeqs: [], runSeq: postRun.event.seq } } as never);
  if (!second.ok) throw new Error(`could not add the second post: ${second.reason}`);
  await run(DAYS.at(-1)!);
  const events = await readAllEvents(db);
  const sheet = events.find((e) => e.type === "order_sheet.committed" && (e.payload as { agentId: string }).agentId === agentId && e.seq > second.event.seq);
  if (!sheet) throw new Error("the order sheet of the second post's decision was not committed");
  const posts = events.filter((e) => e.type === "post.published");
  expect(posts.length).toBeGreaterThanOrEqual(2);
  return { clock, waitUntil, events, posts };
}

/** 連鎖が切れ目なく続き、照合が通る */
async function chainIsIntact() {
  const events = await readAllEvents(db);
  expect(await verifyChain(events)).toEqual([]);
  events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  await verifyDatabase(db);
  return events;
}

async function screen() {
  const snap = await readSnapshot(db, { warn: () => undefined });
  return { view: buildView(snap.events, snap.bodyOf), bodyOf: snap.bodyOf };
}

describe("書けるのは表の持ち主の接続だけ", { timeout: 120_000 }, () => {
  it("ffr_app が一時テーブル events を作り、search_path を pg_temp 先にしても、本物の記録には書けない", async () => {
    const { clock, posts } = await setUp();
    const before = await count();
    await as("ffr_app", async () => {
      // ffr_app は本物の記録を読めるので、写しを一時テーブルに作れる（一時テーブルの持ち主は ffr_app）
      await pg.exec("CREATE TEMP TABLE events AS SELECT * FROM public.events; CREATE TEMP TABLE stored_values AS SELECT * FROM public.stored_values; SET search_path = pg_temp, public");
      await withdrawPost(db, { targetSeq: posts[0]!.seq, reason: "なりすまし", eraseBody: false }, { clock }).catch(() => undefined);
    });
    expect(await count()).toBe(before);
    expect((await readAllEvents(db)).some((e) => e.type === "content.withdrawn")).toBe(false);
    await chainIsIntact();
  });

  it("ffr_app が持ち主の schema を current_schema にしても（DATABASE_SCHEMA の取り違え）、本物の記録には書けない", async () => {
    const { clock, posts } = await setUp();
    const before = await count();
    await pg.exec("DROP SCHEMA IF EXISTS app_owned CASCADE; CREATE SCHEMA app_owned AUTHORIZATION ffr_app");
    try {
      await as("ffr_app", async () => {
        await pg.exec("CREATE TABLE app_owned.events AS SELECT * FROM public.events; CREATE TABLE app_owned.stored_values AS SELECT * FROM public.stored_values; SET search_path = app_owned, public");
        await withdrawPost(db, { targetSeq: posts[0]!.seq, reason: "なりすまし", eraseBody: false }, { clock }).catch(() => undefined);
      });
      expect(await count()).toBe(before);
    } finally {
      await pg.exec("DROP SCHEMA IF EXISTS app_owned CASCADE");
    }
    await chainIsIntact();
  });

  it("持ち主の役割に NOINHERIT で入っているだけの ffr_app は、持ち主と見なさない（SET ROLE しない限り持ち主の権限は使えない）", async () => {
    await setUp();
    await pg.exec("DROP ROLE IF EXISTS ffr_owner2; CREATE ROLE ffr_owner2 NOSUPERUSER; GRANT USAGE, CREATE ON SCHEMA public TO ffr_owner2; ALTER TABLE events OWNER TO ffr_owner2; ALTER TABLE stored_values OWNER TO ffr_owner2");
    await pg.exec("ALTER ROLE ffr_app NOINHERIT; GRANT ffr_owner2 TO ffr_app");
    try {
      expect(await as("ffr_app", () => isTableOwner(db))).toBe(false);
    } finally {
      await pg.exec("REVOKE ffr_owner2 FROM ffr_app; ALTER ROLE ffr_app INHERIT");
    }
  });

  it("DATABASE_SCHEMA が存在しない schema を指すとき（current_schema が NULL）、持ち主とは見なさない", async () => {
    await setUp();
    await as("ffr_app", async () => {
      await pg.exec("SET search_path = no_such_schema");
      expect(await isTableOwner(db)).toBe(false);
    });
  });
});

describe("対象の検査", { timeout: 120_000 }, () => {
  it("seq が数でない・小数・負・巨大・取り下げの記録そのもの、のときは何も書かない", async () => {
    const { clock, posts } = await setUp();
    const w = await withdrawPost(db, { targetSeq: posts[0]!.seq, reason: "事実と異なる", eraseBody: false }, { clock });
    const before = await count();
    for (const targetSeq of [Number.NaN, 1.5, -1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, w.seq]) {
      await expect(withdrawPost(db, { targetSeq, reason: "誤り", eraseBody: false }, { clock }), `targetSeq=${targetSeq}`).rejects.toThrow();
    }
    expect(await count()).toBe(before);
    await chainIsIntact();
  });

  it("取り下げ済みの投稿を取り下げ直すと、画面には新しい理由が出る。本文消し済みの投稿は、本文を残す記録にできない", async () => {
    const { clock, posts } = await setUp();
    const t = posts[0]!;
    await withdrawPost(db, { targetSeq: t.seq, reason: "一つ目の理由", eraseBody: true }, { clock });
    const second = await withdrawPost(db, { targetSeq: t.seq, reason: "二つ目の理由", eraseBody: true }, { clock });
    expect((await screen()).view.timeline.find((x) => x.seq === t.seq)).toMatchObject({ text: null, withdrawn: { seq: second.seq, reason: "二つ目の理由" } });
    expect((await db.query<{ h: string }>("SELECT erase_withdrawn_body($1) AS h", [t.seq])).rows[0]!.h).toBe(bodyHashOf(t));
    const before = await count();
    await expect(withdrawPost(db, { targetSeq: t.seq, reason: "三つ目", eraseBody: false }, { clock })).rejects.toThrow(/no stored row/);
    expect(await count()).toBe(before);
    await chainIsIntact();
  });
});

describe("理由の検査", () => {
  it("断るべきもの：空・空白（全角・タブ・改行）・制御文字・C1 制御文字・向きを変える文字（埋め込み・上書き・分離）・ハッシュ（大文字も）", () => {
    const bad = ["", "   ", "　\t\n", "誤\rり","誤り\u0000", "誤り\u0085", "誤り\u009b", "‪誤り", "‮誤り", "⁧誤り", "A".repeat(32).replace(/A/g, "F"), `x${"0".repeat(64)}y`, "あ".repeat(201)];
    for (const r of bad) expect(withdrawReasonProblem(r), JSON.stringify(r)).not.toBeNull();
  });

  it("通るべきもの：前後の空白は削って数える。ちょうど200文字。16進が31文字までの文字列", () => {
    expect(withdrawReasonProblem(`  ${"あ".repeat(200)}  `)).toBeNull();
    expect(withdrawReasonProblem("f".repeat(31))).toBeNull();
  });

  // 以下3件は、PR #172 で欠陥として it.fails にしたもの。a50b80c で直った
  it("行の区切り U+2028・段落の区切り U+2029 を断る", () => {
    expect(withdrawReasonProblem("事実と 異なる")).not.toBeNull();
    expect(withdrawReasonProblem("事実と 異なる")).not.toBeNull();
  });

  it("文字の向きを変える印 U+200E・U+200F・U+061C を断る", () => {
    for (const c of ["‎", "‏", "؜"]) expect(withdrawReasonProblem(`seq 12${c}34 の誤り`), `U+${c.codePointAt(0)!.toString(16)}`).not.toBeNull();
  });

  it("見えない文字だけの理由を、空として断る", () => {
    for (const r of ["​", "⁠⁠", "ㅤ", " ​ ", "﻿ "]) expect(withdrawReasonProblem(r), JSON.stringify(r)).not.toBeNull();
  });
});

describe("--erase-body の取り消しと、保管の状態", { timeout: 180_000 }, () => {
  /** 対象と同じ bodyHash の写しの投稿を足す（アプリの接続でもできる） */
  async function forgeTwin(clock: FakeClock, src: LogEvent) {
    const r = await (await openStore(clock)).append({ type: "post.published", actor: src.actor, refs: src.refs, payload: { ...(src.payload as Record<string, unknown>) } } as never);
    if (!r.ok) throw new Error(`could not write the twin: ${r.reason}`);
    return r.event;
  }
  /** 投稿以外の記録に、対象の本文のハッシュを入れる（理由にハッシュを書いた取り下げを、コマンドを通さずに保管へ直接足す）。これで対象の本文は消せなくなる */
  async function poison(clock: FakeClock, src: LogEvent, other: LogEvent) {
    const r = await (await openStore(clock)).append({ type: "content.withdrawn", actor: "operator:owner", refs: [other.seq], payload: { targetSeq: other.seq, reason: `参考 ${bodyHashOf(src)}`, bodyErased: false } });
    if (!r.ok) throw new Error(`could not write the poisoned record: ${r.reason}`);
    return r.event;
  }
  const erase = async (seq: number) => (await db.query<{ h: string | null }>("SELECT erase_withdrawn_body($1) AS h", [seq])).rows[0]!.h;
  const go = (targetSeq: number, eraseBody: boolean, clock: FakeClock, reason = "権利者からの申し出") => withdrawPost(db, { targetSeq, reason, eraseBody }, { clock });

  it("取り消したあと、前から開いていた保管（毎日の実行が持つもの）で書き足しても、連鎖が続き、次の日の実行と照合も通る", async () => {
    const { clock, waitUntil, posts } = await setUp();
    const t = posts[0]!;
    await poison(clock, t, posts[1]!);
    // 毎日の実行と同じく、取り下げの前から開いている保管
    const longLived = await openStore(clock);
    const before = await readAllEvents(db);
    await expect(go(t.seq, true, clock)).rejects.toThrow(/cannot be erased/);
    expect(await readAllEvents(db)).toEqual(before);
    expect(await hasBody(bodyHashOf(t))).toBe(true);

    // 同じ対象を、本文を残す記録で取り下げる：直前の記録に続く seq とハッシュになる
    const ok = await go(t.seq, false, clock);
    expect(ok.seq).toBe(before.length + 1);
    expect((await readAllEvents(db)).at(-1)!.prevHash).toBe(before.at(-1)!.hash);

    // 前から開いていた保管は、取り消された記録を知らず、DB の末尾（いま書いた記録）に追いついてから書く
    const again = await longLived.append({ type: "content.withdrawn", actor: "operator:owner", refs: [posts[1]!.seq], payload: { targetSeq: posts[1]!.seq, reason: "別の投稿", bodyErased: false } });
    expect(again.ok && again.event.seq).toBe(before.length + 2);
    expect((await longLived.last())!.seq).toBe(before.length + 2);

    clock.set(jst(NEXT_DAY, 7));
    await runDaily(NEXT_DAY, { db, clock, prepare: productionSetup, holidayTable, waitUntil });
    await chainIsIntact();
  });

  it("断られた取り消しを何度繰り返しても、DB の末尾は変わらない（写しの投稿の側から書いても断る）", async () => {
    const { clock, posts } = await setUp();
    const t = posts[0]!;
    const twin = await forgeTwin(clock, t);
    await poison(clock, t, posts[1]!);
    const before = await readAllEvents(db);
    for (let i = 0; i < 3; i++) await expect(go(t.seq, true, clock, `申し出${i}`)).rejects.toThrow(/cannot be erased/);
    for (let i = 0; i < 3; i++) await expect(go(twin.seq, true, clock, `申し出${i}`)).rejects.toThrow(/cannot be erased/);
    expect(await readAllEvents(db)).toEqual(before);
    await chainIsIntact();
  });

  // PR #172 で欠陥として it.fails にしたもの。a50b80c（案 b）で直った
  it("同じ本文を指す2つの投稿を、コマンドで順に本文を消す印つきで取り下げられ、そのあと本文を消せる", async () => {
    const { clock, posts } = await setUp();
    const t = posts[0]!;
    const twin = await forgeTwin(clock, t);
    expect((await go(twin.seq, true, clock, "写しの投稿")).pendingSeqs).toEqual([t.seq]);
    expect((await go(t.seq, true, clock)).pendingSeqs).toEqual([]);
    expect(await erase(t.seq)).toBe(bodyHashOf(t));
    await chainIsIntact();
  });

  it("pendingSeqs：3つの写しで、残りを seq の順に返す。取り下げ直しで印を外した投稿は、残りに戻る", async () => {
    const { clock, posts } = await setUp();
    const t = posts[0]!;
    const a = await forgeTwin(clock, t);
    const b = await forgeTwin(clock, t);
    expect((await go(b.seq, true, clock)).pendingSeqs).toEqual([t.seq, a.seq]);
    expect((await go(t.seq, true, clock)).pendingSeqs).toEqual([a.seq]);
    // a を本文を残す記録で取り下げても、a は残りのまま
    expect((await go(a.seq, false, clock)).pendingSeqs).toEqual([]);
    expect((await go(b.seq, true, clock)).pendingSeqs).toEqual([a.seq]);
    // 残りがあるうちは、本文を消す関数も断る（写しの投稿の側から消すこともできない）
    for (const s of [t.seq, a.seq, b.seq]) await expect(erase(s)).rejects.toThrow();
    expect(await hasBody(bodyHashOf(t))).toBe(true);
    expect((await go(a.seq, true, clock)).pendingSeqs).toEqual([]);
    // t の印を外すと、t が残りに戻る
    expect((await go(t.seq, false, clock)).pendingSeqs).toEqual([]);
    expect((await go(a.seq, true, clock)).pendingSeqs).toEqual([t.seq]);
    await expect(erase(t.seq)).rejects.toThrow();
    expect((await go(t.seq, true, clock)).pendingSeqs).toEqual([]);
    expect(await erase(b.seq)).toBe(bodyHashOf(t));
    await chainIsIntact();
  });

  it("写しの投稿があっても、投稿以外の記録がハッシュを指していれば、印つきの取り下げは断る（残りを返して書く道に入らない）", async () => {
    const { clock, posts } = await setUp();
    const t = posts[0]!;
    const twin = await forgeTwin(clock, t);
    await go(twin.seq, true, clock);
    await poison(clock, t, posts[1]!);
    const before = await count();
    await expect(go(t.seq, true, clock)).rejects.toThrow(/other records refer/);
    expect(await count()).toBe(before);
  });

  it("写しの投稿がまだ残っていて（pendingSeqs が空でない状態）、投稿以外の記録もハッシュを指すとき、どちらの投稿の印つきの取り下げも断り、記録は変わらない。DB の判定と食い違わない", async () => {
    const { clock, posts } = await setUp();
    const t = posts[0]!;
    const twin = await forgeTwin(clock, t);
    await poison(clock, t, posts[1]!);
    const before = await readAllEvents(db);
    await expect(go(t.seq, true, clock)).rejects.toThrow(/other records refer/);
    await expect(go(twin.seq, true, clock)).rejects.toThrow(/other records refer/);
    expect(await readAllEvents(db)).toEqual(before);
    // コマンドを通さずに両方へ印をつけても、DB の判定（stored_values_erasable）は消せないと言う（コマンドの判定と同じ側）
    const store = await openStore(clock);
    for (const s of [t.seq, twin.seq]) expect((await store.append({ type: "content.withdrawn", actor: "operator:owner", refs: [s], payload: { targetSeq: s, reason: "直接", bodyErased: true } })).ok).toBe(true);
    expect((await db.query<{ ok: boolean }>("SELECT stored_values_erasable(current_schema(), $1) AS ok", [bodyHashOf(t)])).rows[0]!.ok).toBe(false);
    await expect(erase(t.seq)).rejects.toThrow();
    await expect(go(t.seq, true, clock)).rejects.toThrow(/other records refer/);
    expect(await hasBody(bodyHashOf(t))).toBe(true);
  });

  it("投稿の中身の bodyHash 以外の項目にハッシュがあれば（写しの投稿の別の項目）、投稿以外の記録と同じく断る", async () => {
    const { clock, posts } = await setUp();
    const t = posts[0]!;
    const r = await (await openStore(clock)).append({ type: "post.published", actor: t.actor, refs: t.refs, payload: { ...(t.payload as Record<string, unknown>), bodyHash: bodyHashOf(posts[1]!), board: bodyHashOf(t) } } as never);
    // 掲示板の名前として断られたら、この道はもともとない
    if (!r.ok) return;
    const before = await count();
    await expect(go(t.seq, true, clock)).rejects.toThrow(/other records refer/);
    expect(await count()).toBe(before);
  });

  it("毎日の実行と同時に、成功する取り下げと断られる取り下げを流しても、連鎖が壊れず、書けたのは成功した1件だけ", async () => {
    const { clock, waitUntil, posts } = await setUp();
    const [a, b] = [posts[0]!, posts[1]!];
    const poisoned = await poison(clock, b, a); // b の本文は消せない（a を指す取り下げの理由に b のハッシュ）
    clock.set(jst(NEXT_DAY, 7));
    const results = await Promise.allSettled([
      runDaily(NEXT_DAY, { db, clock, prepare: productionSetup, holidayTable, waitUntil }),
      go(a.seq, true, clock),
      go(b.seq, true, clock),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    const events = await chainIsIntact();
    const ws = events.filter((e) => e.type === "content.withdrawn" && e.seq !== poisoned.seq);
    expect(ws.map((e) => (e.payload as { targetSeq: number; bodyErased: boolean }).targetSeq)).toEqual([a.seq]);
    expect(await erase(a.seq)).toBe(bodyHashOf(a));
    await expect(erase(b.seq)).rejects.toThrow();
    await chainIsIntact();
  });

  // PR #172 で欠陥として it.fails にしたもの。a50b80c で、本文の行の確かめが追記のトランザクションの中（FOR SHARE）に移った。
  // PGlite は接続が1つなので、ほかの接続が割り込む形は作れない。追記のトランザクションが鍵（advisory lock）を取った直後に、
  // 同じトランザクションで本文を消す（＝鍵を取る直前に、別の運営者の手順が本文を消して確定したのと、確かめが見る状態は同じ）
  it("本文を残す取り下げの確かめと書き込みの間に本文が消されたら、何も書かない", async () => {
    const { clock, posts } = await setUp();
    const t = posts[0]!;
    await go(t.seq, true, clock, "一つ目");
    const before = await readAllEvents(db);
    let erasedInside = false;
    const racing: SqlDb = {
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            query: async (text, params) => {
              const r = await tx.query(text, params);
              if (text.includes("pg_advisory_xact_lock") && !erasedInside) {
                erasedInside = (await tx.query<{ h: string | null }>("SELECT erase_withdrawn_body($1) AS h", [t.seq])).rows[0]!.h !== null;
              }
              return r as never;
            },
          }),
        ),
    };
    await expect(withdrawPost(racing, { targetSeq: t.seq, reason: "本文を残す", eraseBody: false }, { clock })).rejects.toThrow(/no stored row/);
    expect(erasedInside).toBe(true);
    // トランザクションごと取り消されるので、記録も本文の削除も残らない
    expect(await readAllEvents(db)).toEqual(before);
    expect(await hasBody(bodyHashOf(t))).toBe(true);
    await chainIsIntact();
  });
});


describe("書いたあとの照合と画面", { timeout: 120_000 }, () => {
  it("--erase-body で書き、erase_withdrawn_body で消したあと、照合が通り、読むだけの口は本文を持たず、画面と掲示板は非表示（理由）", async () => {
    const { clock, posts } = await setUp();
    const t = posts[0]!;
    const w = await withdrawPost(db, { targetSeq: t.seq, reason: "権利者からの申し出", eraseBody: true, operator: "ops-2" }, { clock });
    expect((await readAllEvents(db)).at(-1)).toMatchObject({ actor: "operator:ops-2", refs: [t.seq] });
    await chainIsIntact();
    await db.query("SELECT erase_withdrawn_body($1)", [t.seq]);
    await chainIsIntact();
    const { view, bodyOf } = await screen();
    expect(bodyOf(bodyHashOf(t))).toBeUndefined();
    expect(view.timeline.find((x) => x.seq === t.seq)).toMatchObject({ kind: "post", text: null, withdrawn: { seq: w.seq, reason: "権利者からの申し出" } });
    const board = buildBoard(view, (t.payload as { board: string }).board)!;
    expect(board.posts.find((p) => p.seq === t.seq)).toMatchObject({ text: null, withdrawn: "権利者からの申し出" });
    // ほかの投稿は本文が出たまま
    expect(view.timeline.find((x) => x.seq === posts[1]!.seq)).toMatchObject({ withdrawn: null, text: expect.any(String) });
  });
});
