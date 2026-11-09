// 検証役（#67 の実装 #89 の確認）：企業行動の公表（corporate_action.announced）の一意キー・時刻の制約・種類の照合を壊しにいく。
// 成り立つはずのこと（#67 の lead の決定と EVENT_LOG §3・§3.3）：
// (1) キーは announce:<銘柄>:<種類>:<権利落ち日>。同じキーの2回目は拒み、台帳は1回分だけ変わる。表記の揺れでキーを逃れられない
// (2) 権利落ち日 X の公表は、X の前営業日の引け後処理を済ませたAIがいれば拒む（開始日が X 以後のAIは数えない。臨時休場の追加の処理を待つあいだは書ける）
// (3) 権利落ち日は、その時点の休場日で営業日。一覧の外は例外にせず理由を返して拒む
// (4) ログの kind とログの外の値の種類が違えば、台帳と replay が止まる。書けるのは system だけ
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { sealEvent } from "../../src/events/chain";
import { bodyHash } from "../../src/events/hash";
import { Ledger, replay, type ValueStore } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/table";
import { INITIAL_CASH } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const SHA = "d".repeat(64);
/** 11/23（月）は祝日 */
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: SHA, dates: new Set(["2026-11-23"]) };
const CTX = { holidayTables: new Map([[SHA, TABLE]]) };
const [D, NEXT] = ["2026-11-10", "2026-11-11"];

class Store implements ValueStore {
  readonly map = new Map<string, { salt: Uint8Array; value: unknown }>();
  async put(value: unknown) {
    const salt = new Uint8Array(16).fill(this.map.size + 3);
    const hash = await bodyHash(salt, { value });
    this.map.set(hash, { salt, value });
    return hash;
  }
  get(hash: string) {
    return this.map.get(hash);
  }
}

/** alpha・beta が D に AAA を100株買ったログ（D の評価の前で止まる） */
async function start(agents = ["alpha", "beta"]) {
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
  await add(op("holidays.adopted", 0, { holidaysSha256: SHA }));
  await add(op("universe.set", 0, { symbols: ["AAA"] }));
  for (const [i, id] of agents.entries()) await add(op("agent.registered", jst("2026-11-09", 20, i), { agentId: id, startDate: D, initialCash: INITIAL_CASH }));
  const sheets: number[] = [];
  for (const [i, id] of agents.entries()) {
    const run = await add(sys("agent.run", jst(D, 7, 2 * i), { agentId: id, purpose: "order", inputSeqs: [], ok: true }));
    const c = await log.commitSheet(jst(D, 7, 2 * i + 1), id, { tradingDate: D, orders: [{ symbol: "AAA", side: "buy", qty: 100 }], runSeq: run, inputSeqs: [] });
    if (!c.ok || c.rejected) throw new Error("commit failed");
    await ledger.apply(c.event);
    sheets.push(c.event.seq);
  }
  const open = await add(sys("prices.open", jst(D, 9), { date: D, valuesHash: await store.put({ AAA: 10_000 }) }));
  for (const [i, id] of agents.entries()) {
    const f = await ledger.computeFills(id, sheets[i]!, open);
    await add(sys("fills.executed", jst(D, 9, 1 + i), { agentId: id, tradingDate: D, sheetSeq: sheets[i], openSeq: open, ...f.payload }, [sheets[i]!, open]));
  }
  const close = await add(sys("prices.close", jst(D, 15, 30), { date: D, valuesHash: await store.put({ AAA: 11_000 }) }));
  /** 公表の draft（値は store に入れる） */
  const draftOf = async (at: number, p: Record<string, unknown>, value: unknown = { kind: p.kind, perShare: 500 }) => sys("corporate_action.announced", at, { symbol: "AAA", ...p, valuesHash: await store.put(value) });
  const announce = async (at: number, p: Record<string, unknown>, value?: unknown) => append(await draftOf(at, p, value));
  /** id の D の評価と引け後処理（exDate は NEXT） */
  const postClose = async (at: number, id: string, announcedSeqs: number[]) => {
    await add(sys("valuation.recorded", at, { agentId: id, date: D, closeSeq: close, ...ledger.computeValuation(id, D) }, [close]));
    const ca = await ledger.computeCorporate(id, D, NEXT, announcedSeqs);
    return append(sys("corporate_actions.applied", at + 1, { agentId: id, asOf: D, exDate: NEXT, announcedSeqs, ...ca.payload }, announcedSeqs));
  };
  return { store, ledger, log, append, add, sys, op, draftOf, announce, postClose, close };
}

/** 保存済みのログを連鎖だけ正しく作り直したもの（DBに書ける者の改ざん） */
async function reseal(events: readonly LogEvent[]): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  for (const e of events) out.push(await sealEvent(out.at(-1) ?? null, { type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: e.payload as Record<string, unknown> }));
  return out;
}

describe("(1) 一意キー announce:<銘柄>:<種類>:<権利落ち日>", () => {
  it("同じ公表の2回目は、値・時刻が違っても拒み、配当は1回分だけ入る。同じ日の分割と配当は両方書ける", async () => {
    const w = await start(["alpha"]);
    const first = await w.announce(jst(D, 15, 31), { kind: "dividend", exDate: NEXT });
    expect(first.ok).toBe(true);
    for (const [i, value] of [{ kind: "dividend", perShare: 500 }, { kind: "dividend", perShare: 900 }].entries()) {
      const again = await w.announce(jst(D, 15, 32 + i), { kind: "dividend", exDate: NEXT }, value);
      expect(again.ok || again.reason, String(i)).toMatch(/duplicate key announce:AAA:dividend:2026-11-11/);
    }
    const split = await w.announce(jst(D, 15, 35), { kind: "split", exDate: NEXT }, { kind: "split", from: 1, to: 2 });
    expect(split.ok).toBe(true);
    if (!first.ok || !split.ok) return;
    expect((await w.postClose(jst(D, 15, 40), "alpha", [first.event.seq, split.event.seq])).ok).toBe(true);
    const a = w.ledger.account("alpha");
    expect([a.cash, a.holdings.AAA?.qty]).toEqual([INITIAL_CASH - 100 * 10_000 + 100 * 500, 200]);
    expect((await replay(w.log.events, w.store, CTX)).account("alpha")).toEqual(a);
  });

  it("表記の揺れ（銘柄・種類・権利落ち日）でキーを逃れて、同じ公表を2回書けない", async () => {
    const w = await start(["alpha"]);
    expect((await w.announce(jst(D, 15, 31), { kind: "dividend", exDate: NEXT })).ok).toBe(true);
    const variants: Record<string, unknown>[] = [
      { symbol: "aaa", kind: "dividend", exDate: NEXT },
      { symbol: "AAA ", kind: "dividend", exDate: NEXT },
      { symbol: "ＡＡＡ", kind: "dividend", exDate: NEXT },
      { kind: "Dividend", exDate: NEXT },
      { kind: "dividend ", exDate: NEXT },
      { kind: ["dividend"], exDate: NEXT },
      { kind: "dividend", exDate: "2026-11-11T00:00:00+09:00" },
      { kind: "dividend", exDate: " 2026-11-11" },
      { kind: "dividend", exDate: "2026-11-11 " },
      { kind: "dividend", exDate: "20261111" },
      { kind: "dividend", exDate: "2026-11-1" },
      { kind: "dividend", exDate: "２０２６-11-11" },
      { kind: "dividend", exDate: Date.parse(`${NEXT}T00:00:00+09:00`) },
      { kind: "dividend", exDate: ["2026-11-11"] },
      { kind: "dividend", exDate: null },
      { kind: "dividend" },
    ];
    for (const [i, p] of variants.entries()) {
      const r = await w.announce(jst(D, 15, 32 + i), p, { kind: "dividend", perShare: 500 });
      const want = "symbol" in p ? /invalid symbol/ : typeof p.kind !== "string" || p.kind !== "dividend" ? /invalid kind/ : /invalid exDate/;
      expect(r.ok || r.reason, `${i} ${JSON.stringify(p)}`).toMatch(want);
    }
    expect(w.log.events.filter((e) => e.type === "corporate_action.announced")).toHaveLength(1);
  });

  it("同じキーの公表を2件含む保存済みログは、照合で落ちる", async () => {
    const w = await start(["alpha"]);
    const first = await w.announce(jst(D, 15, 31), { kind: "dividend", exDate: NEXT });
    if (!first.ok) throw new Error(first.reason);
    const dup = { ...first.event, recordedAt: first.event.recordedAt + 1, payload: { ...(first.event.payload as Record<string, unknown>), valuesHash: await w.store.put({ kind: "dividend", perShare: 900 }) } };
    const forged = await reseal([...w.log.events, dup]);
    await expect(replay(forged, w.store, CTX)).rejects.toThrow(/duplicate key announce:AAA:dividend:2026-11-11/);
  });
});

describe("(2) 遅れた公表", () => {
  it("どれか1人でも前営業日の引け後処理を済ませていれば拒む。済ませる前なら書ける", async () => {
    const w = await start();
    expect((await w.postClose(jst(D, 15, 40), "alpha", [])).ok).toBe(true);
    // beta はまだ D の引け後処理をしていないが、alpha が済ませたので、NEXT が権利落ち日の公表はもう書けない
    const late = await w.announce(jst(D, 15, 45), { kind: "dividend", exDate: NEXT });
    expect(late.ok || late.reason).toMatch(/agent alpha already finished the post-close of 2026-11-10/);
    // NEXT の次の営業日の公表は、まだ誰も NEXT の引け後処理をしていないので書ける
    expect((await w.announce(jst(D, 15, 46), { kind: "dividend", exDate: "2026-11-12" })).ok).toBe(true);
  });

  it("前営業日の評価だけ済ませ、引け後処理の前なら書ける（その引け後処理で渡される）", async () => {
    const w = await start(["alpha"]);
    await w.add(w.sys("valuation.recorded", jst(D, 15, 40), { agentId: "alpha", date: D, closeSeq: w.close, ...w.ledger.computeValuation("alpha", D) }, [w.close]));
    const ann = await w.announce(jst(D, 15, 41), { kind: "dividend", exDate: NEXT });
    expect(ann.ok).toBe(true);
    // 引け後処理は、評価の前の公表と同じく、この公表を渡さなければ書けない
    const ca = await w.ledger.computeCorporate("alpha", D, NEXT, []);
    const skip = await w.append(w.sys("corporate_actions.applied", jst(D, 15, 42), { agentId: "alpha", asOf: D, exDate: NEXT, announcedSeqs: [], ...ca.payload }));
    expect(skip.ok).toBe(false);
  });

  it("開始日が権利落ち日以後のAIは数えない（締めのあとに登録したAIでも、まだ反映できる公表を拒まない）", async () => {
    const w = await start(["alpha"]);
    // D の締めのあとに gamma を登録すると、開始日は NEXT、asOf は D になる（引け後処理はしていない）
    await w.add(w.op("agent.registered", jst(D, 15, 35), { agentId: "gamma", startDate: NEXT, initialCash: INITIAL_CASH }));
    expect((await w.announce(jst(D, 15, 36), { kind: "dividend", exDate: NEXT })).ok).toBe(true);
  });

  it("臨時休場の追加の処理を待つあいだだけ書ける。1人でも追加の処理を書いたら、同じ権利落ち日の別の公表はもう書けない", async () => {
    const w = await start();
    for (const [i, id] of ["alpha", "beta"].entries()) expect((await w.postClose(jst(D, 15, 40 + 2 * i), id, [])).ok).toBe(true);
    const moved = "2026-11-12";
    // 休場の前は、NEXT の引け後処理を誰もしていないので 11/12 の公表は書ける。ここでは休場のあとに出す
    const closed = await w.add(w.op("market.closed", jst(NEXT, 7), { date: NEXT, reason: "test" }));
    const div = await w.announce(jst(NEXT, 8), { kind: "dividend", exDate: moved });
    expect(div.ok).toBe(true);
    if (!div.ok) return;
    const ca = await w.ledger.computeCorporate("alpha", D, moved, [div.event.seq]);
    await w.add(w.sys("corporate_actions.applied", jst(NEXT, 9), { agentId: "alpha", asOf: D, exDate: moved, announcedSeqs: [div.event.seq], closedSeq: closed, ...ca.payload }, [div.event.seq, closed]));
    // beta はまだ追加の処理を待っているが、alpha はもう 11/12 の公表を受け取れない
    const split = await w.announce(jst(NEXT, 10), { kind: "split", exDate: moved }, { kind: "split", from: 1, to: 2 });
    expect(split.ok || split.reason).toMatch(/agent alpha already finished the post-close of 2026-11-10/);
    // 休場の日そのものは営業日でないので書けない
    const onClosed = await w.announce(jst(NEXT, 10, 1), { kind: "split", exDate: NEXT }, { kind: "split", from: 1, to: 2 });
    expect(onClosed.ok || onClosed.reason).toMatch(/business day/);
  });

  // 決定（開始日が権利落ち日以後のAIは数えない）のとおりの振る舞いを固める。どの引け後処理にも渡らない過去の公表が書ける。
  // 台帳は変わらないが、「遅れた公表は黙って残さず拒む」の例外になる（issue #67 で lead に確認）
  it("数えるAIがいなければ、過去の権利落ち日の公表も書ける（決定どおり。台帳は変わらない）", async () => {
    const w = await start(["alpha"]);
    expect((await w.postClose(jst(D, 15, 40), "alpha", [])).ok).toBe(true);
    const before = w.ledger.account("alpha");
    for (const exDate of ["2026-11-02", D]) {
      const r = await w.announce(jst(D, 16), { kind: "dividend", exDate });
      expect(r.ok, exDate).toBe(true);
    }
    expect(w.ledger.account("alpha")).toEqual(before);
  });

  it("前営業日の引け後処理のあとに並べ替えた公表を含む保存済みログは、照合で落ちる", async () => {
    const w = await start(["alpha"]);
    const ann = await w.announce(jst(D, 15, 31), { kind: "dividend", exDate: "2026-11-12" });
    if (!ann.ok) throw new Error(ann.reason);
    expect((await w.postClose(jst(D, 15, 40), "alpha", [])).ok).toBe(true);
    // 公表を末尾へ動かし、権利落ち日を NEXT に書き換える（遅れた公表を、早く出したように見せかけることの逆）
    const events = w.log.events.filter((e) => e.seq !== ann.event.seq);
    const moved = { ...ann.event, recordedAt: jst(D, 16), keys: ["announce:AAA:dividend:2026-11-11"], payload: { ...(ann.event.payload as Record<string, unknown>), exDate: NEXT } };
    await expect(replay(await reseal([...events, moved]), w.store, CTX)).rejects.toThrow(/already finished the post-close/);
  });
});

describe("(3) 権利落ち日は営業日", () => {
  // D-047（#228）：11/9 からは、架空の市場は土日・祝日も取引日。権利落ち日にできる。休みは臨時休場だけ。
  // 11/9 以後の日付は祝日の一覧を引かないので、一覧の範囲の外の年（2028年）でも「一覧の外」にならない（core の PR #230。lead の判断待ち）。
  // 11/9 より前の日付は、前の決まり（東証の営業日、一覧の外は理由を返して拒む）のまま
  it("臨時休場の日・11/9 より前の一覧の外・存在しない日は、例外にならず理由を返して拒む。11/9 以後の土日・祝日は権利落ち日にできる（D-047）", async () => {
    const w = await start(["alpha"]);
    await w.add(w.op("market.closed", jst(D, 15, 31), { date: "2026-11-13", reason: "test" }));
    const cases: [string, RegExp | true][] = [
      ["2026-11-14", true], // 土曜（切り替えのあと）
      ["2026-11-23", true], // 祝日（切り替えのあと）
      ["2026-11-13", /business day/], // 臨時休場
      ["2026-11-07", /business day/], // 切り替えより前の土曜は、前のまま休み
      ["2028-01-05", true], // 一覧の外の年だが、切り替えのあとなので一覧を引かない
      ["2025-12-01", /outside the adopted holiday table/],
      ["2026-02-30", /invalid exDate/],
      ["2026-13-01", /invalid exDate/],
    ];
    for (const [i, [exDate, want]] of cases.entries()) {
      const r = await w.announce(jst(D, 15, 32 + i), { kind: "dividend", exDate });
      if (want === true) expect(r.ok ? true : r.reason, exDate).toBe(true);
      else expect(r.ok || r.reason, exDate).toMatch(want);
    }
  });

  it("祝日の一覧を採用する前の公表は拒む", async () => {
    const store = new Store();
    const log = new EventLog({ ...CTX, accountOf: () => ({ cash: 0, holdings: {} }) });
    const r = await log.append({ type: "corporate_action.announced", recordedAt: 1, actor: "system", refs: [], payload: { symbol: "AAA", kind: "dividend", exDate: NEXT, valuesHash: await store.put({ kind: "dividend", perShare: 1 }) } });
    expect(r.ok).toBe(false);
  });
});

describe("(4) 種類の照合と書ける者", () => {
  it("ログの kind と値の種類が違う公表は、追記で拒むか、台帳がその場で止まり replay も止まる", async () => {
    for (const [kind, value] of [["split", { kind: "dividend", perShare: 500 }], ["dividend", { kind: "split", from: 1, to: 2 }]] as const) {
      const w = await start(["alpha"]);
      const r = await w.log.append(await w.draftOf(jst(D, 15, 31), { kind, exDate: NEXT }, value));
      // いまの追記の検査は値を見ない（値はログの外）。将来、書く前に拒むようになっても、このテストは通る
      if (!r.ok) continue;
      await expect(w.ledger.apply(r.event), kind).rejects.toThrow(/does not match the values/);
      await expect(replay(w.log.events, w.store, CTX), kind).rejects.toThrow(/does not match the values/);
    }
  });

  it("system 以外は書けない（理由は書ける者の検査）", async () => {
    const w = await start(["alpha"]);
    const d = await w.draftOf(jst(D, 15, 31), { kind: "dividend", exDate: NEXT });
    for (const actor of ["operator:owner", "agent:alpha"] as const) {
      const r = await w.log.append({ ...d, actor });
      expect(r.ok || r.reason, actor).toMatch(/must be written by system/);
    }
  });
});
