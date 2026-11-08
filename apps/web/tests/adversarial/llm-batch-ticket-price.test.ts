// 検証役（#179、PR #212）：予約と受け取りの控え（llmReservationOf・llmTicketOf）に入れた予約の料金（reservePrice）を壊しにいく。
// 期待は契約（src/contracts/llm.ts）の説明から書く：控えの料金は①（llm.batch.submitted）の2つの単価と yenPerUsd をそのまま写したもの。
// 閉じるときはこの料金で費用を出し、料金を選び直さない。①と違う料金で作った閉じる記録は断られる。
// 乱数は固定シード。失敗したときは、試験の名前に出したシードと回の番号で同じ入力を作り直せる。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { sealEvent } from "../../src/events/chain";
import { llmCostUsed, llmReservationOf, llmTicketOf, llmTokenCost, type LlmPrice } from "../../src/events/llm-cost";
import type { LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/table";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH } from "../../src/ledger/types";
import { mulberry32, randInt } from "../fixtures/prng";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000+09:00`);
const H = "c".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set(["2026-11-23"]) };
const CTX = { holidayTables: new Map([[H, TABLE]]) };
const newLog = () => new EventLog({ ...CTX, accountOf: () => newAccount() });

async function ok(log: EventLog, d: Draft): Promise<LogEvent> {
  const r = await log.append(d);
  if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
  return r.event;
}
const reason = async (log: EventLog, d: Draft) => {
  const r = await log.append(d);
  return r.ok ? "ok" : r.reason;
};

async function setup() {
  const log = newLog();
  await ok(log, { type: "holidays.adopted", recordedAt: 0, actor: "operator:owner", refs: [], payload: { holidaysSha256: H } });
  await ok(log, { type: "agent.registered", recordedAt: jst("2026-11-09", 8), actor: "operator:owner", refs: [], payload: { agentId: "alpha", startDate: "2026-11-09", initialCash: INITIAL_CASH } });
  return log;
}

const DAY = "2026-11-09";
const TD = "2026-11-10";
const BODY = "b".repeat(64);
const AT = jst(DAY, 16, 35);

interface Reserve extends LlmPrice {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCost: number;
}

const sub = (r: Reserve, at = AT): Draft => ({
  type: "llm.batch.submitted",
  recordedAt: at,
  actor: "system",
  refs: [],
  payload: {
    agentId: "alpha", provider: "gemini", modelId: "m", promptVersion: "v1", sentBodyHash: BODY, customId: `alpha-20261110-${BODY.slice(0, 16)}`,
    maxCost: r.maxCost, tradingDate: TD, submittedAt: at, yenPerUsd: r.yenPerUsd, inputCentsPer10MTok: r.inputCentsPer10MTok, outputCentsPer10MTok: r.outputCentsPer10MTok,
    maxInputTokens: r.maxInputTokens, maxOutputTokens: r.maxOutputTokens, bodyMaxOutputTokens: r.maxOutputTokens,
  },
});
const sent = (s: LogEvent): Draft => ({
  type: "llm.batch.sent", recordedAt: AT, actor: "system", refs: [s.seq],
  payload: { batchSeq: s.seq, agentId: "alpha", provider: "gemini", batchId: `batch_${s.seq}` },
});
interface Tokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
}
/** 控えの料金（または別の料金）で、runner が作るのと同じ形の「受け取った」閉じる記録を作る */
const collected = (s: LogEvent, t: Tokens, price: LlmPrice): Draft => ({
  type: "llm.batch.closed", recordedAt: jst(TD, 7), actor: "system", refs: [s.seq],
  payload: { batchSeq: s.seq, agentId: "alpha", result: "collected", cost: llmTokenCost(t, price), ...t, inputCentsPer10MTok: price.inputCentsPer10MTok, outputCentsPer10MTok: price.outputCentsPer10MTok },
});
/** 送れなかった（notCreated）①の閉じる記録。料金は控えの料金 */
const notCreated = (s: LogEvent, price: LlmPrice): Draft => ({
  type: "llm.batch.closed", recordedAt: AT, actor: "system", refs: [s.seq],
  payload: { batchSeq: s.seq, agentId: "alpha", result: "failed", cost: 0, inputTokens: 0, outputTokens: 0, notCreatedError: "provider_error", inputCentsPer10MTok: price.inputCentsPer10MTok, outputCentsPer10MTok: price.outputCentsPer10MTok },
});

/** 1日の上限（1,000＝100円）に収まる、無作為の予約。単価は Gemini の半セントのような端数のある値も出る */
function randomReserve(rand: () => number): Reserve {
  for (;;) {
    const r = {
      yenPerUsd: randInt(rand, 1, 400),
      inputCentsPer10MTok: randInt(rand, 1, 200_000),
      outputCentsPer10MTok: randInt(rand, 1, 1_000_000),
      maxInputTokens: randInt(rand, 1, 20_000),
      maxOutputTokens: randInt(rand, 1, 20_000),
    };
    const bound = llmTokenCost({ inputTokens: r.maxInputTokens, outputTokens: r.maxOutputTokens }, r)!;
    if (bound <= 900) return { ...r, maxCost: bound + randInt(rand, 0, 1000 - bound) };
  }
}
const priceOf = (r: LlmPrice): LlmPrice => ({ inputCentsPer10MTok: r.inputCentsPer10MTok, outputCentsPer10MTok: r.outputCentsPer10MTok, yenPerUsd: r.yenPerUsd });

const SEED = 0x179212;
const N = 60;

describe("控えの料金は①の料金ちょうど", () => {
  it(`無作為の①（シード ${SEED}、${N}回）で、予約の控えと受け取りの控えの料金が①の3つの値と同じ。ほかの欄はない`, async () => {
    const rand = mulberry32(SEED);
    for (let i = 0; i < N; i++) {
      const r = randomReserve(rand);
      const log = await setup();
      const s = await ok(log, sub(r));
      const t = await ok(log, sent(s));
      const want = priceOf(r);
      expect(llmReservationOf(s).reservePrice, `#${i} ${JSON.stringify(r)}`).toStrictEqual(want);
      expect(llmTicketOf(s, t)!.reservePrice, `#${i} ${JSON.stringify(r)}`).toStrictEqual(want);
      // 保存済みのログを照合し直した（admit した）記録からも、同じ料金になる
      const again = newLog();
      for (const e of log.events) expect(await again.admit(e)).toBeNull();
      expect(llmTicketOf(again.events[s.seq - 1]!, again.events[t.seq - 1]!)!.reservePrice).toStrictEqual(want);
    }
  });

  it("控えの料金を書き換えても、①の記録と、あとで作り直した控えは変わらない（控えは①の値の写しで、①と同じものを指さない）", async () => {
    const r = randomReserve(mulberry32(1));
    const log = await setup();
    const s = await ok(log, sub(r));
    const t = await ok(log, sent(s));
    const ticket = llmTicketOf(s, t)!;
    ticket.reservePrice.inputCentsPer10MTok += 1;
    ticket.reservePrice.yenPerUsd += 1;
    expect((s.payload as Record<string, unknown>).inputCentsPer10MTok).toBe(r.inputCentsPer10MTok);
    expect((s.payload as Record<string, unknown>).yenPerUsd).toBe(r.yenPerUsd);
    expect(llmTicketOf(s, t)!.reservePrice).toStrictEqual(priceOf(r));
    expect(llmReservationOf(s).reservePrice).not.toBe(llmReservationOf(s).reservePrice);
  });
});

describe("控えの料金で作った閉じる記録は通り、①と違う料金で作ったものは断られる", () => {
  it(`無作為の①とトークン数（シード ${SEED + 1}、${N}回）：控えの料金なら通る。今の料金表が変わった想定の単価・円では断られる`, async () => {
    const rand = mulberry32(SEED + 1);
    for (let i = 0; i < N; i++) {
      const r = randomReserve(rand);
      const tokens: Tokens = { inputTokens: randInt(rand, 1, r.maxInputTokens), outputTokens: randInt(rand, 1, r.maxOutputTokens), ...(rand() < 0.3 ? { cacheReadInputTokens: randInt(rand, 0, 1000) } : {}) };
      const label = `#${i} ${JSON.stringify({ r, tokens })}`;
      const log = await setup();
      const s = await ok(log, sub(r));
      const t = await ok(log, sent(s));
      const ticket = llmTicketOf(s, t)!;

      // 今の料金表が変わった想定：単価を上げた・下げた、円を変えた
      const up = (k: "inputCentsPer10MTok" | "outputCentsPer10MTok", d: number): LlmPrice => ({ ...ticket.reservePrice, [k]: Math.max(1, ticket.reservePrice[k] + d) });
      for (const p of [up("inputCentsPer10MTok", 1), up("inputCentsPer10MTok", -1), up("outputCentsPer10MTok", 7), up("outputCentsPer10MTok", -3)]) {
        if (p.inputCentsPer10MTok === r.inputCentsPer10MTok && p.outputCentsPer10MTok === r.outputCentsPer10MTok) continue;
        expect(await reason(log, collected(s, tokens, p)), `${label} ${JSON.stringify(p)}`).toBe("the price must equal the reserved price");
      }
      // 円だけ変えた：閉じる記録に円の欄はない。費用が①の円で出した値と違えば断られる（同じに丸まるなら、記録としては同じもの）
      for (const yen of [ticket.reservePrice.yenPerUsd + 1, Math.max(1, ticket.reservePrice.yenPerUsd - 1), ticket.reservePrice.yenPerUsd * 2]) {
        const p = { ...ticket.reservePrice, yenPerUsd: yen };
        if (llmTokenCost(tokens, p) === llmTokenCost(tokens, ticket.reservePrice)) continue;
        expect(await reason(log, collected(s, tokens, p)), `${label} yen ${yen}`).toMatch(/^cost must be \d+ \(from the tokens and the price\)$/);
      }
      // 控えの料金なら通り、その日の使った額は控えの料金で出した費用
      await ok(log, collected(s, tokens, ticket.reservePrice));
      expect(llmCostUsed(log.events, DAY), label).toBe(llmTokenCost(tokens, priceOf(r)));
    }
  });

  it("送れなかった①（③なし）の費用0の閉じる記録も、予約の控えの料金なら通り、違う単価なら断られる", async () => {
    const rand = mulberry32(SEED + 2);
    for (let i = 0; i < 20; i++) {
      const r = randomReserve(rand);
      const log = await setup();
      const s = await ok(log, sub(r));
      const price = llmReservationOf(s).reservePrice;
      expect(await reason(log, notCreated(s, { ...price, outputCentsPer10MTok: price.outputCentsPer10MTok + 1 })), `#${i}`).toBe("the price must equal the reserved price");
      await ok(log, notCreated(s, price));
      expect(llmCostUsed(log.events, DAY)).toBe(0);
    }
  });

  it("値上げをまたいだ依頼：①は古い料金、閉じるときの料金表は新しい料金。控えの料金で閉じれば通り、新しい料金で閉じると断られる", async () => {
    // Gemini の 2027-01-01 の値上げを想定（入力・出力とも倍）。円も変わった想定
    const old: Reserve = { yenPerUsd: 160, inputCentsPer10MTok: 3_750, outputCentsPer10MTok: 30_000, maxInputTokens: 3_000, maxOutputTokens: 8_000, maxCost: 420 };
    const fresh: LlmPrice = { yenPerUsd: 150, inputCentsPer10MTok: 7_500, outputCentsPer10MTok: 60_000 };
    const tokens = { inputTokens: 2_500, outputTokens: 7_999 };
    const log = await setup();
    const s = await ok(log, sub(old));
    const t = await ok(log, sent(s));
    const ticket = llmTicketOf(s, t)!;
    expect(await reason(log, collected(s, tokens, fresh))).toBe("the price must equal the reserved price");
    // 単価は①のまま、円だけ今の設定から取った場合も断られる
    expect(await reason(log, collected(s, tokens, { ...ticket.reservePrice, yenPerUsd: fresh.yenPerUsd }))).toMatch(/^cost must be/);
    const closed = await ok(log, collected(s, tokens, ticket.reservePrice));
    expect((closed.payload as Record<string, unknown>).cost).toBe(llmTokenCost(tokens, priceOf(old)));
  });
});

describe("①の料金が欠けた・壊れた記録からは、控えを作れない", () => {
  const BAD: readonly unknown[] = [undefined, null, 0, -0, -1, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 1e300, "160", "1", true, [1], { valueOf: () => 160 }, 1n];
  const FIELDS = ["inputCentsPer10MTok", "outputCentsPer10MTok", "yenPerUsd"] as const;

  it("3つの欄のどれかが欠けている・1以上の安全な整数でない①は、予約の控えも受け取りの控えも RangeError（③があってもなくても）", async () => {
    const r = randomReserve(mulberry32(2));
    const log = await setup();
    const s = await ok(log, sub(r));
    const t = await ok(log, sent(s));
    for (const f of FIELDS) {
      for (const v of BAD) {
        const payload: Record<string, unknown> = { ...(s.payload as Record<string, unknown>) };
        if (v === undefined) delete payload[f];
        else payload[f] = v;
        const broken = { seq: s.seq, type: s.type, recordedAt: s.recordedAt, payload };
        const label = `${f}=${typeof v === "bigint" ? "1n" : String(v)}`;
        expect(() => llmReservationOf(broken), label).toThrow(RangeError);
        expect(() => llmTicketOf(broken, t), label).toThrow(RangeError);
        expect(() => llmTicketOf(broken, null), label).toThrow(RangeError);
      }
    }
  });

  it("JSON の __proto__ に料金を入れた①（自分の欄に料金がない）からは控えを作れない", async () => {
    const r = randomReserve(mulberry32(3));
    const log = await setup();
    const s = await ok(log, sub(r));
    const payload = { ...(s.payload as Record<string, unknown>) };
    for (const f of FIELDS) delete payload[f];
    const withProto = { ...JSON.parse(`{"__proto__":{"inputCentsPer10MTok":1,"outputCentsPer10MTok":1,"yenPerUsd":160}}`), ...payload };
    expect(() => llmReservationOf({ seq: s.seq, type: s.type, recordedAt: s.recordedAt, payload: withProto })).toThrow(RangeError);
  });

  it("料金を抜いた①を連鎖ごと作り直した保存済みのログは、照合で①が断られる（控えを作る前に止まる）", async () => {
    const r = randomReserve(mulberry32(4));
    const log = await setup();
    await ok(log, sub(r));
    for (const f of FIELDS) {
      const drafts = log.events.map((e) => ({ type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: { ...(e.payload as Record<string, unknown>) } }));
      delete drafts.at(-1)!.payload[f];
      const forged: LogEvent[] = [];
      for (const d of drafts) forged.push(await sealEvent(forged.at(-1) ?? null, d));
      const again = newLog();
      let problem: string | null = null;
      for (const e of forged) problem ??= await again.admit(e);
      expect(problem, f).toMatch(/yenPerUsd must be a positive integer|prices and max token counts must be non-negative integers/);
    }
  });

  it("①でない記録（③・閉じる記録・AI の登録）からは控えを作れない", async () => {
    const r = randomReserve(mulberry32(5));
    const log = await setup();
    const s = await ok(log, sub(r));
    const t = await ok(log, sent(s));
    const c = await ok(log, collected(s, { inputTokens: 1, outputTokens: 1 }, llmTicketOf(s, t)!.reservePrice));
    for (const e of [t, c, log.events[1]!]) {
      expect(() => llmReservationOf(e), e.type).toThrow(RangeError);
      expect(() => llmTicketOf(e, t), e.type).toThrow(RangeError);
    }
  });
});
