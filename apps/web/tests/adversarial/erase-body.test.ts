// 検証（verifier、#157・PR #158）：投稿の本文を消す DB の関数 erase_withdrawn_body（db/003_erase_body.sql）を、実装とは別に確かめる。
// 文書（EVENT_LOG §5.2・§6.1、#25 の lead の決まり）から成り立つはずのこと：
// - 消せるのは、その本文のハッシュを使う投稿すべてで、運営者の最後の content.withdrawn の bodyErased が真の本文と乱数だけ
// - 価格などの値・AIの判断の出力の行・ほかの本文は、ffr_app からも持ち主からも（トリガを外さない限り）消せない
// - ffr_app は関数も DELETE も通らない。search_path・一時テーブル・別の schema の細工でも抜けられない
// - 消したあとも、イベントの行は変わらず、連鎖・daily verify（verifyDatabase）・保管の開き直し・毎日の実行（runDaily）が続けられる
// - 読むだけの口（src/store/pg-reader.ts の readSnapshot）は、消した本文を undefined として返し、例外にしない
// - migrate を何度流しても、消した本文は戻らず、守りも変わらない
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDaily, verifyDatabase } from "../../scripts/daily-lib";
import { verifyChain } from "../../src/events/chain";
import type { LogEvent } from "../../src/events/types";
import { holidayTable } from "../../src/holidays";
import { scheduleOf } from "../../src/runner/day";
import { readSnapshot } from "../../src/store/pg-reader";
import { PgEventStore, readAllEvents } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate, type SqlDb } from "../../src/store/sql";
import { FakeClock, jst } from "../contracts/fakes";
import { buildGoldenLog, FIXTURE_HOLIDAYS } from "../fixtures/golden";
import { openPglite, resetSchema } from "../store/pglite";

let pg: PGlite;
let db: SqlDb;
beforeAll(async () => {
  ({ pg, db } = await openPglite());
  await pg.exec("CREATE ROLE ffr_app; CREATE ROLE ffr_reader");
}, 60_000);
afterAll(() => db.close());

const p = (e: LogEvent) => e.payload as Record<string, unknown>;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const has = async (hash: string) => (await db.query("SELECT 1 FROM stored_values WHERE hash = $1", [hash])).rows.length === 1;
const erase = async (seq: number) => (await db.query<{ h: string | null }>("SELECT erase_withdrawn_body($1) AS h", [seq])).rows[0]!.h;
const valueRows = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM stored_values WHERE kind = 'value'")).rows[0]!.n;
/** ffr_app などの役割に切り替えて fn を動かし、必ず戻す */
async function as<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await pg.exec(`SET ROLE ${role}`);
  try {
    return await fn();
  } finally {
    await pg.exec("RESET ROLE; RESET search_path");
  }
}
const grantReader = () => pg.exec("GRANT USAGE ON SCHEMA public TO ffr_reader; GRANT SELECT ON events, stored_values TO ffr_reader");

// ---------------------------------------------------------------------------------------------
// ゴールデンログ（AI 3人・投稿11件・判断の出力22件）を入れた DB
const g = await buildGoldenLog(20261104);
const goldenPosts = g.events.filter((e) => e.type === "post.published");
const goldenRuns = g.events.filter((e) => e.type === "agent.run");

async function golden() {
  await resetSchema(pg);
  await migrate(db);
  for (const e of g.events) {
    await db.query("INSERT INTO events (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) VALUES ($1, 1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)", [e.seq, e.type, e.recordedAt, e.actor, JSON.stringify(e.keys), JSON.stringify(e.refs), JSON.stringify(e.payload), e.prevHash, e.hash]);
  }
  const fx = g.values as unknown as { values: Map<string, { salt: Uint8Array; value: unknown }> };
  for (const [hash, { salt, value }] of fx.values) await db.query("INSERT INTO stored_values VALUES ($1, 'value', $2, $3::jsonb)", [hash, hex(salt), JSON.stringify(value)]);
  for (const [hash, { salt, value }] of g.bodies) await db.query("INSERT INTO stored_values VALUES ($1, 'body', $2, $3::jsonb)", [hash, hex(salt), JSON.stringify(value)]);
  const store = await PgEventStore.open(db, { values: await PgValueStore.open(db), holidayTables: g.holidayTables, clock: new FakeClock(g.events.at(-1)!.recordedAt) });
  /** 検査を通る記録を足す（ffr_app の接続でもできること） */
  const append = async (type: "post.published" | "content.withdrawn", actor: string, refs: number[], payload: Record<string, unknown>) => {
    const r = await store.append({ type, actor, refs, payload } as never);
    if (!r.ok) throw new Error(r.reason);
    return (await store.last())!.seq;
  };
  const withdraw = (target: number, bodyErased = true) => append("content.withdrawn", "operator:owner", [target], { targetSeq: target, reason: "権利者からの申し出", bodyErased });
  return { append, withdraw };
}

describe("消せる行の範囲（ゴールデンログ）", { timeout: 60_000 }, () => {
  it.fails("【欠陥】判断の出力（agent.run の outputHash）を本文に指す投稿を、検査を通る形で足して非表示にすると、出力の行が消える", async () => {
    const { append, withdraw } = await golden();
    // ai-a の投稿用の run（seq 8）を runSeq にし、本文のハッシュに、ai-a の注文用の run（seq 10）の出力のハッシュを書く
    const postRun = goldenRuns.find((r) => p(r).agentId === "ai-a" && p(r).purpose === "post")!;
    const orderRun = goldenRuns.find((r) => p(r).agentId === "ai-a" && p(r).purpose === "order")!;
    const output = p(orderRun).outputHash as string;
    const forged = await append("post.published", "agent:ai-a", [postRun.seq], { agentId: "ai-a", board: "TSTB", bodyHash: output, citeSeqs: [], runSeq: postRun.seq });
    await withdraw(forged);
    // 記録はすべて検査を通っている（daily verify も通る）。そのうえで、関数は出力の行を消してしまう
    await verifyDatabase(db, FIXTURE_HOLIDAYS);
    await expect(erase(forged)).rejects.toThrow();
    expect(await has(output)).toBe(true);
  });

  it("価格などの値のハッシュを本文に指す投稿を作って非表示にしても、値の行は消えない（関数は本文の行だけを消す）", async () => {
    const { append, withdraw } = await golden();
    const postRun = goldenRuns.find((r) => p(r).agentId === "ai-a" && p(r).purpose === "post")!;
    const close = g.events.find((e) => e.type === "prices.close")!;
    const valuesHash = p(close).valuesHash as string;
    const forged = await append("post.published", "agent:ai-a", [postRun.seq], { agentId: "ai-a", board: "TSTB", bodyHash: valuesHash, citeSeqs: [], runSeq: postRun.seq });
    await withdraw(forged);
    const before = await valueRows();
    expect(await erase(forged)).toBeNull();
    expect(await has(valuesHash)).toBe(true);
    expect(await valueRows()).toBe(before);
    // 持ち主が印を自分で入れても、値の行は消せない
    await expect(db.transaction(async (tx) => {
      await tx.query("SELECT set_config('ffr.erase_body', $1, true)", [valuesHash]);
      await tx.query("DELETE FROM stored_values WHERE hash = $1", [valuesHash]);
    })).rejects.toThrow(/append-only/);
  });

  it("ほかの AI の投稿と同じ本文のハッシュを持つ投稿を作り、それだけを非表示にしても、元の投稿の本文は消えない", async () => {
    const { append, withdraw } = await golden();
    const victim = goldenPosts.find((e) => p(e).agentId === "ai-b")!;
    const postRun = goldenRuns.find((r) => p(r).agentId === "ai-a" && p(r).purpose === "post")!;
    const forged = await append("post.published", "agent:ai-a", [postRun.seq], { agentId: "ai-a", board: "TSTB", bodyHash: p(victim).bodyHash, citeSeqs: [], runSeq: postRun.seq });
    await withdraw(forged);
    await expect(erase(forged)).rejects.toThrow("may not be erased");
    expect(await has(p(victim).bodyHash as string)).toBe(true);
  });

  it("判断の出力の行と、非表示でない投稿の本文は、持ち主が印を入れて直接 DELETE しても消えない（トリガが断る）", async () => {
    await golden();
    for (const h of [p(goldenRuns[0]!).outputHash as string, p(goldenPosts[0]!).bodyHash as string]) {
      await expect(db.transaction(async (tx) => {
        await tx.query("SELECT set_config('ffr.erase_body', $1, true)", [h]);
        await tx.query("DELETE FROM stored_values WHERE hash = $1", [h]);
      })).rejects.toThrow(/append-only/);
      expect(await has(h)).toBe(true);
    }
    // 一度に全部消す DELETE も、1行目で断られて何も消えない
    const n = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM stored_values")).rows[0]!.n;
    await expect(pg.exec("DELETE FROM stored_values")).rejects.toThrow(/append-only/);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM stored_values")).rows[0]!.n).toBe(n);
  });
});

describe("ffr_app からの細工", { timeout: 60_000 }, () => {
  it("一時テーブル・search_path・印の設定を使っても、関数も DELETE も通らず、本文は残る", async () => {
    const { withdraw } = await golden();
    const target = goldenPosts[0]!;
    await withdraw(target.seq);
    const h = p(target).bodyHash as string;
    await as("ffr_app", async () => {
      await expect(erase(target.seq)).rejects.toThrow(/permission denied/);
      await expect(db.query("SELECT public.erase_withdrawn_body($1)", [target.seq])).rejects.toThrow(/permission denied/);
      await expect(db.transaction(async (tx) => {
        await tx.query("SELECT set_config('ffr.erase_body', $1, true)", [h]);
        await tx.query("DELETE FROM public.stored_values WHERE hash = $1", [h]);
      })).rejects.toThrow(/permission denied/);
      // 一時テーブルで表を装い、search_path をそちらに向けても、本物の表には届かない
      await pg.exec("CREATE TEMP TABLE stored_values (hash text, kind text, salt text, content jsonb); CREATE TEMP TABLE events (seq bigint, type text, actor text, payload jsonb)");
      await pg.exec("SET search_path = pg_temp, public");
      await expect(erase(target.seq)).rejects.toThrow(/permission denied/);
      await db.query("DELETE FROM stored_values"); // 自分の一時テーブルだけが空になる
      await expect(db.query("TRUNCATE public.stored_values")).rejects.toThrow(/permission denied/);
      // 関数・schema を作って差し替えることもできない
      await expect(pg.exec("CREATE FUNCTION public.stored_values_erasable(sch text, h text) RETURNS boolean LANGUAGE sql AS 'SELECT true'")).rejects.toThrow(/permission denied/);
      await expect(pg.exec("CREATE SCHEMA ffr_app")).rejects.toThrow(/permission denied/);
      await expect(pg.exec("ALTER TABLE public.stored_values DISABLE TRIGGER USER")).rejects.toThrow(/must be owner/);
      await pg.exec("DROP TABLE pg_temp.stored_values, pg_temp.events");
    });
    expect(await has(h)).toBe(true);
  });

  it("持ち主の接続に一時テーブルの events があっても、関数は本物の表で条件を見る", async () => {
    await golden();
    const kept = goldenPosts[1]!;
    await pg.exec("CREATE TEMP TABLE events AS SELECT * FROM public.events");
    await pg.exec(`INSERT INTO pg_temp.events (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) SELECT seq + 1, 1, 'content.withdrawn', recorded_at, 'operator:owner', '[]', '[]', '{"targetSeq": ${kept.seq}, "reason": "x", "bodyErased": true}', hash, hash FROM public.events ORDER BY seq DESC LIMIT 1`);
    try {
      await expect(erase(kept.seq)).rejects.toThrow("may not be erased");
    } finally {
      await pg.exec("DROP TABLE pg_temp.events");
    }
    expect(await has(p(kept).bodyHash as string)).toBe(true);
  });
});

describe("migrate を流し直したとき", { timeout: 60_000 }, () => {
  it("消した本文は戻らず、トリガと関数の権限も元のまま。誤って与えた実行・削除の権限は外れる", async () => {
    const { withdraw } = await golden();
    const target = goldenPosts[0]!;
    await withdraw(target.seq);
    expect(await erase(target.seq)).toBe(p(target).bodyHash);
    const triggers = async () => (await db.query<{ t: string }>("SELECT tgname || ':' || tgtype::text || ':' || tgenabled::text AS t FROM pg_trigger WHERE tgrelid = 'public.stored_values'::regclass AND NOT tgisinternal ORDER BY 1")).rows.map((r) => r.t);
    const before = await triggers();
    expect(before).toHaveLength(3); // 更新の見張り・削除の見張り・TRUNCATE の見張り
    await pg.exec("GRANT EXECUTE ON FUNCTION erase_withdrawn_body(bigint) TO PUBLIC; GRANT EXECUTE ON FUNCTION erase_withdrawn_body(bigint) TO ffr_app; GRANT DELETE, UPDATE, TRUNCATE ON stored_values TO ffr_app");
    await migrate(db);
    await migrate(db);
    expect(await has(p(target).bodyHash as string)).toBe(false);
    expect(await triggers()).toEqual(before);
    const kept = goldenPosts[1]!;
    await as("ffr_app", async () => {
      await expect(erase(target.seq)).rejects.toThrow(/permission denied/);
      await expect(db.query("DELETE FROM stored_values WHERE hash = $1", [p(kept).bodyHash])).rejects.toThrow(/permission denied/);
    });
    await expect(erase(kept.seq)).rejects.toThrow("may not be erased");
    expect(await verifyChain(await readAllEvents(db))).toEqual([]);
    await verifyDatabase(db, FIXTURE_HOLIDAYS);
  });
});

describe("読むだけの口（readSnapshot）", { timeout: 60_000 }, () => {
  it("SELECT だけの役割で、消したあとに読んでも例外にならず、消した本文だけが undefined になる。その役割は関数を呼べない", async () => {
    const { withdraw } = await golden();
    await grantReader();
    const target = goldenPosts[0]!;
    await withdraw(target.seq);
    await erase(target.seq);
    const warnings: string[] = [];
    const snap = await as("ffr_reader", async () => {
      await expect(erase(target.seq)).rejects.toThrow(/permission denied/);
      return readSnapshot(db, { holidayTables: [FIXTURE_HOLIDAYS], warn: (m) => warnings.push(m) });
    });
    expect(warnings).toEqual([]);
    expect(snap.bodyOf(p(target).bodyHash as string)).toBeUndefined();
    for (const e of goldenPosts.slice(1)) expect(snap.bodyOf(p(e).bodyHash as string)).toBe(g.bodies.get(p(e).bodyHash as string)!.value);
    expect(snap.events.find((e) => e.seq === target.seq)).toBeDefined();
    expect(snap.lastHash).toBe((await readAllEvents(db)).at(-1)!.hash);
  });
});

// ---------------------------------------------------------------------------------------------
// 本番の準備のまま（架空の6社）、毎日の実行を回す DB
const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11"];
const holidayTables = new Map([[holidayTable.contentSha256, holidayTable]]);
function world() {
  const clock = new FakeClock(jst(DAYS[0]!, 6, 50));
  const waitUntil = async (at: number) => {
    if (at > clock.now()) clock.set(at);
  };
  return { clock, waitUntil };
}
const opts = (w: ReturnType<typeof world>, over: Partial<Parameters<typeof runDaily>[1]> = {}) => ({ db, clock: w.clock, waitUntil: w.waitUntil, holidayTable, ...over });

async function withdrawAndErase(clock: FakeClock, posts: readonly LogEvent[]) {
  const store = await PgEventStore.open(db, { values: await PgValueStore.open(db), holidayTables, clock });
  for (const post of posts) {
    const r = await store.append({ type: "content.withdrawn", actor: "operator:owner", refs: [post.seq], payload: { targetSeq: post.seq, reason: "権利者からの申し出", bodyErased: true } });
    if (!r.ok) throw new Error(r.reason);
  }
  const before = await readAllEvents(db);
  for (const post of posts) expect(await erase(post.seq)).toBe(p(post).bodyHash);
  expect(await readAllEvents(db)).toEqual(before);
}

describe("消したあとも毎日の実行を続けられる", { timeout: 120_000 }, () => {
  it("1日目の投稿の本文を消したあと、同じ日の回し直しは何も書かず、次の日以降も進み、照合と読むだけの口が通る", async () => {
    await resetSchema(pg);
    await migrate(db);
    const w = world();
    await runDaily(DAYS[0]!, opts(w));
    const posts = (await readAllEvents(db)).filter((e) => e.type === "post.published");
    expect(posts.length, "1日目に投稿がない（試験の前提が崩れた）").toBeGreaterThan(0);
    await withdrawAndErase(w.clock, posts);
    const n = (await readAllEvents(db)).length;
    await runDaily(DAYS[0]!, opts(w));
    expect((await readAllEvents(db)).length).toBe(n);
    for (const d of DAYS.slice(1)) {
      await runDaily(d, opts(w));
      const m = (await readAllEvents(db)).length;
      await runDaily(d, opts(w));
      expect((await readAllEvents(db)).length).toBe(m);
    }
    const events = await readAllEvents(db);
    expect(events.filter((e) => e.type === "valuation.recorded" && p(e).date === DAYS.at(-1)).length).toBeGreaterThan(0);
    expect(await verifyChain(events)).toEqual([]);
    expect((await verifyDatabase(db, holidayTable)).lastHash).toBe(events.at(-1)!.hash);
    const snap = await readSnapshot(db, { warn: () => undefined });
    for (const post of posts) expect(snap.bodyOf(p(post).bodyHash as string)).toBeUndefined();
    expect(snap.lastHash).toBe(events.at(-1)!.hash);
  });

  it("その日の判断と投稿のあと、寄り付きの前に落ち、その間に本文を消しても、回し直すとその日を最後まで進める", async () => {
    await resetSchema(pg);
    await migrate(db);
    const w = world();
    const d = DAYS[0]!;
    const stop = (at: number) => (at === scheduleOf(d).openAt ? Promise.reject(new Error("crash")) : w.waitUntil(at));
    await expect(runDaily(d, opts(w, { waitUntil: stop }))).rejects.toThrow("crash");
    const today = (await readAllEvents(db)).filter((e) => e.type === "post.published" && e.recordedAt >= jst(d, 0));
    expect(today.length, "1日目の判断で投稿がない（試験の前提が崩れた）").toBeGreaterThan(0);
    await withdrawAndErase(w.clock, today);
    await runDaily(d, opts(w));
    const events = await readAllEvents(db);
    expect(events.filter((e) => e.type === "valuation.recorded" && p(e).date === d).length).toBeGreaterThan(0);
    // 同じ投稿を書き直していない（run ごとに投稿は1つ）
    const perRun = new Map<number, number>();
    for (const e of events.filter((x) => x.type === "post.published")) perRun.set(p(e).runSeq as number, (perRun.get(p(e).runSeq as number) ?? 0) + 1);
    expect([...perRun.values()].every((c) => c === 1)).toBe(true);
    await verifyDatabase(db, holidayTable);
  });

  it.fails("【欠陥の影響】注文票の確定の前に落ち、その間にその日の判断の出力（runner が回し直しで読み直す、最初の run の出力）を偽の投稿を通して消されると、同じ日の回し直しが止まる", async () => {
    // 1回目：投稿がある最初の日と、その日に投稿する AI を探す（規則の AI なので、毎回同じ）
    await resetSchema(pg);
    await migrate(db);
    const a = world();
    for (const x of DAYS) await runDaily(x, opts(a));
    const poster = (await readAllEvents(db)).find((e) => e.type === "post.published");
    expect(poster, "投稿がない（試験の前提が崩れた）").toBeDefined();
    const id = p(poster!).agentId as string;
    const d = DAYS.filter((x) => jst(x, 0) <= poster!.recordedAt).at(-1)!;
    // 2回目：その日のその AI の注文票の確定で落とす（投稿と判断の記録は書いたあと）
    await resetSchema(pg);
    await migrate(db);
    const w = world();
    for (const x of DAYS.slice(0, DAYS.indexOf(d))) await runDaily(x, opts(w));
    let armed = true;
    const hit = (t: string, q?: readonly unknown[]) => armed && t.startsWith("INSERT INTO events") && q?.[2] === "order_sheet.committed" && q.some((v) => typeof v === "string" && v.includes(`"agentId":"${id}"`));
    const crashing: SqlDb = { ...db, transaction: (fn) => db.transaction((tx) => fn({ ...tx, query: (t, q) => (hit(t, q) ? ((armed = false), Promise.reject(new Error("crash"))) : tx.query(t, q)) })) };
    await expect(runDaily(d, opts(w, { db: crashing }))).rejects.toThrow("crash");
    const events = await readAllEvents(db);
    const today = events.filter((e) => e.type === "agent.run" && p(e).agentId === id && e.recordedAt >= jst(d, 0));
    const postRun = today.find((e) => p(e).purpose === "post")!;
    const orderRun = today.find((e) => p(e).purpose === "order")!;
    expect(events.some((e) => e.type === "order_sheet.committed" && p(e).runSeq === orderRun.seq)).toBe(false);
    const store = await PgEventStore.open(db, { values: await PgValueStore.open(db), holidayTables, clock: w.clock });
    const r = await store.append({ type: "post.published", actor: `agent:${id}`, refs: [postRun.seq], payload: { agentId: id, board: p(poster!).board, bodyHash: p(postRun).outputHash, citeSeqs: [], runSeq: postRun.seq } } as never);
    expect(r.ok).toBe(true);
    const forged = (await store.last())!;
    await withdrawAndErase(w.clock, [forged]);
    await runDaily(d, opts(w)); // いまは "output of run N is not available" で止まる
  });
});
