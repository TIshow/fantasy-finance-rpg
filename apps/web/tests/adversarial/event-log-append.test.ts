// 検証役（#59 PR-1）：追記の処理（docs/EVENT_LOG.md §3・§4）を、先読み・二重反映・権限・保存済みログの照合の面から壊しにいく。
// 期待は実装ではなく文書から書く。欠陥の再現は it.fails にして、直ったら it に戻す。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { sealEvent, verifyChain } from "../../src/events/chain";
import { EVENT_TYPES, type EventType, type LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/table";
import { cutoffOf, newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Order } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const SHA = "b".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: SHA, dates: new Set() };
const CTX = { holidayTables: new Map([[SHA, TABLE]]), accountOf: () => newAccount() };
const buy: Order[] = [{ symbol: "AAA", side: "buy", qty: 100 }];

const sys = (type: EventType, recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });
const op = (type: EventType, recordedAt: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt, actor: "operator:owner", refs: [], payload });

async function ok(log: EventLog, d: Draft): Promise<number> {
  const r = await log.append(d);
  if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
  return r.event.seq;
}

/** 11/9（月）夜に alpha を登録し、出典1件と注文の agent.run を書いたログ */
async function setup() {
  const log = new EventLog(CTX);
  await ok(log, op("holidays.adopted", 0, { holidaysSha256: SHA }));
  await ok(log, op("universe.set", 0, { symbols: ["AAA"] }));
  await ok(log, op("agent.registered", jst("2026-11-09", 20), { agentId: "alpha", startDate: "2026-11-10", initialCash: INITIAL_CASH }));
  const src = await ok(log, sys("source.captured", jst("2026-11-09", 21), { publishedAt: jst("2026-11-09", 19), fetchedAt: jst("2026-11-09", 21) }));
  const run = await ok(log, sys("agent.run", jst("2026-11-09", 22), { agentId: "alpha", purpose: "order", inputSeqs: [src], ok: true }, [src]));
  return { log, src, run };
}

/** 保存済みのログを、新しい追記の処理で先頭から読み直す（replay と同じ入口）。最初の問題を返す */
async function admitAll(events: readonly LogEvent[]): Promise<string | null> {
  const log = new EventLog(CTX);
  for (const e of events) {
    const p = await log.admit(e);
    if (p) return p;
  }
  return null;
}

/** 検査を通さず、連鎖だけ正しく作り直したログ（DBに書ける者の改ざん） */
async function forge(drafts: readonly (Draft & { keys?: string[] })[]): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  for (const d of drafts) out.push(await sealEvent(out.at(-1) ?? null, { ...d, keys: d.keys ?? [] }));
  return out;
}
const draftOf = (e: LogEvent): Draft & { keys: string[] } => ({ type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: e.payload as Record<string, unknown> });

describe("先読み（§3.1・§3.2）", () => {
  it("出典は 公開 ≤ 取得 ≤ 記録 でなければ書けない（境界の等号は通す）", async () => {
    const { log } = await setup();
    const at = jst("2026-11-10", 7);
    const src = (publishedAt: unknown, fetchedAt: unknown) => log.append(sys("source.captured", at, { publishedAt, fetchedAt }));
    expect((await src(at + 1, at + 1)).ok).toBe(false);
    expect((await src(at - 1, at + 1)).ok).toBe(false);
    expect((await src(at - 1, at - 2)).ok).toBe(false);
    expect((await src(-1, at)).ok).toBe(false);
    expect((await src(String(at - 1), at)).ok).toBe(false);
    expect((await src(at - 0.5, at)).ok).toBe(false);
    expect((await src(at, at)).ok).toBe(true);
  });

  it("始値は締め（8:30）以後、終値は15:30以後でなければ書けず、未来の日付も書けない", async () => {
    const { log } = await setup();
    expect((await log.append(sys("prices.open", cutoffOf("2026-11-10") - 1, { date: "2026-11-10" }))).ok).toBe(false);
    expect((await log.append(sys("prices.close", jst("2026-11-10", 15, 29), { date: "2026-11-10" }))).ok).toBe(false);
    expect((await log.append(sys("prices.open", jst("2026-11-10", 9), { date: "2026-11-11" }))).ok).toBe(false);
    expect((await log.append(sys("prices.open", cutoffOf("2026-11-10"), { date: "2026-11-10" }))).ok).toBe(true);
  });

  it("注文票の入力は、元の agent.run の入力の一部でなければならない", async () => {
    const { log, run } = await setup();
    const other = await ok(log, sys("source.captured", jst("2026-11-09", 23), { publishedAt: jst("2026-11-09", 22), fetchedAt: jst("2026-11-09", 23) }));
    const r = await log.commitSheet(jst("2026-11-10", 8), "alpha", { tradingDate: "2026-11-10", orders: buy, runSeq: run, inputSeqs: [other] });
    expect(r.rejected).toBe("invalid_sheet");
  });

  it("確定を始値のあとへ入れ替えた保存済みログは、連鎖を作り直しても締めの検査（after_cutoff）で落ちる", async () => {
    const { log, src, run } = await setup();
    await log.commitSheet(jst("2026-11-10", 8), "alpha", { tradingDate: "2026-11-10", orders: buy, runSeq: run, inputSeqs: [src] });
    await ok(log, sys("prices.open", jst("2026-11-10", 9), { date: "2026-11-10" }));
    expect(await admitAll(log.events)).toBeNull();
    const d = log.events.map(draftOf);
    const [sheet, open] = [d.at(-2)!, d.at(-1)!];
    // 時刻が減らないように、確定の時刻を始値の時刻にそろえて入れ替える
    const swapped = await forge([...d.slice(0, -2), open, { ...sheet, recordedAt: open.recordedAt }]);
    // 入れ替えそのものではなく、時刻が減らないことと締めの検査で落ちる
    expect(await admitAll(swapped)).toMatch(/order_sheet\.committed\): after_cutoff/);
  });

  // 注文票の側の検査（inputProblem の input published after the cutoff）は、時刻が減らない限り
  // 公開 ≤ 記録 < 確定 < 締め なので届かない（多重の守り）。ここでは手前の §3.1 が照合の入口でも働くことを確かめる
  it("公開時刻を締めの後に書き換えた出典は、連鎖を作り直しても照合（§3.1）で落ちる", async () => {
    const { log } = await setup();
    const d = log.events.map(draftOf);
    // 出典の公開時刻だけを、約定日の締めのあとに書き換える（記録の時刻より後になる）
    const srcIdx = d.findIndex((x) => x.type === "source.captured");
    d[srcIdx] = { ...d[srcIdx]!, payload: { ...d[srcIdx]!.payload, publishedAt: cutoffOf("2026-11-10") + 1, fetchedAt: cutoffOf("2026-11-10") + 1 } };
    expect(await admitAll(await forge(d))).toMatch(/source\.captured\): need publishedAt <= fetchedAt <= recordedAt/);
  });
});

describe("二重反映（§4 の一意キー）", () => {
  it("同じ日の2枚目の注文票は確定されず、1枚目の約定待ちは変わらない", async () => {
    const { log, src, run } = await setup();
    const s = { tradingDate: "2026-11-10", orders: buy, runSeq: run, inputSeqs: [src] };
    const first = await log.commitSheet(jst("2026-11-10", 7), "alpha", s);
    expect(first.ok && first.event.type).toBe("order_sheet.committed");
    const second = await log.commitSheet(jst("2026-11-10", 7, 1), "alpha", { ...s, orders: [] });
    expect(second.rejected).toBe("already_committed");
    expect(log.events.filter((e) => e.type === "order_sheet.committed")).toHaveLength(1);
    // 1枚目はそのまま約定できる
    const sheetSeq = first.ok ? first.event.seq : -1;
    const open = await ok(log, sys("prices.open", jst("2026-11-10", 9), { date: "2026-11-10" }));
    await ok(log, sys("fills.executed", jst("2026-11-10", 9, 1), { agentId: "alpha", tradingDate: "2026-11-10", sheetSeq, openSeq: open }, [sheetSeq, open]));
  });

  // 追記の処理では、別の日の引け後処理に同じ公表を渡すと、手前の exDate の検査で先に落ちる（ca: のキーに届くのは訂正で
  // 権利落ち日が変わった場合で、訂正の実装は別のPR）。ここではキーそのものが、連鎖の検査と封じる処理で効くことを確かめる
  it("同じ公表の ca: キーを2回使った保存済みログは、連鎖の検査で落ち、封じる処理も拒む", async () => {
    const { log } = await setup();
    const ann = await ok(log, sys("corporate_action.announced", jst("2026-11-09", 23), { symbol: "AAA", kind: "dividend", exDate: "2026-11-11" }));
    const close = await ok(log, sys("prices.close", jst("2026-11-10", 15, 40), { date: "2026-11-10" }));
    await ok(log, sys("valuation.recorded", jst("2026-11-10", 15, 41), { agentId: "alpha", date: "2026-11-10", closeSeq: close }, [close]));
    const applied = await log.append(sys("corporate_actions.applied", jst("2026-11-10", 15, 42), { agentId: "alpha", asOf: "2026-11-10", exDate: "2026-11-11", announcedSeqs: [ann] }, [ann]));
    expect(applied.ok && applied.event.keys).toContain(`ca:alpha:${ann}`);
    const d = log.events.map(draftOf);
    const again = { ...d.at(-1)!, recordedAt: jst("2026-11-11", 15, 42), keys: ["post_close:alpha:2026-11-11", `ca:alpha:${ann}`], payload: { ...d.at(-1)!.payload, asOf: "2026-11-11" } };
    const forged = [...log.events, await sealEvent(log.events.at(-1)!, again)];
    expect(await verifyChain(forged)).toContainEqual(expect.stringMatching(new RegExp(`duplicate key ca:alpha:${ann}$`)));
    await expect(sealEvent(log.events.at(-1)!, again, new Set(log.events.flatMap((e) => e.keys)))).rejects.toThrow(`duplicate key ca:alpha:${ann}`);
  });

  it("同じ日付の始値・終値・臨時休場は2回書けない", async () => {
    const { log } = await setup();
    await ok(log, sys("prices.open", jst("2026-11-10", 9), { date: "2026-11-10" }));
    expect((await log.append(sys("prices.open", jst("2026-11-10", 9, 1), { date: "2026-11-10" }))).ok).toBe(false);
    await ok(log, sys("prices.close", jst("2026-11-10", 15, 40), { date: "2026-11-10" }));
    expect((await log.append(sys("prices.close", jst("2026-11-10", 15, 41), { date: "2026-11-10" }))).ok).toBe(false);
    await ok(log, op("market.closed", jst("2026-11-10", 16), { date: "2026-11-12", reason: "x" }));
    expect((await log.append(op("market.closed", jst("2026-11-10", 16, 1), { date: "2026-11-12", reason: "x" }))).ok).toBe(false);
  });
});

describe("権限（§3 の書ける者・AIの身元）", () => {
  // 文書の表から独立に書き写した「書ける者」
  const DOC_WRITER: Record<EventType, "system" | "operator" | "agent"> = {
    "source.captured": "system", "prices.open": "system", "prices.close": "system", "corporate_action.announced": "system",
    "market.closed": "operator", "holidays.adopted": "operator", "universe.set": "operator", "agent.registered": "operator", "company.listed": "system",
    "agent.run": "system", "post.published": "agent", "order_sheet.committed": "agent", "order_sheet.rejected": "system",
    "fills.executed": "system", "valuation.recorded": "system", "corporate_actions.applied": "system",
    "correction.issued": "operator", "ledger.adjusted": "operator", "content.withdrawn": "operator",
    "agent.suspended": "operator", "agent.resumed": "operator",
  };
  const ACTORS = { system: "system", operator: "operator:owner", agent: "agent:alpha" } as const;
  // 一意キーが作れる中身にして、書ける者の検査より前で落ちないようにする（公表のキーは銘柄・種類・権利落ち日。#67）
  const payload = { agentId: "alpha", symbol: "AAA", kind: "dividend", exDate: "2026-11-11", date: "2026-11-10", tradingDate: "2026-11-10", asOf: "2026-11-10", announcedSeqs: [], correctionSeq: 1 };

  it("文書の表に全種類があり、表の書ける者以外の追記はすべて拒む", async () => {
    expect(Object.keys(DOC_WRITER).sort()).toEqual([...EVENT_TYPES].sort());
    const { log } = await setup();
    const before = log.events.length;
    for (const type of EVENT_TYPES) {
      for (const [kind, actor] of Object.entries(ACTORS)) {
        if (kind === DOC_WRITER[type]) continue;
        const r = await log.append({ type, recordedAt: jst("2026-11-09", 23), actor, refs: [], payload });
        expect(r.ok, `${type} by ${actor}`).toBe(false);
        if (!r.ok) expect(r.reason, `${type} by ${actor}`).toMatch(/must be written by|use commitSheet/);
      }
    }
    expect(log.events).toHaveLength(before);
  });

  it("保存済みログでも、運営者・システムの名で書いた注文票と、AIの名で書いた拒否は照合で落ちる", async () => {
    const { log, src, run } = await setup();
    await log.commitSheet(jst("2026-11-10", 8), "alpha", { tradingDate: "2026-11-10", orders: buy, runSeq: run, inputSeqs: [src] });
    const d = log.events.map(draftOf);
    for (const actor of ["system", "operator:owner", "agent:beta"] as const) {
      expect(await admitAll(await forge([...d.slice(0, -1), { ...d.at(-1)!, actor }])), actor).not.toBeNull();
    }
    for (const actor of ["agent:alpha", "operator:owner"] as const) {
      const rejected = { ...d.at(-1)!, type: "order_sheet.rejected" as const, actor, keys: [], payload: { agentId: "alpha", tradingDate: "2026-11-10", reason: "suspended" } };
      expect(await admitAll(await forge([...d.slice(0, -1), rejected])), actor).toMatch(/must be written by system/);
    }
  });

  it("投稿は、中身のAIのIDと身元が違えば、また他のAIの agent.run を元にしては書けない", async () => {
    const { log } = await setup();
    await ok(log, op("agent.registered", jst("2026-11-09", 22, 10), { agentId: "beta", startDate: "2026-11-10", initialCash: INITIAL_CASH }));
    const betaRun = await ok(log, sys("agent.run", jst("2026-11-09", 23), { agentId: "beta", purpose: "post", inputSeqs: [], ok: true }));
    const post = (actor: Draft["actor"], agentId: unknown) => log.append({ type: "post.published", recordedAt: jst("2026-11-09", 23, 1), actor, refs: [betaRun], payload: { agentId, runSeq: betaRun } });
    expect((await post("agent:alpha", "beta")).ok).toBe(false);
    expect((await post("agent:alpha", "alpha")).ok).toBe(false);
    expect((await post("agent:alpha", ["alpha"])).ok).toBe(false);
    expect((await post("agent:beta", "beta")).ok).toBe(true);
  });

  it("注文の停止中（個別・全体）は確定できず、投稿だけの停止では確定でき、確定済みの約定は停止後も書ける", async () => {
    for (const target of ["alpha", "*"]) {
      const { log, src, run } = await setup();
      const s = { tradingDate: "2026-11-10", orders: buy, runSeq: run, inputSeqs: [src] };
      await ok(log, op("agent.suspended", jst("2026-11-10", 6), { agentId: target, scope: "posts", reason: "x" }));
      await ok(log, op("agent.suspended", jst("2026-11-10", 6, 1), { agentId: target, scope: "orders", reason: "x" }));
      expect((await log.commitSheet(jst("2026-11-10", 6, 2), "alpha", s)).rejected, target).toBe("suspended");
      await ok(log, op("agent.resumed", jst("2026-11-10", 6, 3), { agentId: target, scope: "orders", reason: "x" }));
      const r = await log.commitSheet(jst("2026-11-10", 6, 4), "alpha", s);
      expect(r.ok && r.event.type, target).toBe("order_sheet.committed");
      await ok(log, op("agent.suspended", jst("2026-11-10", 7), { agentId: target, scope: "both", reason: "x" }));
      const open = await ok(log, sys("prices.open", jst("2026-11-10", 9), { date: "2026-11-10" }));
      const sheetSeq = r.ok ? r.event.seq : -1;
      await ok(log, sys("fills.executed", jst("2026-11-10", 9, 1), { agentId: "alpha", tradingDate: "2026-11-10", sheetSeq, openSeq: open }, [sheetSeq, open]));
      expect(await admitAll(log.events), target).toBeNull();
    }
  });
});

describe("拒否の記録（§3.2「受け取った注文の並びを残す」・§7 の照合）", () => {
  const readable = (e: LogEvent) => e.payload as Record<string, unknown>;

  // #73 で直った欠陥（中）：理由が invalid_sheet 以外で、runSeq・inputSeqs が前のイベントを指さないと、拒否には seq を残さない（append.ts commitSheet）。
  // すると照合の検査（check の order_sheet.rejected）が理由を invalid_sheet と出し直して記録の理由と合わず、1回目の書き込みが落ちる。
  // commitSheet は ordersUnreadable: true で書き直すので、正規化できる注文の並びが捨てられ、「読めなかった」と偽って残る
  it("停止中のAIが、存在しない run を指す注文票を出したとき、受け取った注文を残す", async () => {
    const { log, src } = await setup();
    await ok(log, op("agent.suspended", jst("2026-11-10", 6), { agentId: "alpha", scope: "orders", reason: "x" }));
    const r = await log.commitSheet(jst("2026-11-10", 7), "alpha", { tradingDate: "2026-11-10", orders: buy, runSeq: 0, inputSeqs: [src] });
    expect(r.rejected).toBe("suspended");
    expect(r.ok && readable(r.event)).toMatchObject({ reason: "suspended", orders: buy });
  });

  // 同じ欠陥の別の入口：注文の形が違う（invalid_order）とき、inputSeqs が未来の seq を指すと同じことが起きる
  it("注文の形が違い、inputSeqs が未来の seq を指す注文票でも、受け取った注文を残す", async () => {
    const { log, run } = await setup();
    const orders = [1 as unknown as Order];
    const r = await log.commitSheet(jst("2026-11-10", 7), "alpha", { tradingDate: "2026-11-10", orders, runSeq: run, inputSeqs: [999] });
    expect(r.rejected).toBe("invalid_order");
    expect(r.ok && readable(r.event)).toMatchObject({ reason: "invalid_order", orders });
  });

  // #73 で直った欠陥（低）：ordersUnreadable の拒否は、理由を出し直さずに受け入れる。停止していないAIを「停止中で拒否した」と書いた保存済みログが照合を通る
  it("停止していないAIに、理由 suspended の読めない拒否を足した保存済みログは照合で落ちる", async () => {
    const { log } = await setup();
    expect(await admitAll(log.events)).toBeNull();
    const d = log.events.map(draftOf);
    const fake = { type: "order_sheet.rejected" as const, recordedAt: jst("2026-11-10", 7), actor: "system" as const, refs: [], keys: [], payload: { agentId: "alpha", tradingDate: "2026-11-10", reason: "suspended", ordersUnreadable: true } };
    expect(await admitAll(await forge([...d, fake]))).not.toBeNull();
  });

  it("ほかの拒否（形の違う seq、正規化できない注文、日付の誤り）は、読める注文を残し、照合を通る", async () => {
    const { log, src, run } = await setup();
    const sheets: [Parameters<EventLog["commitSheet"]>[2], boolean][] = [
      [{ tradingDate: "2026-11-10", orders: buy, runSeq: 0, inputSeqs: [src] }, true],
      [{ tradingDate: "2026-11-10", orders: buy, runSeq: "1" as unknown as number, inputSeqs: [src] }, true],
      [{ tradingDate: "2026-11-10", orders: [{ symbol: "AAA", side: "buy", qty: 0.5 }], runSeq: run, inputSeqs: [src] }, false],
      [{ tradingDate: "2026-11-10", orders: [{ symbol: "e\u0301", side: "buy", qty: 100 }], runSeq: run, inputSeqs: [src] }, false],
      [{ tradingDate: "2026-11-11", orders: buy, runSeq: run, inputSeqs: [src] }, true],
      [{ tradingDate: "nope", orders: buy, runSeq: run, inputSeqs: [src] }, true],
    ];
    for (const [i, [s, canKeep]] of sheets.entries()) {
      const r = await log.commitSheet(jst("2026-11-10", 7, i), "alpha", s);
      expect(r.rejected, String(i)).toBeDefined();
      expect(r.ok && readable(r.event).ordersUnreadable === undefined, String(i)).toBe(canKeep);
    }
    expect(await admitAll(log.events)).toBeNull();
  });
});
