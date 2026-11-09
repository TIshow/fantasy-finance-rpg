// 検証役（#179、PR #223）：訂正の記録（correction.issued）の形（lead の決定2）を壊しにいく。
// 決まり：訂正する対象は targetSeq の1件だけ（refs に入れる）。kind は post（対象は投稿）か input（対象は prices.open・prices.close・
// corporate_action.announced だけ）。reason は前後の空白を除いて空でない、500文字まで。newBodyHash は省けるが、書くなら小文字の16進64文字。
// refs のほかの seq は引用。書けるのは運営者だけ。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import type { HolidayTable } from "../../src/holidays/table";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const H = "e".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set() };
/** "abc" の SHA-256（実装とは別に書いた例） */
const HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const D = "2026-11-10";
const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });
const op = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "operator:owner", refs, payload });
async function ok(log: EventLog, d: Draft) {
  const r = await log.append(d);
  if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
  return r.event.seq;
}
const why = async (log: EventLog, d: Draft) => {
  const r = await log.append(d);
  return r.ok ? "ok" : r.reason;
};

/** 投稿・入力データ（始値・終値・配当の公表）・訂正の対象にならない記録を並べたログ */
async function setup() {
  const log = new EventLog({ holidayTables: new Map([[H, TABLE]]), accountOf: () => newAccount() });
  await ok(log, op("holidays.adopted", 0, { holidaysSha256: H }));
  await ok(log, op("universe.set", 0, { symbols: ["AAA"] }));
  await ok(log, op("agent.registered", jst("2026-11-09", 20), { agentId: "alpha", startDate: D, initialCash: INITIAL_CASH }));
  const src = await ok(log, sys("source.captured", jst("2026-11-09", 21), { publishedAt: jst("2026-11-09", 19), fetchedAt: jst("2026-11-09", 21) }));
  const run = await ok(log, sys("agent.run", jst("2026-11-09", 22), { agentId: "alpha", purpose: "post", inputSeqs: [src], ok: true }, [src]));
  const post = await ok(log, { type: "post.published", recordedAt: jst("2026-11-09", 22, 1), actor: "agent:alpha", refs: [run], payload: { agentId: "alpha", board: "AAA", bodyHash: HASH, runSeq: run } });
  const post2 = await ok(log, { type: "post.published", recordedAt: jst("2026-11-09", 22, 2), actor: "agent:alpha", refs: [run], payload: { agentId: "alpha", board: "AAA", bodyHash: HASH, runSeq: run } });
  const open = await ok(log, sys("prices.open", jst(D, 9), { date: D }));
  const close = await ok(log, sys("prices.close", jst(D, 15, 40), { date: D }));
  const announced = await ok(log, sys("corporate_action.announced", jst(D, 15, 41), { symbol: "AAA", kind: "dividend", exDate: "2026-11-12", announcedAt: jst(D, 15), perShare: 100 }));
  const first = await ok(log, op("correction.issued", jst(D, 15, 50), { targetSeq: post, kind: "post", reason: "1回目" }, [post]));
  const withdrawn = await ok(log, op("content.withdrawn", jst(D, 15, 51), { targetSeq: post2, reason: "r" }, [post2]));
  return { log, src, run, post, post2, open, close, announced, first, withdrawn };
}
const fix = (payload: Record<string, unknown>, refs: number[]) => op("correction.issued", jst(D, 16), payload, refs);

describe("訂正の対象（targetSeq）", () => {
  it("入力データの訂正（input）は、始値・終値・配当の公表のどれでも書けて、refs のほかの seq（投稿・別の入力データ・訂正）は引用として書ける", async () => {
    const s = await setup();
    for (const t of [s.open, s.close, s.announced]) await ok(s.log, fix({ targetSeq: t, kind: "input", reason: "配信元の訂正", newBodyHash: HASH }, [...new Set([t, s.post, s.first, s.open])]));
  });

  it("対象の種類が合わなければ断る：投稿の訂正で入力データ・訂正・取り下げ・判断の記録を指す、入力データの訂正で投稿・訂正・出典・判断の記録・登録を指す", async () => {
    const s = await setup();
    const before = s.log.events.length;
    for (const t of [s.open, s.close, s.announced, s.first, s.withdrawn, s.run, s.src]) {
      expect(await why(s.log, fix({ targetSeq: t, kind: "post", reason: "r" }, [t])), `post→${String(t)}`).toBe("targetSeq of a post correction must be a post.published");
    }
    for (const t of [s.post, s.first, s.withdrawn, s.run, s.src, 3]) {
      expect(await why(s.log, fix({ targetSeq: t, kind: "input", reason: "r" }, [t])), `input→${String(t)}`).toMatch(/^targetSeq of an input correction must be one of/);
    }
    expect(s.log.events).toHaveLength(before);
  });

  it("targetSeq が 0・負・小数・自分自身・refs にない（引用だけに入れた）なら断る。一覧（配列）や文字列の数も断る", async () => {
    const s = await setup();
    const next = s.log.events.length + 1;
    const bad: [unknown, number[]][] = [[0, [s.post]], [-1, [s.post]], [1.5, [s.post]], [next, [s.post]], [s.post2, [s.post]], [[s.post], [s.post]], [`${String(s.post)}`, [s.post]], [Number.MAX_SAFE_INTEGER + 1, [s.post]]];
    for (const [targetSeq, refs] of bad) expect(await why(s.log, fix({ targetSeq, kind: "post", reason: "r" }, refs)), JSON.stringify(targetSeq)).not.toBe("ok");
  });

  it("今の動き：取り下げた投稿も、投稿の訂正の対象にできる（決まりにない。表示は取り下げが優先）", async () => {
    const s = await setup();
    expect(await why(s.log, fix({ targetSeq: s.post2, kind: "post", reason: "r" }, [s.post2]))).toBe("ok");
  });
});

describe("訂正の理由（reason）と新しい本文のハッシュ", () => {
  it("前後の空白だけの理由は断る（改行・タブ・全角空白・NBSP・BOM・行区切り）。500文字ちょうどは通り、絵文字250個（長さ500）も通り、251個は断る", async () => {
    const s = await setup();
    const want = "reason is required (up to 500 characters)";
    for (const reason of [" ", "\r\n", " ", "﻿", "  ", "　\t", " "]) expect(await why(s.log, fix({ targetSeq: s.post, kind: "post", reason }, [s.post])), JSON.stringify(reason)).toBe(want);
    await ok(s.log, fix({ targetSeq: s.post, kind: "post", reason: "あ".repeat(500) }, [s.post]));
    await ok(s.log, fix({ targetSeq: s.post, kind: "post", reason: "😀".repeat(250) }, [s.post]));
    expect(await why(s.log, fix({ targetSeq: s.post, kind: "post", reason: "😀".repeat(251) }, [s.post]))).toBe(want);
    // 前後に空白をつけて500文字を超えると断る（長さは空白を除く前で数える）
    expect(await why(s.log, fix({ targetSeq: s.post, kind: "post", reason: ` ${"あ".repeat(500)}` }, [s.post]))).toBe(want);
  });

  // 【低・判断待ち（宛先 lead）】trim が空白と見なさない、見えない文字だけの理由（ゼロ幅スペース・ゼロ幅の結合子・語結合子）は通る。
  // 決まり「前後の空白を除いて空でない」には合っているが、見る人には理由が空に見える
  it("今の動き：ゼロ幅スペース（U+200B）・ゼロ幅接合子（U+200D）・語結合子（U+2060）だけの理由は通る", async () => {
    const s = await setup();
    for (const reason of ["​", "‍", "⁠"]) expect(await why(s.log, fix({ targetSeq: s.post, kind: "post", reason }, [s.post])), JSON.stringify(reason)).toBe("ok");
  });

  it("理由が文字列でない・対になっていないサロゲートを含む中身は、例外にならずに断る", async () => {
    const s = await setup();
    for (const reason of [123, ["r"], { r: 1 }, null, true]) expect(await why(s.log, fix({ targetSeq: s.post, kind: "post", reason }, [s.post])), JSON.stringify(reason)).not.toBe("ok");
    expect(await why(s.log, fix({ targetSeq: s.post, kind: "post", reason: "\ud800" }, [s.post]))).not.toBe("ok");
  });

  it("newBodyHash は小文字の16進64文字だけ（63・65文字・16進でない文字・前後の空白・数は断る）", async () => {
    const s = await setup();
    for (const h of [HASH.slice(1), `${HASH}0`, `${HASH.slice(1)}g`, ` ${HASH.slice(1)}`, 1, ""]) expect(await why(s.log, fix({ targetSeq: s.post, kind: "post", reason: "r", newBodyHash: h }, [s.post])), JSON.stringify(h)).toBe("newBodyHash must be a SHA-256 hex digest");
  });

  it("知らない項目（__proto__・constructor・value）は断る", async () => {
    const s = await setup();
    const proto = JSON.parse(`{"targetSeq":${String(s.post)},"kind":"post","reason":"r","__proto__":{"targetSeq":1}}`) as Record<string, unknown>;
    expect(await why(s.log, fix(proto, [s.post]))).toBe("unknown field in a correction");
    for (const k of ["constructor", "value"]) expect(await why(s.log, fix({ targetSeq: s.post, kind: "post", reason: "r", [k]: 1 }, [s.post])), k).toBe("unknown field in a correction");
  });

  it("運営者のほかは（system・AI）書けない", async () => {
    const s = await setup();
    for (const actor of ["system", "agent:alpha"] as const) expect(await why(s.log, { ...fix({ targetSeq: s.post, kind: "post", reason: "r" }, [s.post]), actor })).not.toBe("ok");
  });
});
