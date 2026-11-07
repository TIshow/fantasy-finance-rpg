// 検証（verifier、#157・PR #158）：投稿の本文を消す DB の関数 erase_withdrawn_body（db/003_erase_body.sql）を、実装とは別に確かめる。
// 文書（EVENT_LOG §5.2・§6.1、#25 の lead の決まり）から成り立つはずのこと：
// - 消せるのは、その本文のハッシュを使う投稿すべてで、運営者の最後の content.withdrawn の bodyErased が真の本文と乱数だけ
// - 価格などの値・AIの判断の出力の行・ほかの本文は、ffr_app からも持ち主からも（トリガを外さない限り）消せない
// - ffr_app は関数も DELETE も通らない。search_path・一時テーブル・別の schema の細工でも抜けられない
// - 消したあとも、イベントの行は変わらず、連鎖・daily verify（verifyDatabase）・保管の開き直し・毎日の実行（runDaily）が続けられる
// - 読むだけの口（src/store/pg-reader.ts の readSnapshot）は、消した本文を undefined として返し、例外にしない
// - migrate を何度流しても、消した本文は戻らず、守りも変わらない
import { readFileSync } from "node:fs";
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
    // 一時テーブルを作った試験が途中で落ちても、次の試験に残さない
    await pg.exec("RESET ROLE; RESET search_path; DISCARD TEMP");
  }
}
/** 断られても先へ進める手順（どの段で断っても、結果だけで判定するため） */
const attempt = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await fn();
  } catch {
    return undefined;
  }
};
const bodyRows = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM stored_values WHERE kind = 'body'")).rows[0]!.n;
/** 手順書（db/ops/erase_body.sql）の文（コメントの行を除き、; で分ける） */
const opsStatements = () =>
  readFileSync(new URL("../../db/ops/erase_body.sql", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("--"))
    .join("\n")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
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
  // PR #163 で直った欠陥（関数が判断の出力の行を消せた）の試験。途中の手順は断られても先へ進み、結果（行が残る）で判定する
  it("判断の出力（agent.run の outputHash）を本文に指す投稿を足して非表示にしても、関数は出力の行を消さない", async () => {
    const { append, withdraw } = await golden();
    // ai-a の投稿用の run を runSeq にし、本文のハッシュに、ai-a の注文用の run の出力のハッシュを書く
    const postRun = goldenRuns.find((r) => p(r).agentId === "ai-a" && p(r).purpose === "post");
    const orderRun = goldenRuns.find((r) => p(r).agentId === "ai-a" && p(r).purpose === "order");
    expect(postRun && orderRun, "ゴールデンログに ai-a の run がない").toBeTruthy();
    const output = p(orderRun!).outputHash as string;
    expect(await has(output), "出力の行が最初からない").toBe(true);
    await verifyDatabase(db, FIXTURE_HOLIDAYS);
    const rowsBefore = await bodyRows();
    const forged = await attempt(() => append("post.published", "agent:ai-a", [postRun!.seq], { agentId: "ai-a", board: "TSTB", bodyHash: output, citeSeqs: [], runSeq: postRun!.seq }));
    if (forged !== undefined) {
      await attempt(() => withdraw(forged));
      await attempt(() => erase(forged));
    }
    expect(await has(output)).toBe(true);
    expect(await bodyRows()).toBe(rowsBefore);
    await verifyDatabase(db, FIXTURE_HOLIDAYS);
  });

  it("価格などの値のハッシュを本文に指す投稿を作って非表示にしても、値の行は消えない（関数は本文の行だけを消す）", async () => {
    const { append, withdraw } = await golden();
    const postRun = goldenRuns.find((r) => p(r).agentId === "ai-a" && p(r).purpose === "post")!;
    const close = g.events.find((e) => e.type === "prices.close")!;
    const valuesHash = p(close).valuesHash as string;
    const before = await valueRows();
    // 投稿・非表示・関数の呼び出しが受け付けられるかは問わない（どの段で断っても、値が残ればよい）
    const forged = await attempt(() => append("post.published", "agent:ai-a", [postRun.seq], { agentId: "ai-a", board: "TSTB", bodyHash: valuesHash, citeSeqs: [], runSeq: postRun.seq }));
    if (forged !== undefined) {
      await attempt(() => withdraw(forged));
      await attempt(() => erase(forged));
    }
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

/** 検査を通さずに、連鎖だけが続く行を直接入れる（ffr_app でもできること。ハッシュは正しくない）。payload は JSON の文字列 */
async function insertRaw(type: string, actor: string, payloadJson: string, keys: string[] = []) {
  const last = (await db.query<{ seq: string; hash: string; recorded_at: string }>("SELECT seq, hash, recorded_at FROM events ORDER BY seq DESC LIMIT 1")).rows[0]!;
  const seq = Number(last.seq) + 1;
  await db.query("INSERT INTO events (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) VALUES ($1, 1, $2, $3, $4, $5::jsonb, '[]'::jsonb, $6::jsonb, $7, $8)", [seq, type, Number(last.recorded_at), actor, JSON.stringify(keys), payloadJson, last.hash, seq.toString(16).padStart(64, "f")]);
  return seq;
}

describe("PR #163 の守り（ほかの記録が指す本文は消せない）を突く", { timeout: 60_000 }, () => {
  /**
   * 本文の項目に、別の書き方（接頭辞つき・入れ子）で同じハッシュを持つ投稿を、run の seq が runSeq の投稿用の run を指して足し、
   * 本物の投稿だけを非表示にして関数を呼ぶ。本文が残ったかを返す
   */
  async function craftAndErase(runSeq: (target: LogEvent) => LogEvent) {
    const { append, withdraw } = await golden();
    const target = goldenPosts[0]!;
    const h = p(target).bodyHash as string;
    const run = runSeq(target);
    const agentId = p(run).agentId as string;
    // 検査を通る形で足せる（本文のハッシュの形は検査されない）。daily verify も通る
    const seqs: number[] = [];
    for (const bodyHash of [`sha256:${h}`, { x: h }]) {
      const seq = await attempt(() => append("post.published", `agent:${agentId}`, [run.seq], { agentId, board: "TSTB", bodyHash, citeSeqs: [], runSeq: run.seq }));
      if (seq !== undefined) seqs.push(seq);
    }
    expect(seqs, "細工した投稿を足せなかった（試験の前提が崩れた）").toHaveLength(2);
    await verifyDatabase(db, FIXTURE_HOLIDAYS);
    // 細工した投稿は非表示にしない。本物の投稿だけを、本文を消すとして非表示にする
    await withdraw(target.seq);
    await attempt(() => erase(target.seq));
    return has(h);
  }
  const runOf = (post: LogEvent) => goldenRuns.find((r) => r.seq === p(post).runSeq)!;

  // PR #158 で it.fails にしたもの。PR #182 の途中の版では run_has_many_posts で断っていたが、#179 の lead の判断 6（案A、7f7406e）で、
  // 本文は消すことになった（別の書き方の投稿は、もともと本文を引けない。下の「影響の範囲」）。判断の出力は残り、手順書に出る
  it("本物の投稿と同じ run を指す、別の書き方の投稿があっても、本物の投稿の本文は消える。判断の出力は残り、手順書の確かめに出る（案A）", async () => {
    const target = goldenPosts[0]!;
    const run = runOf(target);
    expect(await craftAndErase(runOf)).toBe(false);
    const outputs = goldenRuns.filter((r) => p(r).agentId === p(run).agentId && JSON.stringify(p(r).inputSeqs) === JSON.stringify(p(run).inputSeqs)).map((r) => p(r).outputHash as string);
    expect(outputs.length).toBeGreaterThan(0);
    for (const h of outputs) expect(await has(h)).toBe(true);
    const problems = (await db.query<{ seq: number; problem: string }>(opsStatements()[1]!)).rows.filter((r) => Number(r.seq) === target.seq).map((r) => r.problem);
    expect(problems).toEqual(["output_unverifiable"]);
  });

  // 上の形を、細工した投稿が別の判断の run を指すように変えると、まだ消える
  // 前半（通常の it）が前提を確かめて手順を進め、結果を残す。後半（it.fails）は結果だけを見る。前提が崩れれば前半が赤になる
  const crafted: { ran?: boolean; kept?: boolean } = {};
  it("【欠陥・低の前提】別の書き方の投稿が、本物の投稿とは別の判断（別の AI）の投稿用の run を指すとき", async () => {
    const other = (target: LogEvent) => runOf(goldenPosts.find((e) => p(e).agentId !== p(target).agentId)!);
    crafted.kept = await craftAndErase(other);
    crafted.ran = true;
  });
  it.fails("【欠陥・低】上の状態で、別の書き方の投稿は件数にもほかの記録にも数えられず、本文が消える（直れば本文が残る）", () => {
    expect(crafted.ran, "前提の試験が動いていない").toBe(true);
    expect(crafted.kept).toBe(true);
  });

  it("（上の欠陥の影響の範囲）別の書き方の投稿は、消す前から本文を引けない。画面と読むだけの口は、ハッシュと完全に一致するときだけ本文を引くため", async () => {
    const { append } = await golden();
    const h = p(goldenPosts[0]!).bodyHash as string;
    const postRun = goldenRuns.find((r) => p(r).agentId === "ai-a" && p(r).purpose === "post")!;
    await append("post.published", "agent:ai-a", [postRun.seq], { agentId: "ai-a", board: "TSTB", bodyHash: `sha256:${h}`, citeSeqs: [], runSeq: postRun.seq });
    const snap = await readSnapshot(db, { holidayTables: [FIXTURE_HOLIDAYS], warn: () => undefined });
    expect(snap.bodyOf(h)).toBeDefined();
    expect(snap.bodyOf(`sha256:${h}`)).toBeUndefined();
  });

  it("投稿でない記録の、オブジェクトでない中身（文字列・配列）や keys に同じハッシュがあれば断る。オブジェクトでない行が混じっても関数は止まらない", async () => {
    const { withdraw } = await golden();
    const [a, b, c] = goldenPosts as [LogEvent, LogEvent, LogEvent];
    for (const t of [a, b, c]) await withdraw(t.seq);
    const ha = p(a).bodyHash as string;
    const hb = p(b).bodyHash as string;
    // 関数が止まらないこと：中身が null・数・真偽値の行
    for (const j of ["null", "123", "true", '"text"', "[]"]) await insertRaw("source.captured", "system", j);
    await insertRaw("post.published", "agent:ai-a", "null");
    await insertRaw("source.captured", "system", JSON.stringify(`copy of ${ha}`));
    await insertRaw("agent.run", "system", JSON.stringify([{ nested: [ha] }]));
    await insertRaw("source.captured", "system", "{}", [`body:${hb}`]);
    await expect(erase(a.seq)).rejects.toThrow("may not be erased");
    await expect(erase(b.seq)).rejects.toThrow("may not be erased");
    expect(await has(ha)).toBe(true);
    expect(await has(hb)).toBe(true);
    expect(await erase(c.seq)).toBe(p(c).bodyHash);
  });

  it("（いまの決まり）運営者が非表示の理由にその本文のハッシュを書くと、その本文は二度と消せなくなる", async () => {
    const { append } = await golden();
    const t = goldenPosts[0]!;
    const h = p(t).bodyHash as string;
    await append("content.withdrawn", "operator:owner", [t.seq], { targetSeq: t.seq, reason: `本文 ${h} の権利者からの申し出`, bodyErased: true });
    await expect(erase(t.seq)).rejects.toThrow("may not be erased");
    expect(await has(h)).toBe(true);
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
    }); // 一時テーブルは as の finally（DISCARD TEMP）で消える
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
      await pg.exec("DISCARD TEMP");
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

  // PR #163 で直った欠陥の影響（判断の出力が消され、同じ日の回し直しが止まった）の試験
  it("注文票の確定の前に落ち、その間にその日の判断の出力を指す偽の投稿を非表示にして関数を呼ばれても、同じ日の回し直しが最後まで進む", async () => {
    // 1回目：投稿がある最初の日と、その日に投稿する AI を探す（規則の AI なので、毎回同じ）
    await resetSchema(pg);
    await migrate(db);
    const a = world();
    for (const x of DAYS) await runDaily(x, opts(a));
    const poster = (await readAllEvents(db)).find((e) => e.type === "post.published");
    expect(poster, "投稿がない").toBeDefined();
    const id = p(poster!).agentId as string;
    const d = DAYS.filter((x) => jst(x, 0) <= poster!.recordedAt).at(-1)!;
    // 2回目：その日のその AI の注文票の確定で、1回だけ落とす（投稿と判断の記録は書いたあと）。
    // 当たりの判定は値の位置に頼らず、INSERT の値に order_sheet.committed とその AI の ID が入っているかで見る
    await resetSchema(pg);
    await migrate(db);
    const w = world();
    for (const x of DAYS.slice(0, DAYS.indexOf(d))) await runDaily(x, opts(w));
    let hits = 0;
    const hit = (t: string, q?: readonly unknown[]) => {
      if (hits > 0 || !t.startsWith("INSERT INTO events") || !q) return false;
      const vals = q.filter((v): v is string => typeof v === "string");
      return vals.includes("order_sheet.committed") && vals.some((v) => v.includes(`"agentId":"${id}"`));
    };
    const crashing: SqlDb = { ...db, transaction: (fn) => db.transaction((tx) => fn({ ...tx, query: (t, q) => (hit(t, q) ? (hits++, Promise.reject(new Error("crash"))) : tx.query(t, q)) })) };
    await expect(runDaily(d, opts(w, { db: crashing }))).rejects.toThrow("crash");
    expect(hits, "仕込んだ失敗が1回だけ起きていない").toBe(1);
    const events = await readAllEvents(db);
    const today = events.filter((e) => e.type === "agent.run" && p(e).agentId === id && e.recordedAt >= jst(d, 0));
    const postRun = today.find((e) => p(e).purpose === "post");
    const orderRun = today.find((e) => p(e).purpose === "order");
    expect(postRun && orderRun, "その日の投稿用と注文用の run がない").toBeTruthy();
    expect(events.some((e) => e.type === "order_sheet.committed" && p(e).runSeq === orderRun!.seq), "注文票が確定済み").toBe(false);
    // ここから先の手順は、断られても先へ進む（どこで直しても、回し直しが進めばよい）
    const store = await PgEventStore.open(db, { values: await PgValueStore.open(db), holidayTables, clock: w.clock });
    const r = await attempt(() => store.append({ type: "post.published", actor: `agent:${id}`, refs: [postRun!.seq], payload: { agentId: id, board: p(poster!).board, bodyHash: p(postRun!).outputHash, citeSeqs: [], runSeq: postRun!.seq } } as never));
    if (r?.ok) {
      const forged = (await store.last())!;
      await attempt(() => store.append({ type: "content.withdrawn", actor: "operator:owner", refs: [forged.seq], payload: { targetSeq: forged.seq, reason: "権利者からの申し出", bodyErased: true } }));
      await attempt(() => erase(forged.seq));
    }
    await runDaily(d, opts(w));
    expect((await readAllEvents(db)).some((e) => e.type === "valuation.recorded" && p(e).date === d)).toBe(true);
    await verifyDatabase(db, holidayTable);
  });
});
