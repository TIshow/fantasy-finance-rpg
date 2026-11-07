// 取り下げのコマンド（daily withdraw。scripts/daily-lib.ts の withdrawPost。#166）の試験。PGlite（Docker なし）。
// 本番と同じ入口（productionSetup・runDaily）で書いた記録に取り下げを足し、照合（daily verify と同じ）が通ること、
// 読むだけの口（pg-reader）から作った画面のデータ（buildView・buildBoard）で非表示として出ること、
// アプリの接続（ffr_app）では書けないこと、理由・対象の誤りで何も書かないことを確かめる。
import { execFileSync } from "node:child_process";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { holidayTable } from "../../src/holidays";
import type { LogEvent } from "../../src/events/types";
import { readSnapshot } from "../../src/store/pg-reader";
import { PgEventStore, readAllEvents } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate, type SqlDb } from "../../src/store/sql";
import { buildBoard } from "../../src/view/board";
import { buildView } from "../../src/view/build";
import { isTableOwner, productionSetup, runDaily, verifyDatabase, withdrawPost, withdrawReasonProblem } from "../../scripts/daily-lib";
import { FakeClock, jst } from "../contracts/fakes";
import { openPglite, resetSchema } from "./pglite";

let pg: PGlite;
let db: SqlDb;
beforeAll(async () => {
  ({ pg, db } = await openPglite());
  await pg.exec("CREATE ROLE ffr_app");
}, 60_000);
afterAll(() => db.close());

const DAYS = ["2026-11-09", "2026-11-10"];
const count = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM events")).rows[0]!.n;

/** 2営業日を本番の入口で書き、投稿の一覧と時計を返す */
async function setUp() {
  await resetSchema(pg);
  await migrate(db); // ffr_app があるので、events・stored_values への SELECT と INSERT だけが与えられる
  const clock = new FakeClock(jst(DAYS[0]!, 7));
  const waitUntil = async (at: number) => void (at > clock.now() && clock.set(at));
  for (const d of DAYS) await runDaily(d, { db, clock, prepare: productionSetup, holidayTable, waitUntil });
  const events = await readAllEvents(db);
  const posts = events.filter((e) => e.type === "post.published");
  expect(posts.length).toBeGreaterThanOrEqual(1);
  return { clock, events, posts };
}

/** 読むだけの口から読み、画面のデータを作る */
async function screen() {
  const snap = await readSnapshot(db, { warn: () => undefined });
  return buildView(snap.events, snap.bodyOf);
}
const symbolOf = (p: LogEvent) => (p.payload as { board: string }).board;

describe("withdrawPost", { timeout: 60_000 }, () => {
  it("本文を残す取り下げ：記録の形・照合が通る・画面のデータで非表示（理由）として出る", async () => {
    const { clock, posts } = await setUp();
    const target = posts[0]!;
    // 取り下げる前は、本文が出ている
    expect((await screen()).timeline.find((t) => t.seq === target.seq)).toMatchObject({ withdrawn: null, text: expect.any(String) });
    clock.set(clock.now() + 1_000);
    const r = await withdrawPost(db, { targetSeq: target.seq, reason: "  事実と異なる内容  ", eraseBody: false }, { clock });

    const last = (await readAllEvents(db)).at(-1)!;
    expect(last).toMatchObject({ seq: r.seq, hash: r.hash, type: "content.withdrawn", actor: "operator:owner", refs: [target.seq], payload: { targetSeq: target.seq, reason: "事実と異なる内容", bodyErased: false } });
    expect((await verifyDatabase(db)).lastHash).toBe(r.hash);

    const view = await screen();
    expect(view.timeline.find((t) => t.seq === target.seq)).toMatchObject({ kind: "post", text: null, withdrawn: { seq: r.seq, reason: "事実と異なる内容" } });
    const board = buildBoard(view, symbolOf(target))!;
    expect(board.posts.find((p) => p.seq === target.seq)).toMatchObject({ text: null, withdrawn: "事実と異なる内容" });
  });

  it("本文を消す取り下げ：bodyErased 真で記録し、続けて erase_withdrawn_body で消しても照合が通り、画面は非表示のまま", async () => {
    const { clock, posts } = await setUp();
    const target = posts[0]!;
    const r = await withdrawPost(db, { targetSeq: target.seq, reason: "権利者からの申し出", eraseBody: true, operator: "owner" }, { clock });
    expect((await readAllEvents(db)).at(-1)!.payload).toEqual({ targetSeq: target.seq, reason: "権利者からの申し出", bodyErased: true });
    // 本文はまだ残っている（コマンドは消さない）
    const bodyHash = (target.payload as { bodyHash: string }).bodyHash;
    const has = async () => (await db.query("SELECT 1 FROM stored_values WHERE hash = $1", [bodyHash])).rows.length === 1;
    expect(await has()).toBe(true);

    const erased = (await db.query<{ h: string | null }>("SELECT erase_withdrawn_body($1) AS h", [target.seq])).rows[0]!.h;
    expect(erased).toBe(bodyHash);
    expect(await has()).toBe(false);
    expect((await verifyDatabase(db)).lastHash).toBe(r.hash);
    expect((await screen()).timeline.find((t) => t.seq === target.seq)).toMatchObject({ text: null, withdrawn: { reason: "権利者からの申し出" } });

    // 本文が消えたあとに、本文を残す記録で取り下げ直すことはできない（記録と保管が食い違うため）
    await expect(withdrawPost(db, { targetSeq: target.seq, reason: "理由の言い直し", eraseBody: false }, { clock })).rejects.toThrow(/no stored row/);
    // 本文を消す印つきなら書ける
    await withdrawPost(db, { targetSeq: target.seq, reason: "理由の言い直し", eraseBody: true }, { clock });
    await verifyDatabase(db);
  });

  it("アプリの接続（ffr_app）では書けない。表の持ち主の接続なら書ける", async () => {
    const { clock, posts } = await setUp();
    const before = await count();
    await pg.exec("SET ROLE ffr_app");
    try {
      expect(await isTableOwner(db)).toBe(false);
      await expect(withdrawPost(db, { targetSeq: posts[0]!.seq, reason: "誤り", eraseBody: false }, { clock })).rejects.toThrow(/table owner's connection/);
    } finally {
      await pg.exec("RESET ROLE");
    }
    expect(await count()).toBe(before);
    expect(await isTableOwner(db)).toBe(true);
  });

  it("対象が投稿でない・存在しない、理由が空・空白・ハッシュを含む・長すぎる、書き手の名前が不正なら、何も書かない", async () => {
    const { clock, events, posts } = await setUp();
    const before = await count();
    const notPost = events.find((e) => e.type !== "post.published")!;
    const go = (targetSeq: number, reason: string, operator?: string) => withdrawPost(db, { targetSeq, reason, eraseBody: false, operator }, { clock });
    await expect(go(notPost.seq, "誤り")).rejects.toThrow(/not post\.published/);
    await expect(go(before + 1, "誤り")).rejects.toThrow(/does not exist/);
    await expect(go(0, "誤り")).rejects.toThrow(/positive integer/);
    await expect(go(posts[0]!.seq, "")).rejects.toThrow(/--reason is required/);
    await expect(go(posts[0]!.seq, " \n\t ")).rejects.toThrow(/--reason is required/);
    await expect(go(posts[0]!.seq, `本文 ${(posts[0]!.payload as { bodyHash: string }).bodyHash} の申し出`)).rejects.toThrow(/hash-like/);
    await expect(go(posts[0]!.seq, "あ".repeat(201))).rejects.toThrow(/at most 200/);
    await expect(go(posts[0]!.seq, "誤り", "Owner Name")).rejects.toThrow(/operator/);
    expect(await count()).toBe(before);
  });
});

describe("withdrawPost の追加の守り", { timeout: 60_000 }, () => {
  const openStore = async (clock: FakeClock) => PgEventStore.open(db, { values: await PgValueStore.open(db), holidayTables: new Map([[holidayTable.contentSha256, holidayTable]]), clock });

  it("本文を消す印つきでも、ほかの記録が同じハッシュを指していて消せない本文なら、断って何も書かない", async () => {
    const { clock, posts } = await setUp();
    const target = posts[0]!;
    const hash = (target.payload as { bodyHash: string }).bodyHash;
    // コマンドを通さずに、理由にハッシュを書いた記録を足す（アプリの接続でもできること）
    const w = await (await openStore(clock)).append({ type: "content.withdrawn", actor: "operator:owner", refs: [target.seq], payload: { targetSeq: target.seq, reason: `本文 ${hash}`, bodyErased: false } });
    expect(w.ok).toBe(true);
    const before = await count();
    await expect(withdrawPost(db, { targetSeq: target.seq, reason: "権利者からの申し出", eraseBody: true }, { clock })).rejects.toThrow(/cannot be erased/);
    expect(await count()).toBe(before);
    await verifyDatabase(db);
    // 本文を残す取り下げなら書ける
    await withdrawPost(db, { targetSeq: target.seq, reason: "事実と異なる内容", eraseBody: false }, { clock });
    expect(await count()).toBe(before + 1);
  });

  it("投稿の bodyHash が64文字の16進でなければ断る", async () => {
    const { clock, posts } = await setUp();
    const src = posts[0]!;
    const forged = await (await openStore(clock)).append({ type: "post.published", actor: src.actor, refs: src.refs, payload: { ...(src.payload as Record<string, unknown>), bodyHash: "not-a-hash" } });
    if (!forged.ok) return expect.unreachable(`could not write the forged post: ${forged.reason}`);
    const before = await count();
    await expect(withdrawPost(db, { targetSeq: forged.event.seq, reason: "誤り", eraseBody: true }, { clock })).rejects.toThrow(/64-digit hex/);
    expect(await count()).toBe(before);
  });

  it("スーパーユーザーでない表の持ち主の接続でも書ける", async () => {
    const { clock, posts } = await setUp();
    await pg.exec("DROP ROLE IF EXISTS ffr_owner; CREATE ROLE ffr_owner NOSUPERUSER; GRANT USAGE, CREATE ON SCHEMA public TO ffr_owner; ALTER TABLE events OWNER TO ffr_owner; ALTER TABLE stored_values OWNER TO ffr_owner");
    await pg.exec("SET ROLE ffr_owner");
    try {
      expect(await isTableOwner(db)).toBe(true);
      await withdrawPost(db, { targetSeq: posts[0]!.seq, reason: "誤り", eraseBody: false }, { clock });
    } finally {
      await pg.exec("RESET ROLE");
    }
    await verifyDatabase(db);
  });
});

describe("withdrawReasonProblem", () => {
  it("空・空白・改行や制御文字・文字の向きを変える文字・ハッシュに見える文字列を断り、ふつうの理由は通す", () => {
    expect(withdrawReasonProblem(undefined)).toMatch(/required/);
    expect(withdrawReasonProblem("　")).toMatch(/required/); // 全角の空白だけ
    expect(withdrawReasonProblem("A".repeat(32).replace(/A/g, "f"))).toMatch(/hash-like/);
    expect(withdrawReasonProblem("事実と\n異なる")).toMatch(/control/);
    expect(withdrawReasonProblem("誤り\u0007")).toMatch(/control/);
    expect(withdrawReasonProblem("誤り‮りま")).toMatch(/bidirectional/);
    expect(withdrawReasonProblem("誤り⁦x⁩")).toMatch(/bidirectional/);
    expect(withdrawReasonProblem("2026年11月9日の投稿の誤り（seq 12345）")).toBeNull();
  });

  it("長さは文字の数で数え、ちょうど200文字は通り、201文字は断る", () => {
    expect(withdrawReasonProblem("あ".repeat(200))).toBeNull();
    expect(withdrawReasonProblem("😀".repeat(200))).toBeNull(); // UTF-16 では400単位だが、200文字
    expect(withdrawReasonProblem("😀".repeat(201))).toMatch(/at most 200/);
  });
});

describe("コマンド（scripts/daily.ts withdraw）の入口", () => {
  const run = (args: string[], env: Record<string, string> = {}) => {
    try {
      const out = execFileSync("node", ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", "./scripts/ts-loader.mjs", "scripts/daily.ts", ...args], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out, err: "" };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: x.stdout, err: x.stderr };
    }
  };

  it("理由・seq の誤りは終了コード2。アプリの接続だけなら1で、接続の文字列を出さない", () => {
    const app = { DATABASE_URL: "postgres://u:secret@127.0.0.1:1/x" };
    expect(run(["withdraw", "--seq", "5"], app)).toMatchObject({ code: 2, err: expect.stringContaining("--reason is required") });
    expect(run(["withdraw", "--seq", "5", "--reason", "   "], app)).toMatchObject({ code: 2, err: expect.stringContaining("--reason is required") });
    expect(run(["withdraw", "--seq", "5", "--reason", "f".repeat(64)], app)).toMatchObject({ code: 2, err: expect.stringContaining("hash-like") });
    expect(run(["withdraw", "--seq", "1.5", "--reason", "誤り"], app)).toMatchObject({ code: 2, err: expect.stringContaining("--seq") });
    const noAdmin = run(["withdraw", "--seq", "5", "--reason", "誤り"], app);
    expect(noAdmin).toMatchObject({ code: 1, err: expect.stringContaining("DATABASE_ADMIN_URL is not set") });
    expect(noAdmin.err).not.toContain("secret");
    const bad = run(["withdraw", "--seq", "5", "--reason", "誤り", "--erase-body"], { DATABASE_ADMIN_URL: "postgres://u:secret@127.0.0.1:1/x" });
    expect(bad.code).toBe(1);
    expect(bad.err + bad.out).not.toContain("secret");
  }, 90_000);
});
