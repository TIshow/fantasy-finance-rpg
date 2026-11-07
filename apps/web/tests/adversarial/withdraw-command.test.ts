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
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTableOwner, productionSetup, runDaily, verifyDatabase, withdrawPost, withdrawReasonProblem } from "../../scripts/daily-lib";
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

/** 2営業日を本番の入口で書く */
async function setUp() {
  await resetSchema(pg);
  await migrate(db);
  const clock = new FakeClock(jst(DAYS[0]!, 7));
  const waitUntil = async (at: number) => void (at > clock.now() && clock.set(at));
  for (const d of DAYS) await runDaily(d, { db, clock, prepare: productionSetup, holidayTable, waitUntil });
  const first = (await readAllEvents(db)).find((e) => e.type === "post.published");
  if (!first) throw new Error("no post.published in the production run");
  // 規則の AI はあまり投稿しないので、本文の行を持つ2つ目の投稿を、同じ判断の記録を指して足す（検査を通る記録）
  const values = await PgValueStore.open(db);
  const bodyHash = await values.putBody("二つ目の投稿の本文");
  const second = await (await PgEventStore.open(db, { values, holidayTables: new Map([[holidayTable.contentSha256, holidayTable]]), clock })).append({ type: "post.published", actor: first.actor, refs: first.refs, payload: { ...(first.payload as Record<string, unknown>), bodyHash } } as never);
  if (!second.ok) throw new Error(`could not add the second post: ${second.reason}`);
  const events = await readAllEvents(db);
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

  // 欠陥（低）：U+2028（行の区切り）・U+2029（段落の区切り）は改行として表示されるが、\p{Cc} に入らないので通る。
  // 断る理由の文（line breaks）と食い違い、画面の1行の理由が複数行に見える
  it.fails("行の区切り U+2028・段落の区切り U+2029 を断る", () => {
    expect(withdrawReasonProblem("事実と 異なる")).not.toBeNull();
    expect(withdrawReasonProblem("事実と 異なる")).not.toBeNull();
  });

  // 欠陥（低）：Unicode の Bidi_Control のうち、U+200E（LRM）・U+200F（RLM）・U+061C（ALM）が抜けている。
  // RLM などで、数字や記号まわりの並びの見え方を変えられる
  it.fails("文字の向きを変える印 U+200E・U+200F・U+061C を断る", () => {
    for (const c of ["‎", "‏", "؜"]) expect(withdrawReasonProblem(`seq 12${c}34 の誤り`), `U+${c.codePointAt(0)!.toString(16)}`).not.toBeNull();
  });

  // 欠陥（低）：見えない文字（ゼロ幅の空白 U+200B・語をつなぐ印 U+2060・ハングルの埋め字 U+3164）だけの理由が、空と見なされずに通る。
  // 画面には「非表示（）」のように理由のない非表示が出る（--reason は必須、という決まりをすり抜ける）
  it.fails("見えない文字だけの理由を、空として断る", () => {
    for (const r of ["​", "⁠⁠", "ㅤ", " ​ "]) expect(withdrawReasonProblem(r), JSON.stringify(r)).not.toBeNull();
  });
});

describe("--erase-body の取り消しと、保管の状態", { timeout: 180_000 }, () => {
  /** 対象と同じ bodyHash の偽の投稿を足す（アプリの接続でもできる）。これで対象の本文は消せなくなる */
  async function forgeTwin(clock: FakeClock, src: LogEvent) {
    const r = await (await openStore(clock)).append({ type: "post.published", actor: src.actor, refs: src.refs, payload: { ...(src.payload as Record<string, unknown>) } } as never);
    if (!r.ok) throw new Error(`could not write the twin: ${r.reason}`);
    return r.event;
  }

  it("取り消したあと、前から開いていた保管（毎日の実行が持つもの）で書き足しても、連鎖が続き、次の日の実行と照合も通る", async () => {
    const { clock, waitUntil, posts } = await setUp();
    const t = posts[0]!;
    await forgeTwin(clock, t);
    // 毎日の実行と同じく、取り下げの前から開いている保管
    const longLived = await openStore(clock);
    const before = await readAllEvents(db);
    await expect(withdrawPost(db, { targetSeq: t.seq, reason: "権利者からの申し出", eraseBody: true }, { clock })).rejects.toThrow(/cannot be erased/);
    expect(await readAllEvents(db)).toEqual(before);
    expect(await hasBody(bodyHashOf(t))).toBe(true);

    // 同じ対象を、本文を残す記録で取り下げる：直前の記録に続く seq とハッシュになる
    const ok = await withdrawPost(db, { targetSeq: t.seq, reason: "権利者からの申し出", eraseBody: false }, { clock });
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

  it("断られた取り消しを何度繰り返しても、DB の末尾は変わらない（取り消しの途中の状態が残らない）", async () => {
    const { clock, posts } = await setUp();
    const t = posts[0]!;
    const twin = await forgeTwin(clock, t);
    const before = await readAllEvents(db);
    for (let i = 0; i < 3; i++) await expect(withdrawPost(db, { targetSeq: t.seq, reason: `申し出${i}`, eraseBody: true }, { clock })).rejects.toThrow(/cannot be erased/);
    for (let i = 0; i < 3; i++) await expect(withdrawPost(db, { targetSeq: twin.seq, reason: `申し出${i}`, eraseBody: true }, { clock })).rejects.toThrow(/cannot be erased/);
    expect(await readAllEvents(db)).toEqual(before);
    await chainIsIntact();
  });

  // 欠陥（低）：同じ bodyHash の投稿が2つあると（偽の投稿が本物の本文のハッシュを写したとき。erase_body.sql の手順1が想定する形）、
  // DB の決まりでは「両方を bodyErased 真で取り下げれば消せる」のに、コマンドはどちらを先に書いても
  // 「もう片方がまだ取り下げられていない」ので消せないと判定して断る。コマンドだけでは、その本文を消す状態にできない
  // （アプリの接続や SQL で記録を直接書くしかない）
  it.fails("同じ本文を指す2つの投稿を、コマンドで順に本文を消す印つきで取り下げられ、そのあと本文を消せる", async () => {
    const { clock, posts } = await setUp();
    const t = posts[0]!;
    const twin = await forgeTwin(clock, t);
    await withdrawPost(db, { targetSeq: twin.seq, reason: "偽の投稿", eraseBody: true }, { clock });
    await withdrawPost(db, { targetSeq: t.seq, reason: "権利者からの申し出", eraseBody: true }, { clock });
    expect((await db.query<{ h: string }>("SELECT erase_withdrawn_body($1) AS h", [t.seq])).rows[0]!.h).toBe(bodyHashOf(t));
    await chainIsIntact();
  });

  it("毎日の実行と同時に、成功する取り下げと断られる取り下げを流しても、連鎖が壊れず、書けたのは成功した1件だけ", async () => {
    const { clock, waitUntil, posts } = await setUp();
    const [a, b] = [posts[0]!, posts[1]!];
    await forgeTwin(clock, b); // b の本文は消せない
    clock.set(jst(NEXT_DAY, 7));
    const results = await Promise.allSettled([
      runDaily(NEXT_DAY, { db, clock, prepare: productionSetup, holidayTable, waitUntil }),
      withdrawPost(db, { targetSeq: a.seq, reason: "権利者からの申し出", eraseBody: true }, { clock }),
      withdrawPost(db, { targetSeq: b.seq, reason: "権利者からの申し出", eraseBody: true }, { clock }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    const events = await chainIsIntact();
    const ws = events.filter((e) => e.type === "content.withdrawn");
    expect(ws.map((e) => (e.payload as { targetSeq: number }).targetSeq)).toEqual([a.seq]);
    expect((await db.query<{ h: string }>("SELECT erase_withdrawn_body($1) AS h", [a.seq])).rows[0]!.h).toBe(bodyHashOf(a));
    await chainIsIntact();
  });

  // 欠陥（低）：本文の行があるかの確かめ（SELECT 1 FROM stored_values）が、追記のトランザクションの外にある。
  // 確かめたあと、書く前に本文が消されると、本文がないのに bodyErased = false の記録が書かれる（関数の説明では「何も書かない」）。
  // 運営者が erase_withdrawn_body と取り下げを同時に流したときだけ起きる。erase_body.sql の2つ目の文に missing として出る
  it.fails("本文を残す取り下げの確かめと書き込みの間に本文が消されたら、何も書かない", async () => {
    const { clock, posts } = await setUp();
    const t = posts[0]!;
    await withdrawPost(db, { targetSeq: t.seq, reason: "一つ目", eraseBody: true }, { clock });
    // 本文の行を確かめた直後に、別の運営者の手順が本文を消す
    const racing: SqlDb = {
      ...db,
      query: async (text, params) => {
        const r = await db.query(text, params);
        if (text.startsWith("SELECT 1 FROM stored_values")) await db.query("SELECT erase_withdrawn_body($1)", [t.seq]);
        return r as never;
      },
    };
    await withdrawPost(racing, { targetSeq: t.seq, reason: "本文を残す", eraseBody: false }, { clock }).catch(() => undefined);
    const last = (await readAllEvents(db)).at(-1)!;
    // 書かれていれば、本文の行がないのに bodyErased = false の記録になっている
    expect(await hasBody(bodyHashOf(t))).toBe(false);
    expect(last.payload).not.toMatchObject({ bodyErased: false });
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
