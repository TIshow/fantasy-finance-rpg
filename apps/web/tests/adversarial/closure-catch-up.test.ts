// 検証役（#71 の実装 #79 の確認）：臨時休場のあとの追加の引け後処理（docs/EVENT_LOG.md §3.3、closedSeq）を壊しにいく。
// 成り立つはずのこと：(1) 渡すのは、権利落ち日が D の新しい翌営業日の公表の全部だけ。(2) 書けるのは system だけ、D の引け後処理が済んだAIだけ。
// (3) 反映する公表があるうちは、翌営業日の注文票も評価も進めない。(4) 停止中でも反映する（停止は評価を止めない、§4）。
// (5) 端数の換金に使う終値は D の時点の直近の終値で、後の終値を使わない（先読みしない）。欠陥の再現は it.fails。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { bodyHash } from "../../src/events/hash";
import { Ledger, replay, type ValueStore } from "../../src/events/replay";
import type { HolidayTable } from "../../src/holidays/table";
import { INITIAL_CASH } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const SHA = "d".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: SHA, dates: new Set() };
const CTX = { holidayTables: new Map([[SHA, TABLE]]) };
// 11/10（火）が D、11/11（水）を臨時休場 T にし、権利落ち日は 11/12（木）NEXT にずれる
const [D, T, NEXT] = ["2026-11-10", "2026-11-11", "2026-11-12"];

class Store implements ValueStore {
  readonly map = new Map<string, { salt: Uint8Array; value: unknown }>();
  async put(value: unknown) {
    const salt = new Uint8Array(16).fill(this.map.size + 7);
    const hash = await bodyHash(salt, { value });
    this.map.set(hash, { salt, value });
    return hash;
  }
  get(hash: string) {
    return this.map.get(hash);
  }
}

/** alpha・beta が D に AAA を150株（端数の出る株数）持ち、alpha だけ D の引け後処理まで済ませたログ（beta は D の評価の前で止まる） */
async function start() {
  const store = new Store();
  const ledger = new Ledger(store);
  const log = new EventLog({ ...CTX, accountOf: (id) => ledger.account(id) });
  const append = async (d: Draft) => {
    const r = await log.append(d);
    if (r.ok) await ledger.apply(r.event);
    return r;
  };
  const add = async (d: Draft) => {
    const r = await append(d);
    if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
    return r.event.seq;
  };
  const sys = (type: Draft["type"], at: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt: at, actor: "system", refs, payload });
  const op = (type: Draft["type"], at: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt: at, actor: "operator:owner", refs: [], payload });
  const commit = async (at: number, id: string, tradingDate: string, qty = 100) => {
    const run = await add(sys("agent.run", at - 1000, { agentId: id, purpose: "order", inputSeqs: [], ok: true }));
    const c = await log.commitSheet(at, id, { tradingDate, orders: [{ symbol: "AAA", side: "buy", qty }], runSeq: run, inputSeqs: [] });
    if (c.ok) await ledger.apply(c.event);
    return c;
  };

  await add(op("holidays.adopted", 0, { holidaysSha256: SHA }));
  await add(op("universe.set", 0, { symbols: ["AAA"] }));
  for (const [i, id] of ["alpha", "beta"].entries()) await add(op("agent.registered", jst("2026-11-09", 20, i), { agentId: id, startDate: D, initialCash: INITIAL_CASH }));
  const sheets = [await commit(jst(D, 8), "alpha", D), await commit(jst(D, 8, 1), "beta", D)];
  const open = await add(sys("prices.open", jst(D, 9), { date: D, valuesHash: await store.put({ AAA: 10_000 }) }));
  for (const [i, s] of sheets.entries()) {
    if (!s.ok) throw new Error("commit failed");
    const id = ["alpha", "beta"][i]!;
    const f = await ledger.computeFills(id, s.event.seq, open);
    await add(sys("fills.executed", jst(D, 9, 1 + i), { agentId: id, tradingDate: D, sheetSeq: s.event.seq, openSeq: open, ...f.payload }, [s.event.seq, open]));
  }
  const close = await add(sys("prices.close", jst(D, 15, 30), { date: D, valuesHash: await store.put({ AAA: 11_000 }) }));
  /** 権利落ち日 exDate の公表（kind は配当か分割） */
  const announce = async (at: number, exDate: string, value: Record<string, unknown>) => add(sys("corporate_action.announced", at, { symbol: "AAA", kind: value.kind, exDate, valuesHash: await store.put(value) }));
  const valuate = async (at: number, id: string, date: string, closeSeq: number) => append(sys("valuation.recorded", at, { agentId: id, date, closeSeq, ...ledger.computeValuation(id, date) }, [closeSeq]));
  const postClose = async (at: number, id: string, asOf: string, exDate: string, announcedSeqs: number[], closedSeq?: number, actor: Draft["actor"] = "system") => {
    const ca = await ledger.computeCorporate(id, asOf, exDate, announcedSeqs);
    const extra = closedSeq === undefined ? {} : { closedSeq };
    return append({ type: "corporate_actions.applied", recordedAt: at, actor, refs: closedSeq === undefined ? announcedSeqs : [...announcedSeqs, closedSeq], payload: { agentId: id, asOf, exDate, announcedSeqs, ...extra, ...ca.payload } });
  };
  // alpha だけ D の評価と引け後処理を済ませる（T が権利落ち日の公表はない）
  if (!(await valuate(jst(D, 15, 40), "alpha", D, close)).ok) throw new Error("valuation failed");
  if (!(await postClose(jst(D, 15, 41), "alpha", D, T, [])).ok) throw new Error("post-close failed");
  const closeMarket = (at: number) => add(op("market.closed", at, { date: T, reason: "test" }));
  return { store, ledger, log, append, add, sys, op, commit, announce, valuate, postClose, closeMarket, close };
}

describe("渡す公表（§3.3「権利落ち日が D の翌営業日のもの」）", () => {
  it("別の日の公表を混ぜる、NEXT の公表を一部だけ渡す、権利落ち日を T や NEXT の次にする追加の処理は書けない", async () => {
    const w = await start();
    // 権利落ち日が T の公表は、alpha が D の引け後処理を済ませたので、もう書けない（遅れた公表。#67）
    await expect(w.announce(jst(D, 16), T, { kind: "dividend", perShare: 100 })).rejects.toThrow(/already finished the post-close/);
    const later = await w.announce(jst(D, 16), "2026-11-13", { kind: "dividend", perShare: 100 }); // 権利落ち日が NEXT の次の日
    const a1 = await w.announce(jst(D, 16, 1), NEXT, { kind: "dividend", perShare: 500 });
    const a2 = await w.announce(jst(D, 16, 2), NEXT, { kind: "split", from: 1, to: 2 });
    const closed = await w.closeMarket(jst(T, 7));
    const at = jst(T, 10);
    // 反映した内容は正しい一覧で計算し、渡した公表の一覧だけを偽る（computeCorporate は偽の一覧で例外にするので）
    const ca = await w.ledger.computeCorporate("alpha", D, NEXT, [a1, a2]);
    const forged = (announcedSeqs: number[]) => w.append(w.sys("corporate_actions.applied", at, { agentId: "alpha", asOf: D, exDate: NEXT, announcedSeqs, closedSeq: closed, ...ca.payload }, [...announcedSeqs, closed]));
    expect((await forged([later, a1, a2])).ok).toBe(false);
    expect((await forged([a1])).ok).toBe(false);
    expect((await forged([a2, a1])).ok).toBe(false);
    expect((await forged([a1, a1, a2])).ok).toBe(false);
    expect((await w.postClose(at, "alpha", D, T, [], closed)).ok).toBe(false);
    expect((await w.postClose(at, "alpha", D, "2026-11-13", [later], closed)).ok).toBe(false);
    const ok = await w.postClose(at, "alpha", D, NEXT, [a1, a2], closed);
    expect(ok.ok).toBe(true);
    expect(w.ledger.account("alpha").holdings.AAA?.qty).toBe(200);
  });

  it("system 以外（運営者・AI）は追加の処理を書けない", async () => {
    const w = await start();
    const a1 = await w.announce(jst(D, 16), NEXT, { kind: "dividend", perShare: 500 });
    const closed = await w.closeMarket(jst(T, 7));
    expect((await w.postClose(jst(T, 10), "alpha", D, NEXT, [a1], closed, "operator:owner")).ok).toBe(false);
    expect((await w.postClose(jst(T, 10), "alpha", D, NEXT, [a1], closed, "agent:alpha")).ok).toBe(false);
    expect((await w.postClose(jst(T, 10), "alpha", D, NEXT, [a1], closed)).ok).toBe(true);
  });
});

describe("進む順（§3.3「T の翌営業日の注文票より前に書く」）", () => {
  it("反映する公表があるうちは、NEXT の評価も書けない。追加の処理のあとは書ける", async () => {
    const w = await start();
    const a1 = await w.announce(jst(D, 16), NEXT, { kind: "dividend", perShare: 500 });
    const closed = await w.closeMarket(jst(T, 7));
    // 追加の処理を書かないまま NEXT の価格まで来た（runner の遅れ）
    await w.add(w.sys("prices.open", jst(NEXT, 9), { date: NEXT, valuesHash: await w.store.put({ AAA: 12_000 }) }));
    const closeNext = await w.add(w.sys("prices.close", jst(NEXT, 15, 30), { date: NEXT, valuesHash: await w.store.put({ AAA: 12_500 }) }));
    expect((await w.valuate(jst(NEXT, 15, 40), "alpha", NEXT, closeNext)).ok).toBe(false);
    expect((await w.postClose(jst(NEXT, 15, 41), "alpha", D, NEXT, [a1], closed)).ok).toBe(true);
    expect((await w.valuate(jst(NEXT, 15, 42), "alpha", NEXT, closeNext)).ok).toBe(true);
    expect(w.ledger.account("alpha").cash).toBe(INITIAL_CASH - 100 * 10_000 + 100 * 500);
    const r = await replay(w.log.events, w.store, CTX);
    expect(r.account("alpha")).toEqual(w.ledger.account("alpha"));
  });

  it("休場のとき D の引け後処理が済んでいないAI（beta）は追加の処理を書けず、普通の D の引け後処理で NEXT の公表を受け取る", async () => {
    const w = await start();
    const a1 = await w.announce(jst(D, 16), NEXT, { kind: "dividend", perShare: 500 });
    const closed = await w.closeMarket(jst(T, 7));
    expect((await w.postClose(jst(T, 10), "beta", D, NEXT, [a1], closed)).ok).toBe(false);
    expect((await w.valuate(jst(T, 10, 1), "beta", D, w.close)).ok).toBe(true);
    // 普通の引け後処理に closedSeq を付けても書けない
    expect((await w.postClose(jst(T, 10, 2), "beta", D, NEXT, [a1], closed)).ok).toBe(false);
    expect((await w.postClose(jst(T, 10, 3), "beta", D, NEXT, [a1])).ok).toBe(true);
    // alpha は追加の処理で、beta は普通の処理で、同じ配当を1回ずつ受け取る
    expect((await w.postClose(jst(T, 10, 4), "alpha", D, NEXT, [a1], closed)).ok).toBe(true);
    expect(w.ledger.account("beta").cash).toBe(w.ledger.account("alpha").cash);
  });

  it("停止中のAIにも追加の処理を書け、反映される（停止は評価を止めない、§4）", async () => {
    const w = await start();
    const a1 = await w.announce(jst(D, 16), NEXT, { kind: "dividend", perShare: 500 });
    await w.add(w.op("agent.suspended", jst(D, 17), { agentId: "*", scope: "both", reason: "x" }));
    const closed = await w.closeMarket(jst(T, 7));
    expect((await w.postClose(jst(T, 10), "alpha", D, NEXT, [a1], closed)).ok).toBe(true);
    expect(w.ledger.account("alpha").cash).toBe(INITIAL_CASH - 100 * 10_000 + 100 * 500);
  });
});

describe("先読み（§3.3「端数の換金に使う終値：その銘柄の直近の終値」）", () => {
  // 追加の処理を NEXT の終値のあとに書くと、端数の換金に NEXT の終値を使えるか。D の時点の口座への反映なので、D の終値（11,000）を使うはず
  it("NEXT の終値のあとに書いた追加の処理でも、分割の端数は D の終値で換金する", async () => {
    const w = await start();
    // 100株の 3→1 の併合で、33株と端数（1/3株）が出る
    const a1 = await w.announce(jst(D, 16), NEXT, { kind: "split", from: 3, to: 1 });
    const closed = await w.closeMarket(jst(T, 7));
    await w.add(w.sys("prices.open", jst(NEXT, 9), { date: NEXT, valuesHash: await w.store.put({ AAA: 30_000 }) }));
    await w.add(w.sys("prices.close", jst(NEXT, 15, 30), { date: NEXT, valuesHash: await w.store.put({ AAA: 33_000 }) }));
    const ca = await w.ledger.computeCorporate("alpha", D, NEXT, [a1]);
    const split = (ca.payload.actions as { kind: string; close: number | null; closeSeq?: number }[]).find((x) => x.kind === "split");
    expect(split?.close).toBe(11_000);
    expect(split?.closeSeq).toBe(w.close);
    expect((await w.postClose(jst(NEXT, 15, 41), "alpha", D, NEXT, [a1], closed)).ok).toBe(true);
  });

  // 追記の検査は反映した内容を見ない。端数の換金を NEXT の終値にすり替えた記録は、台帳の再計算（Ledger.apply・replay）で落ちること
  it("NEXT の終値で換金したと偽った追加の処理は、台帳の再計算と replay で落ちる", async () => {
    const w = await start();
    const a1 = await w.announce(jst(D, 16), NEXT, { kind: "split", from: 3, to: 1 });
    const closed = await w.closeMarket(jst(T, 7));
    await w.add(w.sys("prices.open", jst(NEXT, 9), { date: NEXT, valuesHash: await w.store.put({ AAA: 30_000 }) }));
    const closeNext = await w.add(w.sys("prices.close", jst(NEXT, 15, 30), { date: NEXT, valuesHash: await w.store.put({ AAA: 33_000 }) }));
    const ca = await w.ledger.computeCorporate("alpha", D, NEXT, [a1]);
    const actions = (ca.payload.actions as Record<string, unknown>[]).map((x) => (x.kind === "split" ? { ...x, close: 33_000, closeSeq: closeNext, cashInLieu: Math.round((33_000 * 1) / 3) } : x));
    expect(actions.some((x) => x.closeSeq === closeNext)).toBe(true);
    const r = await w.log.append(w.sys("corporate_actions.applied", jst(NEXT, 15, 41), { agentId: "alpha", asOf: D, exDate: NEXT, announcedSeqs: [a1], closedSeq: closed, ...ca.payload, actions }, [a1, closed]));
    expect(r.ok).toBe(true); // いまの追記の検査は通す（反映した内容は台帳が確かめる）
    if (!r.ok) return;
    await expect(w.ledger.apply(r.event)).rejects.toThrow(/recomputed/);
    await expect(replay(w.log.events, w.store, CTX)).rejects.toThrow(/recomputed/);
  });
});

describe("二重の反映（§3.3「1回だけ」）", () => {
  it("追加の処理のあとは、同じ公表を普通の引け後処理でも、別の closedSeq でも、もう一度は書けない", async () => {
    const w = await start();
    const a1 = await w.announce(jst(D, 16), NEXT, { kind: "dividend", perShare: 500 });
    const closed = await w.closeMarket(jst(T, 7));
    expect((await w.postClose(jst(T, 10), "alpha", D, NEXT, [a1], closed)).ok).toBe(true);
    const again = await w.postClose(jst(T, 10, 1), "alpha", D, NEXT, [a1], closed);
    expect(again.ok || again.reason).toMatch(/no market closure to catch up|ca:alpha/);
    const plain = await w.postClose(jst(T, 10, 2), "alpha", D, NEXT, [a1]);
    expect(plain.ok || plain.reason).toMatch(/value the day before/);
    const other = await w.postClose(jst(T, 10, 3), "alpha", D, NEXT, [a1], a1);
    expect(other.ok).toBe(false);
    expect(w.ledger.account("alpha").cash).toBe(INITIAL_CASH - 100 * 10_000 + 100 * 500);
  });
});
