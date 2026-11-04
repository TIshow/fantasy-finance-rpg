// 1日の流れ（#27 PR-1）。取引日 T について、前の日の引け後の残り → 判断（締めより前）→ 寄り付きの約定 → 引け後の処理と評価、の順に行う。
// 書くのは保管（EventStore）だけ。約定・評価・引け後の中身は、runner が持つ台帳（Ledger.compute*）で作る。
// どの段も、ログを見て済んでいれば飛ばすので、同じ日をもう一度回しても二重にならない。外部通信・DB・LLM なし。
import type { Clock, EventStore, MarketDataPort, PriceObservation } from "../contracts";
import { EventLog } from "../events/append";
import { canonicalize } from "../events/canonical";
import { sha256Hex } from "../events/hash";
import { Ledger } from "../events/replay";
import type { LogEvent } from "../events/types";
import type { HolidayTable } from "../holidays/table";
import { cutoffOf, isBusinessDay, nextBusinessDay, previousBusinessDay } from "../ledger/ledger";
import type { Account, Deciyen, Order } from "../ledger/types";
import type { RunnerValues } from "./values";

/** 判断の入力：その時点までに記録した終値（seq つき）。値はログの外から引いて渡す */
export interface CloseInput {
  seq: number;
  date: string;
  prices: Readonly<Record<string, Deciyen | null>>;
}

export interface DecisionInput {
  agentId: string;
  tradingDate: string;
  at: number;
  closes: readonly CloseInput[];
  account: Account;
}

export interface Decision {
  orders: Order[];
  post: { board: string; text: string } | null;
  /** agent.run の出力（ハッシュだけをログに残す） */
  output: string;
}

/** runner が動かすAI。LLM を使うものも使わないものも、この形で判断を返す */
export interface RunnerAgent {
  id: string;
  model: { provider: string; modelId: string; settings: Readonly<Record<string, string>> };
  prompt: { id: string; version: string; hash: string };
  decide(input: DecisionInput): Decision | Promise<Decision>;
}

export interface RunnerDeps {
  store: EventStore;
  market: MarketDataPort;
  values: RunnerValues;
  holidayTables: ReadonlyMap<string, HolidayTable>;
  agents: readonly RunnerAgent[];
  /** 時計の権威（保管と同じもの） */
  clock: Clock;
  /** at まで待つ（本番は実際に待つ。試験は時計を進める）。at が過去ならすぐ戻る */
  waitUntil(at: number): Promise<void>;
  /** 判断の入力に渡す終値の日数（新しい方から） */
  inputDays?: number;
}

const HOUR = 3_600_000;
/** 判断（締め 8:30 の 1時間半前）・寄り付きの取り込み（9:30）・引けの取り込み（16:30）。日本時間 */
export const scheduleOf = (date: string) => ({ decideAt: cutoffOf(date) - 1.5 * HOUR, openAt: cutoffOf(date) + HOUR, closeAt: cutoffOf(date) + 8 * HOUR });

/** 段ごとの結果：書いた・済んでいた・待つ（データがまだない、時刻を過ぎたなど）。待った段は、あとで同じ日を回し直せば進む */
export type StageResult = { stage: string; status: "written" | "done" | "waiting" | "skipped"; detail?: string };

const SOURCE = "market";

export async function runDay(date: string, deps: RunnerDeps): Promise<StageResult[]> {
  const day = await Day.load(deps);
  if (!isBusinessDay(date, day.log.holidays())) return [{ stage: "day", status: "skipped", detail: "not a business day" }];
  const prev = previousBusinessDay(date, day.log.holidays());
  const s = scheduleOf(date);
  const out: StageResult[] = [];
  await deps.waitUntil(s.decideAt);
  out.push(await day.afterClose(prev));
  out.push(await day.decide(date, prev));
  await deps.waitUntil(s.openAt);
  out.push(await day.open(date));
  await deps.waitUntil(s.closeAt);
  out.push(await day.afterClose(date));
  return out;
}

/** 保管のログを読み直して作った、検査（EventLog）と台帳（Ledger）の写し。書いたイベントは写しにも当てる */
class Day {
  private constructor(
    private readonly deps: RunnerDeps,
    readonly log: EventLog,
    private readonly ledger: Ledger,
  ) {}

  static async load(deps: RunnerDeps): Promise<Day> {
    const ledger = new Ledger(deps.values);
    const log = new EventLog({ holidayTables: deps.holidayTables, accountOf: (id) => ledger.account(id) });
    for (let after = 0; ; ) {
      const page = await deps.store.read(after);
      if (page.length === 0) break;
      for (const e of page) {
        const problem = await log.admit(e);
        if (problem) throw new Error(problem);
        await ledger.apply(e);
      }
      after = page.at(-1)!.seq;
    }
    return new Day(deps, log, ledger);
  }

  private find(type: LogEvent["type"], match: (p: Record<string, unknown>) => boolean = () => true): LogEvent | undefined {
    return this.log.events.find((e) => e.type === type && match(e.payload as Record<string, unknown>));
  }

  private async sync(r: { ok: true; event: LogEvent } | { ok: false; reason: string }, what: string): Promise<LogEvent> {
    if (!r.ok) throw new Error(`${what}: ${r.reason}`);
    const problem = await this.log.admit(r.event);
    if (problem) throw new Error(`${what}: ${problem}`);
    await this.ledger.apply(r.event);
    return r.event;
  }

  private append(type: Parameters<EventStore["append"]>[0]["type"], actor: Parameters<EventStore["append"]>[0]["actor"], payload: Record<string, unknown>, refs: number[] = []) {
    return this.deps.store.append({ type, actor, refs, payload }).then((r) => this.sync(r, type));
  }

  /** その日に動くAI（登録済みで、開始日が date 以前） */
  private agentsOn(date: string): string[] {
    return this.log.events.filter((e) => e.type === "agent.registered" && ((e.payload as Record<string, unknown>).startDate as string) <= date).map((e) => (e.payload as Record<string, unknown>).agentId as string);
  }

  private universe(): string[] {
    const u = this.log.events.filter((e) => e.type === "universe.set").at(-1);
    return u ? ((u.payload as Record<string, unknown>).symbols as string[]) : [];
  }

  /** 窓から全銘柄の date の観測を引いて prices.* と source.captured を書く。1銘柄でもなければ待つ */
  private async ingest(date: string, kind: "open" | "close"): Promise<LogEvent | StageResult> {
    const stage = kind === "open" ? "prices.open" : "prices.close";
    const done = this.find(stage, (p) => p.date === date);
    if (done) return done;
    const view = this.deps.market.asOf(this.deps.clock.now());
    const obs: PriceObservation[] = [];
    for (const symbol of this.universe()) {
      const o = await view.latest(symbol, kind);
      if (o?.date !== date) return { stage, status: "waiting", detail: `no ${kind} of ${symbol} for ${date}` };
      obs.push(o);
    }
    if (obs.length === 0) return { stage, status: "waiting", detail: "no universe" };
    const fetchedAt = Math.max(...obs.map((o) => o.fetchedAt));
    const valuesHash = await this.deps.values.putValue(Object.fromEntries(obs.map((o) => [o.symbol, o.price])));
    const event = await this.append(stage, "system", { date, source: SOURCE, fetchedAt, valuesHash });
    await this.append("source.captured", "system", { source: SOURCE, publishedAt: Math.max(...obs.map((o) => o.publishedAt)), fetchedAt, contentHash: valuesHash });
    return event;
  }

  /** 締めより前に、AIごとに入力を固定して agent.run を書き、投稿と注文票の確定を行う */
  async decide(date: string, prev: string): Promise<StageResult> {
    const stage = "decide";
    if (this.find("prices.open", (p) => p.date === date) || this.deps.clock.now() >= cutoffOf(date)) return { stage, status: "skipped", detail: "after the cutoff" };
    const prevClose = this.find("prices.close", (p) => p.date === prev);
    if (!prevClose) return { stage, status: "waiting", detail: `no close of ${prev}` };
    const closes = this.log.events.filter((e) => e.type === "prices.close").slice(-(this.deps.inputDays ?? 20));
    const inputs: CloseInput[] = closes.map((e) => {
      const p = e.payload as Record<string, unknown>;
      return { seq: e.seq, date: p.date as string, prices: this.deps.values.get(p.valuesHash as string)!.value as CloseInput["prices"] };
    });
    const inputSeqs = inputs.map((i) => i.seq);
    let wrote = false;
    for (const agent of this.deps.agents.filter((a) => this.agentsOn(date).includes(a.id))) {
      if (this.log.events.some((e) => e.seq > prevClose.seq && e.type === "agent.run" && (e.payload as Record<string, unknown>).agentId === agent.id)) continue;
      const startedAt = this.deps.clock.now();
      const d = await agent.decide({ agentId: agent.id, tradingDate: date, at: startedAt, closes: inputs, account: this.ledger.account(agent.id) });
      const run = async (purpose: "post" | "order", output: string) => {
        const requestHash = await sha256Hex(new TextEncoder().encode(canonicalize({ model: agent.model, prompt: agent.prompt, purpose, inputSeqs })));
        const outputHash = await this.deps.values.putBody(output);
        const payload = { agentId: agent.id, purpose, model: agent.model, prompt: agent.prompt, inputSeqs, requestHash, startedAt, finishedAt: this.deps.clock.now(), outputHash, ok: true };
        return (await this.append("agent.run", "system", payload, inputSeqs)).seq;
      };
      if (d.post) {
        const runSeq = await run("post", d.output);
        const bodyHash = await this.deps.values.putBody(d.post.text);
        await this.append("post.published", `agent:${agent.id}`, { agentId: agent.id, board: d.post.board, bodyHash, citeSeqs: inputSeqs, runSeq }, [runSeq, ...inputSeqs]);
      }
      const runSeq = await run("order", d.output);
      if (d.orders.length > 0) {
        const r = await this.deps.store.commitSheet(agent.id, { tradingDate: date, orders: d.orders, runSeq, inputSeqs });
        await this.sync(r, `commitSheet ${agent.id}`);
      }
      wrote = true;
    }
    return { stage, status: wrote ? "written" : "done" };
  }

  /** 始値を取り込み、確定した注文票を約定させる */
  async open(date: string): Promise<StageResult> {
    const open = await this.ingest(date, "open");
    if (!("seq" in open)) return open;
    let wrote = false;
    for (const sheet of this.log.events.filter((e) => e.type === "order_sheet.committed" && (e.payload as Record<string, unknown>).tradingDate === date)) {
      const agentId = (sheet.payload as Record<string, unknown>).agentId as string;
      if (this.find("fills.executed", (p) => p.agentId === agentId && p.tradingDate === date)) continue;
      const f = await this.ledger.computeFills(agentId, sheet.seq, open.seq);
      await this.append("fills.executed", "system", { agentId, tradingDate: date, sheetSeq: sheet.seq, openSeq: open.seq, ...f.payload }, [sheet.seq, open.seq]);
      wrote = true;
    }
    return { stage: "open", status: wrote ? "written" : "done" };
  }

  /** 終値を取り込み、AIごとに評価と引け後の処理（分割・配当の公表は #67 の後） */
  async afterClose(date: string): Promise<StageResult> {
    const close = await this.ingest(date, "close");
    if (!("seq" in close)) return close;
    const exDate = nextBusinessDay(date, this.log.holidays());
    let wrote = false;
    for (const agentId of this.agentsOn(date)) {
      if (!this.find("valuation.recorded", (p) => p.agentId === agentId && p.date === date)) {
        await this.append("valuation.recorded", "system", { agentId, date, closeSeq: close.seq, ...this.ledger.computeValuation(agentId, date) }, [close.seq]);
        wrote = true;
      }
      if (!this.find("corporate_actions.applied", (p) => p.agentId === agentId && p.asOf === date && p.closedSeq === undefined)) {
        const ca = await this.ledger.computeCorporate(agentId, date, exDate, []);
        await this.append("corporate_actions.applied", "system", { agentId, asOf: date, exDate, announcedSeqs: [], ...ca.payload });
        wrote = true;
      }
    }
    return { stage: "after_close", status: wrote ? "written" : "done" };
  }
}
