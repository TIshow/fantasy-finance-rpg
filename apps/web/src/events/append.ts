// 追記の処理（docs/EVENT_LOG.md §3・§4）。メモリ上のログに、検査を通ったイベントだけを足す。
// 時計は持たない。recordedAt はサーバーが1回だけ決めて渡す。一意キーは中身から作り、呼び出し側には任せない。
// 中身の検査は、順序と時点の判定に使う項目だけ。口座の再計算と照合、訂正・調整は別のPR（§8の3）。
import { cutoffOf, isBusinessDay, isValidDate, nextBusinessDay, previousBusinessDay, validateSheet } from "../ledger/ledger";
import { INITIAL_CASH, type Account, type Order, type RejectReason } from "../ledger/types";
import { CanonicalizeError } from "./canonical";
import { sealEvent } from "./chain";
import type { Actor, EventType, LogEvent } from "./types";

type Writer = "agent" | "system" | "operator";

/** §3 の「書ける者」 */
const WRITERS: Record<EventType, Writer> = {
  "source.captured": "system",
  "prices.open": "system",
  "prices.close": "system",
  "corporate_action.announced": "system",
  "market.closed": "operator",
  "agent.registered": "operator",
  "agent.run": "system",
  "post.published": "agent",
  "order_sheet.committed": "agent",
  "order_sheet.rejected": "system",
  "fills.executed": "system",
  "valuation.recorded": "system",
  "corporate_actions.applied": "system",
  "correction.issued": "operator",
  "ledger.adjusted": "operator",
  "content.withdrawn": "operator",
  "agent.suspended": "operator",
  "agent.resumed": "operator",
};

/** 中身で他のイベントを指す項目。すべて refs にも入っていなければならない */
const SEQ_FIELDS = ["runSeq", "sheetSeq", "openSeq", "closeSeq", "targetSeq", "correctionSeq", "replyTo"];
const SEQ_LIST_FIELDS = ["inputSeqs", "announcedSeqs", "citeSeqs"];

/** 登録済みのAIについてのイベント（agent.suspended・agent.resumed は全体の "*" も可） */
const AGENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "agent.run",
  "post.published",
  "order_sheet.committed",
  "order_sheet.rejected",
  "fills.executed",
  "valuation.recorded",
  "corporate_actions.applied",
  "ledger.adjusted",
  "agent.suspended",
  "agent.resumed",
]);

export interface AppendContext {
  universe: ReadonlySet<string>;
  /** holidaysFor() の結果。臨時休場（market.closed）はこのログが足す */
  holidays: ReadonlySet<string>;
  /** 使った祝日の一覧の版（HolidayTable.contentSha256） */
  holidaysSha256: string;
  /** そのAIのいまの口座（再計算で得る） */
  accountOf(agentId: string): Account;
}

export interface Draft {
  type: EventType;
  recordedAt: number;
  actor: Actor;
  refs: number[];
  payload: Record<string, unknown>;
}

interface AgentState {
  /** 最後に済んだ引け後処理の営業日（D-030 の accountAsOf） */
  asOf: string;
  valuedDate: string | null;
  /** 確定して、まだ約定していない注文票 */
  pending: { tradingDate: string; seq: number } | null;
}

/** 臨時休場の日を足した休場日の集合（calendar は has() だけを使う） */
class WithClosures extends Set<string> {
  constructor(
    private readonly base: ReadonlySet<string>,
    private readonly closed: ReadonlyMap<string, number>,
  ) {
    super();
  }
  override has(date: string): boolean {
    return this.closed.has(date) || this.base.has(date);
  }
}

export type AppendResult = { ok: true; event: LogEvent } | { ok: false; reason: string };

export class EventLog {
  readonly events: LogEvent[] = [];
  private readonly keys = new Set<string>();
  private readonly agents = new Map<string, AgentState>();
  private readonly suspended = new Map<string, Set<string>>();
  private readonly opens = new Map<string, number>();
  private readonly closes = new Map<string, number>();
  private readonly closed = new Map<string, number>();
  private readonly commits = new Set<string>();

  constructor(private readonly ctx: AppendContext) {}

  holidays(): ReadonlySet<string> {
    return new WithClosures(this.ctx.holidays, this.closed);
  }

  /** 1件を足す。どれかの検査に通らなければ、何も変えずに理由を返す */
  async append(d: Draft): Promise<AppendResult> {
    const keys = keysOf(d.type, d.payload);
    if (typeof keys === "string") return { ok: false, reason: keys };
    const reason = this.check(d);
    if (reason) return { ok: false, reason };
    let event: LogEvent;
    try {
      event = await sealEvent(this.events.at(-1) ?? null, { ...d, keys }, this.keys);
    } catch (err) {
      if (err instanceof CanonicalizeError || (err instanceof Error && err.message.startsWith("invalid event:"))) return { ok: false, reason: err.message };
      throw err;
    }
    this.events.push(event);
    for (const k of keys) this.keys.add(k);
    this.apply(event);
    return { ok: true, event };
  }

  /**
   * AIの注文票を確定する（§4）。recordedAt を確定時刻として validateSheet を同じ処理の中で実行し、
   * 通らなければ order_sheet.rejected を残す。どちらも書けなければ（AIが未登録など）理由だけを返す
   */
  async commitSheet(
    recordedAt: number,
    agentId: string,
    sheet: { tradingDate: string; orders: Order[]; runSeq: number; inputSeqs: number[] },
  ): Promise<AppendResult & { rejected?: RejectReason }> {
    const committed: Draft = {
      type: "order_sheet.committed",
      recordedAt,
      actor: `agent:${agentId}`,
      refs: [...new Set([sheet.runSeq, ...sheet.inputSeqs])],
      payload: { agentId, tradingDate: sheet.tradingDate, orders: sheet.orders, runSeq: sheet.runSeq, inputSeqs: sheet.inputSeqs, holidaysSha256: this.ctx.holidaysSha256 },
    };
    const reject = this.sheetRejection(committed);
    if (!reject) {
      const r = await this.append(committed);
      if (r.ok || !this.agents.has(agentId)) return r;
    }
    const reason = reject ?? "invalid_sheet";
    const runOk = this.events[sheet.runSeq - 1]?.type === "agent.run";
    const r = await this.append({
      type: "order_sheet.rejected",
      recordedAt,
      actor: "system",
      refs: runOk ? [sheet.runSeq] : [],
      payload: { agentId, tradingDate: String(sheet.tradingDate), reason, ...(runOk ? { runSeq: sheet.runSeq } : {}) },
    });
    return r.ok ? { ...r, rejected: reason } : r;
  }

  private sheetRejection(d: Draft): RejectReason | null {
    const p = d.payload;
    const agentId = String(p.agentId);
    const st = this.agents.get(agentId);
    if (!st) return null; // append が理由を返す
    if (this.isSuspended(agentId, "orders")) return "suspended";
    const tradingDate = p.tradingDate;
    if (!isValidDate(tradingDate) || !Array.isArray(p.orders)) return "invalid_sheet";
    if (this.runProblem(d, agentId, "order") || this.inputProblem(p.inputSeqs, tradingDate)) return "invalid_sheet";
    const v = validateSheet(
      { agentId, tradingDate, committedAt: d.recordedAt, orders: p.orders as Order[] },
      { universe: this.ctx.universe, alreadyCommitted: this.commits.has(`${agentId}:${tradingDate}`), account: this.ctx.accountOf(agentId), holidays: this.holidays(), accountAsOf: st.asOf },
    );
    return v.ok ? null : v.reason;
  }

  private check(d: Draft): string | null {
    const writer = WRITERS[d.type];
    if (!writer) return `unknown type ${d.type}`;
    if (!d.actor.startsWith(writer)) return `${d.type} must be written by ${writer}`;
    const p = d.payload;
    if (typeof p !== "object" || p === null || Array.isArray(p)) return "payload must be an object";
    if (writer === "agent" && d.actor !== `agent:${String(p.agentId)}`) return "agentId does not match the actor";
    const next = this.events.length + 1;
    for (const s of payloadSeqs(p)) if (typeof s !== "number" || !d.refs.includes(s) || !(s >= 1 && s < next)) return `payload refers to ${String(s)} outside refs`;
    const agentId = typeof p.agentId === "string" ? p.agentId : "";
    const st = this.agents.get(agentId);
    const everyone = (d.type === "agent.suspended" || d.type === "agent.resumed") && p.agentId === "*";
    if (AGENT_TYPES.has(d.type) && !st && !everyone) return `unknown agent ${String(p.agentId)}`;
    if (d.type === "agent.registered" && st) return `agent ${agentId} already registered`;
    const H = this.holidays();
    switch (d.type) {
      case "source.captured": {
        const { publishedAt, fetchedAt } = p;
        if (!isTime(publishedAt) || !isTime(fetchedAt) || publishedAt > fetchedAt || fetchedAt > d.recordedAt) return "need publishedAt <= fetchedAt <= recordedAt";
        return null;
      }
      case "prices.open":
        if (this.closed.has(p.date as string)) return "market was closed";
        return d.recordedAt >= cutoffOf(p.date as string) ? null : "open prices recorded before the cutoff";
      case "market.closed":
        return this.opens.has(p.date as string) ? "open prices already recorded" : null;
      case "agent.registered": {
        const start = p.startDate;
        if (!isValidDate(start) || !isBusinessDay(start, H)) return "startDate must be a business day";
        if (p.initialCash !== INITIAL_CASH) return "initialCash must be INITIAL_CASH";
        return d.recordedAt < cutoffOf(start) ? null : "register before the cutoff of startDate";
      }
      case "agent.run":
        return p.purpose === "post" || p.purpose === "order" ? this.inputProblem(p.inputSeqs, null) : "purpose must be post or order";
      case "post.published":
        if (this.isSuspended(agentId, "posts")) return "suspended";
        return this.runProblem(d, agentId, "post");
      case "order_sheet.committed":
        // 直接 append しても、commitSheet と同じ検査を通す
        return this.sheetRejection(d) ? "sheet rejected (use commitSheet to record the reason)" : null;
      case "fills.executed": {
        const pend = st!.pending;
        if (!pend || pend.tradingDate !== p.tradingDate || pend.seq !== p.sheetSeq) return "no committed sheet for this trading date";
        if (this.closed.has(pend.tradingDate)) return p.openSeq === undefined ? null : "market was closed";
        return p.openSeq === this.opens.get(pend.tradingDate) ? null : "openSeq must be prices.open of the trading date";
      }
      case "valuation.recorded": {
        if (st!.pending) return "the committed sheet is not filled yet";
        if (p.date !== nextBusinessDay(st!.asOf, H) || st!.valuedDate === p.date) return "valuation must be for the day after the last post-close";
        return p.closeSeq === this.closes.get(p.date as string) ? null : "closeSeq must be prices.close of the date";
      }
      case "corporate_actions.applied": {
        if (st!.valuedDate !== p.asOf || st!.asOf === p.asOf) return "value the day before applying corporate actions";
        return p.exDate === nextBusinessDay(p.asOf as string, H) ? null : "exDate must be the next business day";
      }
      default:
        return null;
    }
  }

  /** 検査に通ったあとでだけ呼ぶ。check と同じ前提で状態を進める */
  private apply(e: LogEvent): void {
    const p = e.payload as Record<string, unknown>;
    const agentId = p.agentId as string;
    const st = this.agents.get(agentId);
    switch (e.type) {
      case "prices.open":
        this.opens.set(p.date as string, e.seq);
        break;
      case "prices.close":
        this.closes.set(p.date as string, e.seq);
        break;
      case "market.closed":
        this.closed.set(p.date as string, e.seq);
        break;
      case "agent.registered":
        this.agents.set(agentId, { asOf: previousBusinessDay(p.startDate as string, this.holidays()), valuedDate: null, pending: null });
        break;
      case "order_sheet.committed":
        st!.pending = { tradingDate: p.tradingDate as string, seq: e.seq };
        this.commits.add(`${agentId}:${String(p.tradingDate)}`);
        break;
      case "fills.executed":
        st!.pending = null;
        break;
      case "valuation.recorded":
        st!.valuedDate = p.date as string;
        break;
      case "corporate_actions.applied":
        st!.asOf = p.asOf as string;
        break;
      case "agent.suspended":
      case "agent.resumed": {
        const scopes = p.scope === "both" ? ["posts", "orders"] : [String(p.scope)];
        const set = this.suspended.get(agentId) ?? new Set<string>();
        for (const s of scopes) {
          if (e.type === "agent.suspended") set.add(s);
          else set.delete(s);
        }
        this.suspended.set(agentId, set);
        break;
      }
    }
  }

  private isSuspended(agentId: string, scope: "posts" | "orders"): boolean {
    return [agentId, "*"].some((id) => this.suspended.get(id)?.has(scope) ?? false);
  }

  /** 元になった agent.run が、同じAIの、その目的の、成功したものか */
  private runProblem(d: Draft, agentId: string, purpose: "post" | "order"): string | null {
    const run = this.events[(d.payload.runSeq as number) - 1];
    const rp = run?.payload as Record<string, unknown> | undefined;
    if (run?.type !== "agent.run" || rp?.agentId !== agentId || rp.purpose !== purpose || rp.ok !== true) return `runSeq must be a successful ${purpose} run of the same agent`;
    if (Array.isArray(d.payload.inputSeqs) && Array.isArray(rp.inputSeqs)) {
      const runInputs = rp.inputSeqs as unknown[];
      if (!(d.payload.inputSeqs as unknown[]).every((s) => runInputs.includes(s))) return "inputSeqs must be a subset of the run's inputs";
    }
    return null;
  }

  /** 入力の並びが前のイベントを指し、約定日（あれば）の判断に使ってよい情報だけか（§3.2） */
  private inputProblem(inputs: unknown, tradingDate: string | null): string | null {
    if (!Array.isArray(inputs)) return "inputSeqs must be an array";
    for (const s of inputs) {
      const e = typeof s === "number" ? this.events[s - 1] : undefined;
      if (!e) return `unknown input ${String(s)}`;
      if (!tradingDate) continue;
      const ip = e.payload as Record<string, unknown>;
      if (e.type === "source.captured" && !((ip.publishedAt as number) < cutoffOf(tradingDate))) return "input published after the cutoff";
      if ((e.type === "prices.open" || e.type === "prices.close" || e.type === "valuation.recorded") && !((ip.date as string) < tradingDate)) return "price input not before the trading date";
    }
    return null;
  }
}

/** §3 の一意キー。中身から作る。作れなければ理由を返す */
function keysOf(type: EventType, p: Record<string, unknown>): string[] | string {
  const id = p.agentId;
  const need = (...fields: string[]) => fields.find((f) => !(f === "agentId" ? typeof p[f] === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(p[f] as string) : isValidDate(p[f])));
  const k = (fields: string[], make: () => string[]): string[] | string => {
    const bad = need(...fields);
    return bad ? `invalid ${bad}` : make();
  };
  switch (type) {
    case "prices.open":
      return k(["date"], () => [`open:${String(p.date)}`]);
    case "prices.close":
      return k(["date"], () => [`close:${String(p.date)}`]);
    case "market.closed":
      return k(["date"], () => [`closed:${String(p.date)}`]);
    case "agent.registered":
      return k(["agentId"], () => [`agent:${String(id)}`]);
    case "order_sheet.committed":
      return k(["agentId", "tradingDate"], () => [`sheet:${String(id)}:${String(p.tradingDate)}`]);
    case "fills.executed":
      return k(["agentId", "tradingDate"], () => [`fills:${String(id)}:${String(p.tradingDate)}`]);
    case "valuation.recorded":
      return k(["agentId", "date"], () => [`valuation:${String(id)}:${String(p.date)}`]);
    case "corporate_actions.applied": {
      if (!Array.isArray(p.announcedSeqs)) return "invalid announcedSeqs";
      return k(["agentId", "asOf"], () => [`post_close:${String(id)}:${String(p.asOf)}`, ...(p.announcedSeqs as unknown[]).map((s) => `ca:${String(id)}:${String(s)}`)]);
    }
    case "ledger.adjusted":
      return k(["agentId"], () => [`adjust:${String(id)}:${String(p.correctionSeq)}`]);
    default:
      return [];
  }
}

function payloadSeqs(p: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  for (const f of SEQ_FIELDS) if (p[f] !== undefined) out.push(p[f]);
  for (const f of SEQ_LIST_FIELDS) if (Array.isArray(p[f])) out.push(...(p[f] as unknown[]));
  return out;
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
