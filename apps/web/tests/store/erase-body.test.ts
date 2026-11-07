// 非表示にした投稿の本文を消す手続き（#25 PR-3。db/003_erase_body.sql、EVENT_LOG §5.2・§6.1）の試験。PGlite（Docker なし）。
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyDatabase } from "../../scripts/daily-lib";
import { canonicalize } from "../../src/events/canonical";
import { verifyChain } from "../../src/events/chain";
import { bodyHash } from "../../src/events/hash";
import { PgEventStore, readAllEvents } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate, type SqlDb } from "../../src/store/sql";
import { FakeClock } from "../contracts/fakes";
import { buildGoldenLog, FIXTURE_HOLIDAYS } from "../fixtures/golden";
import { openPglite, resetSchema } from "./pglite";

let pg: PGlite;
let db: SqlDb;
beforeAll(async () => {
  ({ pg, db } = await openPglite());
  await pg.exec("CREATE ROLE ffr_app; CREATE ROLE ffr_reader");
}, 60_000);
afterAll(() => db.close());

const g = await buildGoldenLog(20261104);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const posts = g.events.filter((e) => e.type === "post.published");
const bodyOf = (seq: number) => (g.events[seq - 1]!.payload as { bodyHash: string }).bodyHash;
/** 投稿の元になった判断（agent.run）の出力のハッシュと、同じ判断（同じ AI・同じ入力）の注文の出力のハッシュ */
const runOf = (seq: number) => g.events[(g.events[seq - 1]!.payload as { runSeq: number }).runSeq - 1]!;
const outputOf = (seq: number) => (runOf(seq).payload as { outputHash: string }).outputHash;
const orderOutputOf = (seq: number) => {
  const r = runOf(seq).payload as { agentId: string; inputSeqs: number[] };
  const order = g.events.find((e) => e.type === "agent.run" && (e.payload as { purpose: string }).purpose === "order" && (e.payload as { agentId: string }).agentId === r.agentId && JSON.stringify((e.payload as { inputSeqs: number[] }).inputSeqs) === JSON.stringify(r.inputSeqs))!;
  return (order.payload as { outputHash: string }).outputHash;
};
const has = async (hash: string) => (await db.query("SELECT 1 FROM stored_values WHERE hash = $1", [hash])).rows.length === 1;
const erase = async (seq: number) => (await db.query<{ h: string | null }>("SELECT erase_withdrawn_body($1) AS h", [seq])).rows[0]!.h;

/** ゴールデンログの行・値・本文を DB に入れ、post[0] を本文ごと非表示、post[1] を本文は残して非表示にする */
async function setUp() {
  await resetSchema(pg);
  await migrate(db);
  for (const e of g.events) {
    await db.query("INSERT INTO events (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) VALUES ($1, 1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)", [e.seq, e.type, e.recordedAt, e.actor, JSON.stringify(e.keys), JSON.stringify(e.refs), JSON.stringify(e.payload), e.prevHash, e.hash]);
  }
  const fx = g.values as unknown as { values: Map<string, { salt: Uint8Array; value: unknown }> };
  for (const [hash, { salt, value }] of fx.values) await db.query("INSERT INTO stored_values VALUES ($1, 'value', $2, $3::jsonb)", [hash, hex(salt), JSON.stringify(value)]);
  for (const [hash, { salt, value }] of g.bodies) await db.query("INSERT INTO stored_values VALUES ($1, 'body', $2, $3::jsonb)", [hash, hex(salt), JSON.stringify(value)]);
  const open = async () => PgEventStore.open(db, { values: await PgValueStore.open(db), holidayTables: g.holidayTables, clock: new FakeClock(g.events.at(-1)!.recordedAt) });
  const store = await open();
  for (const [p, bodyErased] of [[posts[0]!, true], [posts[1]!, false]] as const) {
    const r = await store.append({ type: "content.withdrawn", actor: "operator:owner", refs: [p.seq], payload: { targetSeq: p.seq, reason: "権利者からの申し出", bodyErased } });
    expect(r.ok).toBe(true);
  }
  const withdraw = async (p: number, bodyErased: boolean) => expect((await store.append({ type: "content.withdrawn", actor: "operator:owner", refs: [p], payload: { targetSeq: p, reason: "再度の申し出", bodyErased } })).ok).toBe(true);
  return { open, withdraw, erased: posts[0]!.seq, kept: posts[1]!.seq, untouched: posts[2]!.seq };
}

/** 検査を通さずに、連鎖だけが続く行を直接入れる（ffr_app でもできること。ハッシュは正しくない） */
async function insertRaw(type: string, actor: string, payload: unknown, keys: unknown[] = []) {
  const last = (await db.query<{ seq: string; hash: string; recorded_at: string }>("SELECT seq, hash, recorded_at FROM events ORDER BY seq DESC LIMIT 1")).rows[0]!;
  const seq = Number(last.seq) + 1;
  await db.query("INSERT INTO events (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) VALUES ($1, 1, $2, $3, $4, $8::jsonb, '[]'::jsonb, $5::jsonb, $6, $7)", [seq, type, Number(last.recorded_at), actor, JSON.stringify(payload), last.hash, seq.toString(16).padStart(64, "f"), JSON.stringify(keys)]);
}

/** 運営者の手順の SQL の文（コメントの行を除き、; で分ける） */
const opsStatements = () =>
  readFileSync(new URL("../../db/ops/erase_body.sql", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("--"))
    .join("\n")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

describe("erase_withdrawn_body", () => {
  it("bodyErased が真の投稿の本文と乱数だけを消し、連鎖は壊れず、保管を開き直せて照合も通る", async () => {
    const { open, erased } = await setUp();
    const before = await readAllEvents(db);
    const values = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM stored_values")).rows[0]!.n;
    expect(await erase(erased)).toBe(bodyOf(erased));
    expect(await has(bodyOf(erased))).toBe(false);
    // 投稿の元になった判断の出力（固定データでは本文と同じ文）も消える。同じ判断の注文の出力は、同じ文を持たないので残る
    expect(await has(outputOf(erased))).toBe(false);
    expect(await has(orderOutputOf(erased))).toBe(true);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM stored_values")).rows[0]!.n).toBe(values - 2);
    // イベントは1行も変わらず、本文のハッシュはイベントに残る
    const after = await readAllEvents(db);
    expect(after).toEqual(before);
    expect(await verifyChain(after)).toEqual([]);
    // 開き直し：消えた本文は引けない（画面では非表示として扱う）。ほかの本文は残る
    const reopened = await PgValueStore.open(db);
    expect(reopened.body(bodyOf(erased))).toBeUndefined();
    for (const p of posts.slice(1)) expect(reopened.body(bodyOf(p.seq))?.value).toBe(g.bodies.get(bodyOf(p.seq))!.value);
    expect((await (await open()).last())?.hash).toBe(after.at(-1)!.hash);
    expect((await verifyDatabase(db, FIXTURE_HOLIDAYS)).lastHash).toBe(after.at(-1)!.hash);
    // 何度呼んでも同じ結果。migrate を流し直しても戻らない
    expect(await erase(erased)).toBeNull();
    await migrate(db);
    expect(await has(bodyOf(erased))).toBe(false);
  }, 60_000);

  it("bodyErased が偽・非表示の記録がない・投稿でない seq は、例外にして何も消さない", async () => {
    const { kept, untouched } = await setUp();
    await expect(erase(kept)).rejects.toThrow("may not be erased");
    await expect(erase(untouched)).rejects.toThrow("may not be erased");
    await expect(erase(1)).rejects.toThrow("is not a post.published");
    expect(await has(bodyOf(kept))).toBe(true);
    expect(await has(bodyOf(untouched))).toBe(true);
  }, 60_000);

  it("条件に合わない行は、持ち主が設定を自分で入れても消せない。設定のない直接の DELETE も断る", async () => {
    const { erased } = await setUp();
    const valueHash = (await db.query<{ hash: string }>("SELECT hash FROM stored_values WHERE kind = 'value' LIMIT 1")).rows[0]!.hash;
    await expect(db.query("DELETE FROM stored_values WHERE hash = $1", [bodyOf(erased)])).rejects.toThrow(/stored_values is append-only/);
    for (const h of [valueHash, bodyOf(posts[1]!.seq)]) {
      await expect(db.transaction(async (tx) => {
        await tx.query("SELECT set_config('ffr.erase_body', $1, true)", [h]);
        await tx.query("DELETE FROM stored_values WHERE hash = $1", [h]);
      })).rejects.toThrow(/stored_values is append-only/);
      expect(await has(h)).toBe(true);
    }
    await expect(pg.exec("UPDATE stored_values SET kind = 'body'")).rejects.toThrow(/stored_values is append-only/);
    await expect(pg.exec("TRUNCATE stored_values")).rejects.toThrow(/stored_values is append-only/);
  }, 60_000);

  it("持ち主は守りの対象外：設定を自分で入れれば、条件に合う本文だけは関数を通らずに消せる", async () => {
    const { erased } = await setUp();
    await db.transaction(async (tx) => {
      await tx.query("SELECT set_config('ffr.erase_body', $1, true)", [bodyOf(erased)]);
      await tx.query("DELETE FROM stored_values WHERE hash = $1", [bodyOf(erased)]);
    });
    expect(await has(bodyOf(erased))).toBe(false);
  }, 60_000);

  it("最後の非表示の記録だけを見る：真のあとに偽なら断る。偽のあとに真なら消せる", async () => {
    const { withdraw, erased, kept } = await setUp();
    await withdraw(erased, false);
    await withdraw(kept, true);
    await expect(erase(erased)).rejects.toThrow("may not be erased");
    expect(await erase(kept)).toBe(bodyOf(kept));
  }, 60_000);

  it("同じ本文を持つ投稿のうち1つでも bodyErased が真でなければ断る。運営者でない書き手の非表示の記録は数えない", async () => {
    const { erased, kept } = await setUp();
    await insertRaw("content.withdrawn", "system", { targetSeq: kept, reason: "装った記録", bodyErased: true });
    await insertRaw("content.withdrawn", "agent:alpha", { targetSeq: kept, reason: "装った記録", bodyErased: true });
    await expect(erase(kept)).rejects.toThrow("may not be erased");
    await insertRaw("post.published", "agent:alpha", { bodyHash: bodyOf(erased) });
    await expect(erase(erased)).rejects.toThrow("may not be erased");
    expect(await has(bodyOf(erased))).toBe(true);
    expect(await has(bodyOf(kept))).toBe(true);
  }, 60_000);

  it("投稿の本文の項目のほかに、そのハッシュを指す記録があれば断る（判断の出力・訂正の新しい本文など）", async () => {
    const { erased } = await setUp();
    const run = g.events.find((e) => e.type === "agent.run" && typeof (e.payload as { outputHash?: unknown }).outputHash === "string")!;
    const output = (run.payload as { outputHash: string }).outputHash;
    // 判断の出力のハッシュを本文に持つ投稿を足し、本文ごと非表示にしても、出力の行は消えない
    await insertRaw("post.published", "agent:alpha", { bodyHash: output });
    const forged = g.events.length + 3;
    await insertRaw("content.withdrawn", "operator:owner", { targetSeq: forged, reason: "偽", bodyErased: true });
    await expect(erase(forged)).rejects.toThrow("may not be erased");
    await expect(db.transaction(async (tx) => {
      await tx.query("SELECT set_config('ffr.erase_body', $1, true)", [output]);
      await tx.query("DELETE FROM stored_values WHERE hash = $1", [output]);
    })).rejects.toThrow(/stored_values is append-only/);
    expect(await has(output)).toBe(true);
    // 消してよい本文でも、別の記録（ここでは訂正）が同じハッシュを指せば断る
    await insertRaw("correction.issued", "operator:owner", { refSeq: erased, kind: "post", newBodyHash: bodyOf(erased) });
    await expect(erase(erased)).rejects.toThrow("may not be erased");
    expect(await has(bodyOf(erased))).toBe(true);
  }, 60_000);

  it("ほかの記録が指していれば、どこに・どう書かれていても断る（投稿の別の項目・入れ子・接頭辞つき・keys）", async () => {
    const cases: [string, (h: string) => unknown, (h: string) => unknown[]][] = [
      ["post.published", (h) => ({ bodyHash: "0".repeat(64), quote: h }), () => []],
      ["source.captured", (h) => ({ a: { b: [`sha256:${h}`] } }), () => []],
      ["source.captured", () => ({}), (h) => [`ref:${h}`]],
    ];
    for (const [type, payload, keys] of cases) {
      const { erased } = await setUp();
      const h = bodyOf(erased);
      await insertRaw(type, "system", payload(h), keys(h));
      await expect(erase(erased)).rejects.toThrow("may not be erased");
      expect(await has(h)).toBe(true);
    }
  }, 60_000);

  it("中身がオブジェクトでない投稿の行（値1つ・配列）があっても、関数と手順書の文は動く", async () => {
    const { erased } = await setUp();
    for (const payload of ["just a string", 42, [1, "x"], null]) await insertRaw("post.published", "agent:alpha", payload);
    await insertRaw("content.withdrawn", "operator:owner", "just a string");
    const [list, mismatch] = opsStatements() as [string, string, string];
    expect((await db.query<{ seq: number }>(list)).rows.map((r) => Number(r.seq))).toEqual([erased]);
    await db.query(mismatch);
    expect(await erase(erased)).toBe(bodyOf(erased));
    await expect(erase(g.events.length + 3)).rejects.toThrow("is not a post.published"); // 本文のハッシュがない投稿
  }, 60_000);

  it("アプリの役割（ffr_app）は関数を呼べず、表から削除もできない", async () => {
    const { erased } = await setUp();
    try {
      await pg.exec("SET ROLE ffr_app");
      await expect(erase(erased)).rejects.toThrow(/permission denied/);
      await expect(db.query("DELETE FROM stored_values WHERE hash = $1", [bodyOf(erased)])).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec("RESET ROLE");
    }
    expect(await has(bodyOf(erased))).toBe(true);
  }, 60_000);

  it("運営者の手順の SQL（db/ops/erase_body.sql）：一覧は記録の書き手と理由つきで、食い違いの確かめも働く", async () => {
    const { erased, kept } = await setUp();
    const statements = opsStatements();
    expect(statements).toHaveLength(3);
    const [list, mismatch, run] = statements as [string, string, string];
    const problems = async () => (await db.query<{ seq: number; problem: string }>(mismatch)).rows.map((r) => [Number(r.seq), r.problem]);
    const rows = (await db.query<{ seq: number; actor: string; reason: string }>(list)).rows;
    expect(rows.map((r) => [Number(r.seq), r.actor, r.reason])).toEqual([[erased, "operator:owner", "権利者からの申し出"]]);
    expect(await problems()).toEqual([[erased, "not_erased"], [erased, "output_not_erased"]]);
    await db.query(run.replace("<seq>", String(erased)));
    expect((await db.query(list)).rows).toEqual([]);
    // 固定データの注文用の出力は本文を含まないので残る。本文がもうないので、残りが本文を含むかを確かめられず、output_unverifiable として出る
    // （毎日の実行では、投稿用と注文用の出力は同じ全文なので、両方が消えて何も出ない）
    expect(await problems()).toEqual([[erased, "output_unverifiable"]]);
    // 本文がないのに、最後の記録が真でない（持ち主がトリガを外して消した場合など）
    await pg.exec("ALTER TABLE stored_values DISABLE TRIGGER USER");
    await db.query("DELETE FROM stored_values WHERE hash = $1", [bodyOf(kept)]);
    expect(await problems()).toEqual([[erased, "output_unverifiable"], [kept, "missing"]]);
  }, 60_000);
});

/** 本文の行を、正しい乱数つきのハッシュで直接入れる（stored_values の制約を通る形） */
async function putBodyRow(text: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await bodyHash(salt, text);
  await db.query("INSERT INTO stored_values VALUES ($1, 'body', $2, $3::jsonb)", [hash, hex(salt), JSON.stringify(text)]);
  return hash;
}
const lastSeq = async () => Number((await db.query<{ seq: string }>("SELECT max(seq) AS seq FROM events")).rows[0]!.seq);
const erasedOutputs = async (seq: number) => (await db.query<{ h: string }>("SELECT erase_withdrawn_outputs($1) AS h", [seq])).rows.map((r) => r.h);
const tryDelete = (h: string) =>
  db.transaction(async (tx) => {
    await tx.query("SELECT set_config('ffr.erase_body', $1, true)", [h]);
    await tx.query("DELETE FROM stored_values WHERE hash = $1", [h]);
  });
const problemOf = async (seq: number) => (await db.query<{ p: string | null }>("SELECT withdrawn_post_problem(current_schema(), $1) AS p", [seq])).rows[0]!.p;
/** 手順書の2つ目の文（食い違い）のうち、seq の投稿の行 */
const problemsOf = async (seq: number) => (await db.query<{ seq: number; problem: string }>(opsStatements()[1]!)).rows.filter((r) => Number(r.seq) === seq).map((r) => r.problem);
/** 役割 role になって fn を動かし、必ず持ち主に戻す */
async function as<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await pg.exec(`SET ROLE ${role}`);
  try {
    return await fn();
  } finally {
    await pg.exec("RESET ROLE");
  }
}

/**
 * 毎日の実行と同じ形の判断を1つ足す：投稿用の agent.run・投稿・注文用の agent.run・注文票の確定（同じ AI・同じ入力。出力は既定で同じ全文の JSON）、
 * 本文を消す印つきの取り下げ。orderOutput で注文用の出力を変え、order: false で注文用の run を、sheet: false で注文票の確定を省ける
 */
async function decision(o: { agentId?: string; inputSeqs?: number[]; text: string; withdraw?: boolean; post?: boolean; orderOutput?: string; order?: boolean; sheet?: boolean }) {
  const agentId = o.agentId ?? "ai-x";
  const inputSeqs = o.inputSeqs ?? [1, 2];
  const output = canonicalize({ note: "n", orders: [], post: { board: "TSTA", text: o.text } });
  const run = async (purpose: string, out: string) => {
    const h = await putBodyRow(out);
    await insertRaw("agent.run", "system", { agentId, purpose, inputSeqs, outputHash: h, ok: true });
    return { seq: await lastSeq(), h };
  };
  const postRun = await run("post", output);
  const body = await putBodyRow(o.text);
  let post = 0;
  if (o.post !== false) {
    await insertRaw("post.published", `agent:${agentId}`, { agentId, board: "TSTA", bodyHash: body, runSeq: postRun.seq });
    post = await lastSeq();
  }
  const outputs = [postRun.h];
  if (o.order !== false) {
    const orderRun = await run("order", o.orderOutput ?? output);
    outputs.push(orderRun.h);
    if (o.sheet !== false) await insertRaw("order_sheet.committed", "system", { agentId, tradingDate: "2026-11-10", orders: [], runSeq: orderRun.seq, inputSeqs });
  }
  if (o.withdraw !== false && post > 0) await insertRaw("content.withdrawn", "operator:owner", { targetSeq: post, reason: "申し出", bodyErased: true });
  return { post, body, postRun: postRun.seq, outputs };
}

describe("erase_withdrawn_body と判断の出力（db/004_erase_outputs.sql。#179）", () => {
  it("同じ判断の、本文を持つ出力（投稿用と注文用）を消す。ほかの判断の出力は残し、イベントは変えない。何度呼んでも同じ結果", async () => {
    await setUp();
    const text = '「買い」と言った\n He said "buy" \\ now';
    const other = await decision({ inputSeqs: [1, 3], text: "別の日の投稿", withdraw: false });
    const otherAgent = await decision({ agentId: "ai-y", text, withdraw: false }); // ほかの AI の同じ文は、確かめにも消す対象にも入らない
    const d = await decision({ text });
    const before = await readAllEvents(db);
    expect(await problemOf(d.post)).toBeNull();
    expect(await erase(d.post)).toBe(d.body);
    for (const h of [d.body, ...d.outputs]) expect(await has(h)).toBe(false);
    for (const h of [other.body, ...other.outputs, otherAgent.body, ...otherAgent.outputs]) expect(await has(h)).toBe(true);
    expect(await readAllEvents(db)).toEqual(before);
    expect(await erase(d.post)).toBeNull();
    expect(await erasedOutputs(d.post)).toEqual([]);
    expect(await problemsOf(d.post)).toEqual([]);
  }, 60_000);

  it("本文を持つかは、全体が本文と同じか、JSON の文字列の値として丸ごと含むかで決める。引用符のない形・本文の一部だけでは消さない", async () => {
    await setUp();
    const text = "買い";
    const cases: [string, boolean][] = [
      [canonicalize([{ text }]), true], // JSON の文字列の値として丸ごと
      [text, true], // 全体が本文と同じ
      [`raw: ${text}`, false], // 引用符のない形
      [canonicalize({ note: "買いたい" }), false], // 本文の一部だけ
      [canonicalize({ note: `${text} です` }), false],
      ["[]", false],
    ];
    const ds = [];
    for (const [i, [orderOutput]] of cases.entries()) ds.push(await decision({ agentId: `ai-c${i}`, text, orderOutput }));
    for (const [i, [, erased]] of cases.entries()) {
      expect(await erase(ds[i]!.post)).toBe(ds[i]!.body);
      expect(await has(ds[i]!.outputs[0]!)).toBe(false);
      expect(await has(ds[i]!.outputs[1]!), `case ${i}`).toBe(!erased);
    }
  }, 60_000);

  it("【高1】アプリの接続（ffr_app）で、本物の判断の run を指す偽の投稿を足し、運営者が取り下げて消しても、本物の出力も本文も消えない", async () => {
    await setUp();
    const real = await decision({ text: "本物の投稿", withdraw: false });
    // ffr_app で、本物の投稿用の run を指す偽の投稿と、その本文（任意の文）を足す
    const forged = await as("ffr_app", async () => {
      const out: number[] = [];
      for (const text of ["{", "本物の投稿", "TSTA"]) {
        const body = await putBodyRow(text);
        await insertRaw("post.published", "agent:ai-x", { agentId: "ai-x", board: "TSTA", bodyHash: body, runSeq: real.postRun });
        out.push(await lastSeq());
      }
      return out;
    });
    for (const seq of forged) await insertRaw("content.withdrawn", "operator:owner", { targetSeq: seq, reason: "偽", bodyErased: true });
    for (const seq of forged) {
      await expect(erase(seq)).rejects.toThrow("run_has_many_posts");
      await expect(erasedOutputs(seq)).rejects.toThrow("run_has_many_posts");
      expect(await problemsOf(seq)).toEqual(["not_erased", "output_not_erased", "run_has_many_posts"].filter((p) => p !== "output_not_erased" || seq !== forged[0]));
    }
    for (const h of [real.body, ...real.outputs]) expect(await has(h)).toBe(true);
    // 本物の投稿の側も、別の本文の投稿が同じ run を指すあいだは消せない（手順書に出続ける）
    await insertRaw("content.withdrawn", "operator:owner", { targetSeq: real.post, reason: "申し出", bodyErased: true });
    await expect(erase(real.post)).rejects.toThrow("run_has_many_posts");
    for (const h of [real.body, ...real.outputs]) expect(await has(h)).toBe(true);
  }, 60_000);

  it("【高1】元の run の出力が本文を含まない投稿（投稿のない判断の run を指す偽の投稿）は断る。注文用の run を指す偽の投稿は、出力に触れずに本文だけを消す", async () => {
    await setUp();
    const silent = await decision({ text: "投稿しなかった判断", post: false });
    const posted = await decision({ inputSeqs: [1, 3], text: "本物" });
    const forged = await as("ffr_app", async () => {
      await insertRaw("post.published", "agent:ai-x", { agentId: "ai-x", board: "TSTA", bodyHash: await putBodyRow("{"), runSeq: silent.postRun });
      const a = await lastSeq();
      // 注文用の run（本物の投稿の判断）を指す
      const orderRun = (await db.query<{ seq: string }>("SELECT seq FROM events WHERE type = 'agent.run' AND payload->>'outputHash' = $1", [posted.outputs[1]])).rows[0]!.seq;
      await insertRaw("post.published", "agent:ai-x", { agentId: "ai-x", board: "TSTA", bodyHash: await putBodyRow("本物"), runSeq: Number(orderRun) });
      return [a, await lastSeq()] as const;
    });
    for (const seq of forged) await insertRaw("content.withdrawn", "operator:owner", { targetSeq: seq, reason: "偽", bodyErased: true });
    await expect(erase(forged[0])).rejects.toThrow("output_without_body");
    expect(await problemsOf(forged[0])).toEqual(["not_erased", "output_without_body"]);
    for (const h of silent.outputs) expect(await has(h)).toBe(true);
    const body = (await db.query<{ h: string }>("SELECT payload->>'bodyHash' AS h FROM events WHERE seq = $1", [forged[1]])).rows[0]!.h;
    expect(await erase(forged[1])).toBe(body);
    for (const h of posted.outputs) expect(await has(h)).toBe(true);
  }, 60_000);

  it("【中2】同じ AI の、同じ判断の外の出力が本文を持てば断る（入力の一覧が違う）。日をまたいで入力の一覧が同じなら、判断が分からないとして断る", async () => {
    await setUp();
    const text = "毎日同じことを言う";
    const yesterday = await decision({ inputSeqs: [1, 3], text, withdraw: false });
    const d = await decision({ text });
    await expect(erase(d.post)).rejects.toThrow("text_outside_decision");
    expect(await problemsOf(d.post)).toEqual(["not_erased", "output_not_erased", "text_outside_decision"]);
    for (const h of [d.body, ...d.outputs, yesterday.body, ...yesterday.outputs]) expect(await has(h)).toBe(true);
    // 入力の一覧が同じ判断が2日分ある（投稿用・注文用の run が2つずつ）
    await setUp();
    await decision({ text: "一日目", withdraw: false });
    const e = await decision({ text: "二日目" });
    await expect(erase(e.post)).rejects.toThrow("decision_unclear");
    for (const h of [e.body, ...e.outputs]) expect(await has(h)).toBe(true);
  }, 60_000);

  it("【中3】同じ判断に注文用の run がない、または注文票の確定・拒否の記録がないときは、本文も出力も消さない", async () => {
    for (const o of [{ order: false }, { sheet: false }]) {
      await setUp();
      const d = await decision({ text: "確定の前", ...o });
      await expect(erase(d.post)).rejects.toThrow("sheet_not_settled");
      await expect(erasedOutputs(d.post)).rejects.toThrow("sheet_not_settled");
      expect(await problemsOf(d.post)).toEqual(["not_erased", "output_not_erased", "sheet_not_settled"]);
      for (const h of [d.body, ...d.outputs]) expect(await has(h)).toBe(true);
    }
    // 拒否の記録でもよい
    await setUp();
    const d = await decision({ text: "拒否された日", sheet: false });
    const orderRun = (await db.query<{ seq: string }>("SELECT seq FROM events WHERE type = 'agent.run' AND payload->>'outputHash' = $1", [d.outputs[1]])).rows[0]!.seq;
    await insertRaw("order_sheet.rejected", "system", { agentId: "ai-x", tradingDate: "2026-11-10", reason: "suspended", runSeq: Number(orderRun), inputSeqs: [1, 2], orders: [] });
    expect(await erase(d.post)).toBe(d.body);
  }, 60_000);

  it("【低7】本文がもうないとき（003 の版で本文だけを消した・本文と元の run の出力の両方がない）は、何も消さず、残った出力を output_unverifiable として出す", async () => {
    await setUp();
    const d = await decision({ text: "先に本文だけ消した" });
    await pg.exec("ALTER TABLE stored_values DISABLE TRIGGER USER");
    await db.query("DELETE FROM stored_values WHERE hash = $1", [d.body]);
    const e = await decision({ inputSeqs: [1, 3], text: "本文と元の出力を消した" });
    await db.query("DELETE FROM stored_values WHERE hash = ANY($1)", [[e.body, e.outputs[0]!]]);
    await pg.exec("ALTER TABLE stored_values ENABLE TRIGGER USER");
    for (const x of [d, e]) {
      expect(await erase(x.post)).toBeNull();
      expect(await erasedOutputs(x.post)).toEqual([]);
      expect(await problemsOf(x.post)).toEqual(["output_unverifiable"]);
    }
    for (const h of [...d.outputs, e.outputs[1]!]) expect(await has(h)).toBe(true);
  }, 60_000);

  it("本文の項目が同じ写しの投稿は、元の run を指していても数えない。写しがすべて本文を消す印つきで取り下げられれば、本文と出力を消せる", async () => {
    await setUp();
    const d = await decision({ text: "写しのある投稿", withdraw: false });
    await insertRaw("post.published", "agent:ai-x", { agentId: "ai-x", board: "TSTA", bodyHash: d.body, runSeq: d.postRun });
    const twin = await lastSeq();
    await insertRaw("content.withdrawn", "operator:owner", { targetSeq: twin, reason: "申し出", bodyErased: true });
    await expect(erase(twin)).rejects.toThrow("may not be erased"); // 写しの片方がまだ表示されている
    await expect(erasedOutputs(d.post)).rejects.toThrow("may not be erased"); // 投稿自身が取り下げられていない
    for (const h of [d.body, ...d.outputs]) expect(await has(h)).toBe(true);
    await insertRaw("content.withdrawn", "operator:owner", { targetSeq: d.post, reason: "申し出", bodyErased: true });
    expect(await erase(twin)).toBe(d.body);
    for (const h of d.outputs) expect(await has(h)).toBe(false);
  }, 60_000);

  it("出力のハッシュを、agent.run の outputHash のほかに指す記録があれば、本文も出力も消さない", async () => {
    await setUp();
    const d = await decision({ text: "出力を指す記録がある" });
    await insertRaw("source.captured", "system", { contentHash: d.outputs[1] });
    await expect(erase(d.post)).rejects.toThrow("may not be erased");
    for (const h of [d.body, ...d.outputs]) expect(await has(h)).toBe(true);
  }, 60_000);

  it("見張り：関数と同じ範囲だけを通す。取り下げていない判断・確かめに当たる判断・別の判断にも指される出力は、持ち主が設定を入れても消せない", async () => {
    await setUp();
    const kept = await decision({ text: "取り下げていない", withdraw: false });
    const unsettled = await decision({ inputSeqs: [1, 5], text: "確定の前", sheet: false });
    const other = await decision({ inputSeqs: [1, 3], text: "取り下げた別の日" });
    const d = await decision({ inputSeqs: [1, 4], text: "取り下げた" });
    // 取り下げた判断と同じ AI・入力を名乗る agent.run で、別の日の出力を指す（アプリの接続でも直接入れられる行）
    await insertRaw("agent.run", "system", { agentId: "ai-x", purpose: "order", inputSeqs: [1, 4], outputHash: other.outputs[1], ok: true });
    for (const h of [...kept.outputs, ...unsettled.outputs, other.outputs[1]!, ...d.outputs]) {
      await expect(tryDelete(h)).rejects.toThrow(/stored_values is append-only/);
      expect(await has(h)).toBe(true);
    }
    await expect(erase(other.post)).rejects.toThrow("may not be erased");
    await expect(erase(d.post)).rejects.toThrow("decision_unclear");
    // 確かめに当たらない判断の出力は、持ち主なら関数を通らずに消せる（003 と同じ守りの範囲）。元の run の出力を先に消すと、残りは消せない
    await setUp();
    const e = await decision({ text: "持ち主が直接消す" });
    await tryDelete(e.outputs[0]!);
    expect(await has(e.outputs[0]!)).toBe(false);
    await expect(tryDelete(e.outputs[1]!)).rejects.toThrow(/stored_values is append-only/);
    const f = await decision({ inputSeqs: [1, 3], text: "順に消す" });
    await tryDelete(f.outputs[1]!);
    await tryDelete(f.outputs[0]!);
    for (const h of f.outputs) expect(await has(h)).toBe(false);
  }, 60_000);

  it("アプリの役割（ffr_app）と読むだけの役割（ffr_reader）は、erase_withdrawn_body も erase_withdrawn_outputs も呼べない", async () => {
    await setUp();
    const d = await decision({ text: "アプリからは消せない" });
    for (const role of ["ffr_app", "ffr_reader"]) {
      await as(role, async () => {
        await expect(erase(d.post)).rejects.toThrow(/permission denied/);
        await expect(erasedOutputs(d.post)).rejects.toThrow(/permission denied/);
      });
    }
    for (const h of [d.body, ...d.outputs]) expect(await has(h)).toBe(true);
    // 確認の SQL（db/ops/check_reader_role.sql）も、どちらも呼べないことを false で出す
    const check = await as("ffr_reader", async () => (await pg.query<{ can_erase_body: boolean }>(readFileSync(new URL("../../db/ops/check_reader_role.sql", import.meta.url), "utf8"))).rows[0]!);
    expect(check.can_erase_body).toBe(false);
  }, 60_000);

  it("手順書の1つ目の文は、一緒に消える出力の件数と先頭の部分を出す", async () => {
    await setUp();
    const d = await decision({ text: "一覧に出る" });
    const rows = (await db.query<{ seq: number; outputs_to_erase: number; outputs_preview: string[] }>(opsStatements()[0]!)).rows.filter((r) => Number(r.seq) === d.post);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outputs_to_erase).toBe(2);
    expect(rows[0]!.outputs_preview).toEqual([0, 1].map(() => canonicalize({ note: "n", orders: [], post: { board: "TSTA", text: "一覧に出る" } }).slice(0, 80)));
    // 確かめに当たる投稿は、一覧に出ない
    const u = await decision({ inputSeqs: [1, 3], text: "確定の前", sheet: false });
    expect((await db.query<{ seq: number }>(opsStatements()[0]!)).rows.map((r) => Number(r.seq))).not.toContain(u.post);
  }, 60_000);
});
