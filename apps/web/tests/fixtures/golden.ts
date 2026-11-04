// ゴールデンログ：PR-2a の架空のシナリオを、既存の EventLog・Ledger と契約の偽物の保管（MemoryEventStore）に流して作る。
// イベントはすべて追記の処理を通し、約定・評価・引け後処理の中身は Ledger が計算する（手で組み立てた偽のイベントは混ぜない）。
// 価格の値と投稿の本文・LLMの出力はログの外に置き、乱数（salt）も固定シードから作るので、同じシードなら同じログになる。
// salt がシードから予測できるのはテスト専用だから。本番の保管で真似しない（EVENT_LOG §5.2 は16バイトの乱数）。
// 入っているのは正常な流れだけ（分割・配当、臨時休場、拒否、停止の場面はない）。
// agent.run の requestHash は、入力の seq とプロンプトの版から決定論的に組み立てたメッセージのハッシュ（§3.2）。
// LLM は呼ばず、計画をそのまま出力とする。
import type { DraftInput } from "../../src/contracts";
import { EventLog } from "../../src/events/append";
import { canonicalize } from "../../src/events/canonical";
import { bodyHash, sha256Hex } from "../../src/events/hash";
import { Ledger, type ValueStore } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { holidaysFor, type HolidayTable } from "../../src/holidays";
import { nextBusinessDay } from "../../src/ledger/calendar";
import { INITIAL_CASH } from "../../src/ledger/types";
import { FakeClock, MemoryEventStore } from "../contracts/fakes";
import { mulberry32 } from "./prng";
import { PRIOR_DAY, buildScenario, type Scenario } from "./scenario";

export type Salted<T> = { salt: Uint8Array; value: T };

/**
 * ゴールデンログが採用する祝日の一覧。2026年の休場日だけを持ち、版（contentSha256）は固定の値にする。
 * 同梱の一覧（holidays.json）の版を使うと、翌年分を足す更新（D-031）のたびに、関係のないログのハッシュが変わるため
 */
export const FIXTURE_HOLIDAYS: HolidayTable = {
  firstYear: 2026,
  lastYear: 2026,
  sourceSha256: "0".repeat(64),
  contentSha256: "2026".repeat(16),
  dates: new Set(holidaysFor("2026-01-01", "2026-12-31")),
};

/** ログの外の値（価格）と本文（投稿）の置き場。salt は固定シードの擬似乱数から作る */
class FixtureValues implements ValueStore {
  readonly values = new Map<string, Salted<unknown>>();
  /** 投稿の本文と、LLMの出力（文字列） */
  readonly bodies = new Map<string, Salted<string>>();
  constructor(private readonly rand: () => number) {}
  private salt() {
    return Uint8Array.from({ length: 16 }, () => Math.floor(this.rand() * 256));
  }
  async putValue(value: unknown) {
    const salt = this.salt();
    const hash = await bodyHash(salt, { value });
    this.values.set(hash, { salt, value });
    return hash;
  }
  async putBody(text: string) {
    const salt = this.salt();
    const hash = await bodyHash(salt, text);
    this.bodies.set(hash, { salt, value: text });
    return hash;
  }
  get(hash: string) {
    return this.values.get(hash);
  }
}

export interface GoldenLog {
  scenario: Scenario;
  events: readonly LogEvent[];
  /** ログの外の値（prices.* の valuesHash で引く） */
  values: ValueStore;
  /** 投稿の本文（post.published の bodyHash）と、LLMの出力（agent.run の outputHash）で引く */
  bodies: ReadonlyMap<string, Salted<string>>;
  /** 組み立てに使った保管（続けて追記したり、read のページ送りを試したりできる） */
  store: MemoryEventStore;
  /** replay に渡す祝日の一覧（同梱の一覧を採用する） */
  holidayTables: ReadonlyMap<string, HolidayTable>;
  /** 組み立てに使った台帳（replay の結果と比べる） */
  ledger: Ledger;
}

const SOURCE = "fixture:synthetic";
const hashOf = (v: unknown) => sha256Hex(new TextEncoder().encode(canonicalize(v)));

export async function buildGoldenLog(seed: number): Promise<GoldenLog> {
  const scenario = buildScenario(seed);
  const holidayTables = new Map([[FIXTURE_HOLIDAYS.contentSha256, FIXTURE_HOLIDAYS]]);
  const values = new FixtureValues(mulberry32(seed ^ 0x5a17));
  const ledger = new Ledger(values);
  const log = new EventLog({ holidayTables, accountOf: (id) => ledger.account(id) });
  const clock = new FakeClock(0);
  const store = new MemoryEventStore(log, clock, Number.MAX_SAFE_INTEGER);

  const add = async (at: number, d: DraftInput) => {
    clock.set(at);
    const r = await store.append(d);
    if (!r.ok) throw new Error(`${d.type} at ${new Date(at).toISOString()}: ${r.reason}`);
    await ledger.apply(r.event);
    return r.event.seq;
  };
  const sys = (type: DraftInput["type"], payload: Record<string, unknown>, refs: number[] = []): DraftInput => ({ type, actor: "system", refs, payload });

  /** その日の全銘柄の値を1件の prices.* にまとめる。記録時刻は、全銘柄の取得時刻の最大 */
  const closeSeqs = new Map<string, number>();
  const prices = async (date: string, kind: "open" | "close") => {
    const obs = scenario.observations.filter((o) => o.date === date && o.kind === kind);
    const fetchedAt = Math.max(...obs.map((o) => o.fetchedAt));
    const valuesHash = await values.putValue(Object.fromEntries(obs.map((o) => [o.symbol, o.price])));
    const seq = await add(fetchedAt, sys(`prices.${kind}`, { date, source: SOURCE, fetchedAt, valuesHash }));
    if (kind === "close") closeSeqs.set(date, seq);
    return { seq, at: fetchedAt };
  };

  await add(0, { type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 } });
  await add(0, { type: "universe.set", actor: "operator:owner", refs: [], payload: { symbols: [...scenario.symbols] } });
  await prices(PRIOR_DAY, "open");
  const priorClose = await prices(PRIOR_DAY, "close");
  // 前営業日の終値の記録より後に登録する（開始日は最初の取引日）
  for (const [i, a] of scenario.agents.entries()) {
    await add(priorClose.at + 3_600_000 + i * 1000, { type: "agent.registered", actor: "operator:owner", refs: [], payload: { agentId: a.id, displayName: a.name, startDate: scenario.tradingDays[0], initialCash: INITIAL_CASH } });
  }

  const run = async (at: number, agentId: string, purpose: "post" | "order", inputSeqs: number[], output: string) => {
    const prompt = { id: `fixture-${purpose}`, version: "1", hash: await hashOf(`fixture prompt for ${purpose}`) };
    const model = { provider: "fixture", modelId: "scripted", settings: {} };
    const messages = [{ role: "user", content: `${prompt.id}@${prompt.version} inputs=${inputSeqs.join(",")}` }];
    const requestHash = await hashOf({ model, messages });
    // 出力は本文と同じく乱数つきのハッシュにする（候補の文を当てて確かめられないように。§5.2）
    const outputHash = await values.putBody(output);
    return add(at, sys("agent.run", { agentId, purpose, model, prompt, inputSeqs, requestHash, startedAt: at, finishedAt: at, outputHash, ok: true }, inputSeqs));
  };

  for (const tradingDate of scenario.tradingDays) {
    // 判断：前の営業日の終値（だけ）を入力に、投稿と注文票の確定。時刻は decideAt（終値を取り込んだ後、締めより前）から1件ずつ進める
    const sheets = new Map<string, number>();
    const plans = scenario.plans.filter((p) => p.tradingDate === tradingDate);
    let t = plans[0]!.decideAt;
    for (const p of plans) {
      const inputs = [closeSeqs.get(p.decidedOn)!];
      if (p.post) {
        const r = await run((t += 1000), p.agentId, "post", inputs, p.post.text);
        const body = await values.putBody(p.post.text);
        clock.set((t += 1000));
        const post = await store.append({ type: "post.published", actor: `agent:${p.agentId}`, refs: [r, ...inputs], payload: { agentId: p.agentId, board: p.post.symbol, bodyHash: body, citeSeqs: inputs, runSeq: r } });
        if (!post.ok) throw new Error(`post.published: ${post.reason}`);
        await ledger.apply(post.event);
      }
      if (p.orders.length > 0) {
        const r = await run((t += 1000), p.agentId, "order", inputs, canonicalize(p.orders));
        clock.set((t += 1000));
        const c = await store.commitSheet(p.agentId, { tradingDate, orders: p.orders, runSeq: r, inputSeqs: inputs });
        if (!c.ok || c.rejected) throw new Error(`commitSheet ${p.agentId} ${tradingDate}: ${c.ok ? c.rejected : c.reason}`);
        await ledger.apply(c.event);
        sheets.set(p.agentId, c.event.seq);
      }
    }

    // 寄り付き：始値を記録し、確定した注文票を約定させる（中身は Ledger が計算する）
    const open = await prices(tradingDate, "open");
    t = open.at;
    for (const [agentId, sheetSeq] of sheets) {
      const f = await ledger.computeFills(agentId, sheetSeq, open.seq);
      await add((t += 1000), sys("fills.executed", { agentId, tradingDate, sheetSeq, openSeq: open.seq, ...f.payload }, [sheetSeq, open.seq]));
    }

    // 引け後：終値を記録し（遅延日は翌日の未明）、AIごとに評価と引け後処理（分割・配当の公表はない）
    const close = await prices(tradingDate, "close");
    t = close.at;
    const exDate = nextBusinessDay(tradingDate, log.holidays());
    for (const a of scenario.agents) {
      await add((t += 1000), sys("valuation.recorded", { agentId: a.id, date: tradingDate, closeSeq: close.seq, ...ledger.computeValuation(a.id, tradingDate) }, [close.seq]));
      const ca = await ledger.computeCorporate(a.id, tradingDate, exDate, []);
      await add((t += 1000), sys("corporate_actions.applied", { agentId: a.id, asOf: tradingDate, exDate, announcedSeqs: [], ...ca.payload }));
    }
  }

  return { scenario, events: await store.read(), values, bodies: values.bodies, store, holidayTables, ledger };
}
