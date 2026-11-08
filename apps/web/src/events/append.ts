// 追記の処理（docs/EVENT_LOG.md §3・§4）。メモリ上のログに、検査を通ったイベントだけを足す。
// 時計は持たない。recordedAt はサーバーが1回だけ決めて渡す。一意キーは中身から作り、呼び出し側には任せない。
// 中身の検査は、順序と時点の判定に使う項目だけ。口座の再計算と照合、訂正・調整は別のPR（§8の3）。
// 祝日の一覧の版と取引対象は、ログの holidays.adopted・universe.set が決める（§3.5）。照合でも、記録したときの版を使う。
import { coveredHolidays, type HolidayTable } from "../holidays/table";
import { MAX_PRICE, TICK } from "../ledger/auction";
import { cutoffOf, isBusinessDay, isValidDate, nextBusinessDay, previousBusinessDay, tradingDateFor, validateSheet } from "../ledger/ledger";
import type { Listing } from "../ledger/ledger";
import { registrationProblem, type Account, type Order, type ParticipantKind, type RejectReason } from "../ledger/types";
import { CanonicalizeError } from "./canonical";
import { sealEvent } from "./chain";
import { jstDayOf, LLM_DAILY_COST_LIMIT, llmCostUsed, llmTokenCost, type LlmPrice, type LlmTokens } from "./llm-cost";
import { POST_INTENTS, POST_STANCES, type Actor, type EventType, type LogEvent } from "./types";

type Writer = "agent" | "system" | "operator";

/** §3 の「書ける者」 */
const WRITERS: Record<EventType, Writer> = {
  "source.captured": "system",
  "prices.open": "system",
  "prices.close": "system",
  "corporate_action.announced": "system",
  "company.listed": "system",
  "auction.cleared": "system",
  "shares.allotted": "system",
  "company.disclosed": "system",
  "market.closed": "operator",
  "holidays.adopted": "operator",
  "universe.set": "operator",
  "agent.registered": "operator",
  "agent.run": "system",
  "llm.batch.submitted": "system",
  "llm.batch.sent": "system",
  "llm.batch.closed": "system",
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
const SEQ_FIELDS = ["runSeq", "sheetSeq", "openSeq", "closeSeq", "closedSeq", "refSeq", "targetSeq", "correctionSeq", "replyTo", "batchSeq"];
const SEQ_LIST_FIELDS = ["inputSeqs", "announcedSeqs", "citeSeqs", "sheetSeqs", "auctionSeqs"];

/** 登録済みのAIについてのイベント（agent.suspended・agent.resumed は全体の "*" も可） */
const AGENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "agent.run",
  "llm.batch.submitted",
  "llm.batch.sent",
  "llm.batch.closed",
  "post.published",
  "order_sheet.committed",
  "order_sheet.rejected",
  "fills.executed",
  "valuation.recorded",
  "corporate_actions.applied",
  "ledger.adjusted",
  "shares.allotted",
  "agent.suspended",
  "agent.resumed",
]);

/** 営業日を判定するイベント。ほかに営業日を使うのは登録済みのAIのイベントで、登録には一覧が要るので、ここに入れなくてよい */
const NEEDS_CALENDAR: ReadonlySet<EventType> = new Set<EventType>(["prices.open", "prices.close", "market.closed", "agent.registered", "corporate_action.announced", "auction.cleared", "llm.batch.submitted"]);

/**
 * 営業日の判定を通した日付の項目（§3.5）。ログが使った一番遅い日付を覚えるのに使う。臨時休場の日は判定を通さないので入れない。
 * 公表の権利落ち日は、記録の時点では営業日かを確かめるが、外部の値1つで一覧を替えられなくならないよう入れない
 * （あとの一覧で休場日になった公表は、§3.5 のとおり運営者が §6.2 の訂正で扱う）
 */
const JUDGED_DATES: Partial<Record<EventType, string[]>> = {
  "prices.open": ["date"],
  "prices.close": ["date"],
  "auction.cleared": ["date"],
  "agent.registered": ["startDate"],
  "order_sheet.committed": ["tradingDate"],
  "llm.batch.submitted": ["tradingDate"],
  "valuation.recorded": ["date"],
  "corporate_actions.applied": ["asOf", "exDate"],
};

/** 注文の中身で決まる拒否の理由（validateSheet の注文ごとの検査） */
const ORDER_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>(["invalid_order", "unknown_symbol", "invalid_qty", "insufficient_holdings", "invalid_price"]);

/** company.disclosed の項目と、四半期の書き方（例：2026-Q4） */
const DISCLOSED_FIELDS = ["symbol", "period", "revenue", "netIncome", "eps", "dividendPerShare"];
const ALLOTTED_FIELDS = ["agentId", "symbol", "qty"];
const PERIOD = /^\d{4}-Q[1-4]$/;

/** company.listed の項目 */
const LISTING_FIELDS = ["symbol", "name", "sector", "sharesOutstanding", "price"];
/**
 * 発行済株式数の上限（100億株）。1件の注文の株数は発行済株式数までなので、注文が数十万件あっても、
 * 板寄せの株数の合計は正確に扱える整数の範囲（約900京）に収まる
 */
const MAX_SHARES = 10_000_000_000;
const isShortText = (v: unknown) => typeof v === "string" && v !== "" && v.length <= 100;

/** 銘柄コード（例：7203、130A。テストでは架空の英字） */
const SYMBOL = /^[0-9A-Z]{3,8}$/;

/**
 * LLM のバッチの記録（#179）。順は ① llm.batch.submitted（送る前の予約）→ ② 提供元に送る → ③ llm.batch.sent（①を指し、
 * 提供元のバッチのIDを足す）→ llm.batch.closed（①を指す）。①は提供元のバッチのIDを持たない
 */
const LLM_PRICE_FIELDS = ["inputCentsPer10MTok", "outputCentsPer10MTok"];
const LLM_SUBMITTED_FIELDS = ["agentId", "provider", "modelId", "promptVersion", "sentBodyHash", "customId", "maxCost", "tradingDate", "submittedAt", "yenPerUsd", ...LLM_PRICE_FIELDS, "maxInputTokens", "maxOutputTokens", "bodyMaxOutputTokens"];
const LLM_TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"];
const LLM_SENT_FIELDS = ["batchSeq", "agentId", "provider", "batchId"];
const LLM_CLOSED_FIELDS = ["batchSeq", "agentId", "result", "cost", "costUnknown", "notCreatedError", ...LLM_TOKEN_FIELDS, ...LLM_PRICE_FIELDS];
/** 送れなかったと確かなときの、送る処理の失敗の種類（LlmSendResult の notCreated の errorCode） */
const LLM_SEND_ERRORS: readonly unknown[] = ["timeout", "rate_limited", "provider_error"];
/** customId の末尾に付ける、送る本文のハッシュの先頭の文字数（同じAI・同じ取引日でも、本文が違えば名前が変わる） */
const LLM_CUSTOM_ID_HASH_CHARS = 16;
const LLM_RESULTS: readonly unknown[] = ["collected", "expired", "failed"];
/** SHA-256 の16進（小文字） */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** 提供元のバッチのID（表示できる ASCII。Gemini は "batches/..." の形） */
const BATCH_ID = /^[\x21-\x7e]{1,256}$/;
/** バッチの中の1件のID（各社の決まりに共通する形） */
const CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isCount = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
/** 依頼を決めた時刻（submittedAt）から記録するまでに許す遅れ（1時間） */
export const LLM_RECORD_WINDOW_MS = 3_600_000;

export interface AppendContext {
  /** これまでに採用した祝日の一覧を、版（contentSha256）で引けるように渡す。どの版を使うかはログの holidays.adopted が決める */
  holidayTables: ReadonlyMap<string, HolidayTable>;
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
  /** 開始日（agent.registered の startDate） */
  startDate: string;
  /** 最後に済んだ引け後処理の営業日（D-030 の accountAsOf） */
  asOf: string;
  valuedDate: string | null;
  /** 確定して、まだ約定していない注文票 */
  pending: { tradingDate: string; seq: number } | null;
  /**
   * 臨時休場の追加の引け後処理（§3.3）を書ける状態。D（asOf）の引け後処理のあとで、D の翌営業日を臨時休場にしたとき。
   * 追加の処理、評価、次の注文票の確定のどれかで消える
   */
  catchUp: { date: string; closedSeq: number } | null;
  /** 参加者の種類（agent.registered の kind。書いていなければ AI投資家） */
  kind: ParticipantKind;
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
  /** 権利落ち日ごとの公表の seq（記録の順） */
  private readonly announced = new Map<string, number[]>();
  /** いま採用している祝日の一覧と、範囲の外を例外にする集合 */
  private calendar: { table: HolidayTable; covered: ReadonlySet<string> } | null = null;
  private universe: ReadonlySet<string> = new Set();
  /** 上場した銘柄（company.listed）。指値の値幅の基準の価格と、1件の株数の上限 */
  private readonly listings = new Map<string, ListingState>();
  /** 板寄せの結果（キーは「銘柄:日付」） */
  private readonly auctions = new Map<string, number>();
  /** 最後に板寄せをした日（全銘柄で）。板寄せの日付は、銘柄を問わず戻らない */
  private lastAuctionDate = "";
  /** 約定日ごとの、確定した注文票の seq（板寄せに渡す全員の注文票） */
  private readonly sheetsByDate = new Map<string, number[]>();
  /** 記録に出た一番遅い日付。一覧を替えても、ここまでの休場日は変えさせない */
  private latest = "";

  constructor(private readonly ctx: AppendContext) {}

  holidays(): ReadonlySet<string> {
    if (!this.calendar) throw new Error("no holiday table adopted");
    return new WithClosures(this.calendar.covered, this.closed);
  }

  /** 1件を足す。どれかの検査に通らなければ、何も変えずに理由を返す。注文票の確定と拒否は commitSheet からだけ書ける */
  async append(d: Draft): Promise<AppendResult> {
    if (d.type === "order_sheet.committed" || d.type === "order_sheet.rejected") return { ok: false, reason: "use commitSheet" };
    return this.write(d);
  }

  /**
   * 保存済みのログを1件ずつ読み直すときに使う（replay.ts）。追記のときと同じ検査をし、作り直したイベントが
   * 記録と同じハッシュになるときだけ受け入れる（一意キー・連鎖・中身のどれかが違えばハッシュが変わる）
   */
  async admit(e: LogEvent): Promise<string | null> {
    const r = await this.write({ type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: e.refs, payload: e.payload as Record<string, unknown> }, e.hash);
    return r.ok ? null : `seq ${e.seq} (${e.type}): ${r.reason}`;
  }

  /** 書かずに、append と同じ検査だけをする。通るなら null、通らなければ理由 */
  async canAppend(d: Draft): Promise<string | null> {
    if (d.type === "order_sheet.committed" || d.type === "order_sheet.rejected") return "use commitSheet";
    const r = await this.seal(d);
    return r.ok ? null : r.reason;
  }

  private async seal(d: Draft): Promise<AppendResult & { keys?: string[] }> {
    const p: unknown = d.payload;
    if (typeof p !== "object" || p === null || Array.isArray(p)) return { ok: false, reason: "payload must be an object" };
    const keys = keysOf(d.type, d.payload);
    if (typeof keys === "string") return { ok: false, reason: keys };
    const reason = this.check(d);
    if (reason) return { ok: false, reason };
    try {
      return { ok: true, event: await sealEvent(this.events.at(-1) ?? null, { ...d, keys }, this.keys), keys };
    } catch (err) {
      if (err instanceof CanonicalizeError || (err instanceof Error && err.message.startsWith("invalid event:"))) return { ok: false, reason: err.message };
      throw err;
    }
  }

  private async write(d: Draft, expectedHash?: string): Promise<AppendResult> {
    const r = await this.seal(d);
    if (!r.ok) return r;
    const { event } = r;
    if (expectedHash !== undefined && event.hash !== expectedHash) return { ok: false, reason: "does not match the recorded event" };
    this.events.push(event);
    for (const k of r.keys!) this.keys.add(k);
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
    const seqsOk = seqsShapeOk(sheet.runSeq, sheet.inputSeqs);
    const committed: Draft = {
      type: "order_sheet.committed",
      recordedAt,
      actor: `agent:${agentId}`,
      refs: seqsOk ? [...new Set([sheet.runSeq, ...sheet.inputSeqs])] : [],
      payload: { agentId, tradingDate: sheet.tradingDate, orders: sheet.orders, runSeq: sheet.runSeq, inputSeqs: sheet.inputSeqs, holidaysSha256: this.calendar?.table.contentSha256 ?? null },
    };
    if (!this.agents.has(agentId)) return { ok: false, reason: `unknown agent ${agentId}` };
    const reject = this.rejectionOf(committed);
    if (!reject) {
      const r = await this.write(committed);
      if (r.ok) return r;
    }
    // 検査を通っても書けないのは、注文が正規化できないとき（余分な項目に小数など）。注文の中身の問題として拒む
    const reason = reject ?? "invalid_order";
    // 元の run と入力は、すべて前のイベントを指すときだけ残す（照合のとき、同じ拒否の理由を出し直せるように）
    const next = this.events.length + 1;
    const seqsKept = seqsOk && [sheet.runSeq, ...sheet.inputSeqs].every((s) => s >= 1 && s < next);
    const base: Draft = {
      type: "order_sheet.rejected",
      recordedAt,
      actor: "system",
      refs: seqsKept ? committed.refs : [],
      payload: { agentId, tradingDate: isValidDate(sheet.tradingDate) ? sheet.tradingDate : "invalid", reason, ...(seqsKept ? { runSeq: sheet.runSeq, inputSeqs: sheet.inputSeqs } : {}) },
    };
    // 受け取った注文票を残す（§3.2）。正規化できない中身なら、その旨だけを残す
    let r = await this.write({ ...base, payload: { ...base.payload, orders: sheet.orders } });
    if (!r.ok) r = await this.write({ ...base, payload: { ...base.payload, ordersUnreadable: true } });
    return r.ok ? { ...r, rejected: reason } : r;
  }

  /**
   * 注文票を拒む理由（形の検査、停止、validateSheet など）。AIの出力から来る値なので、形が違っても例外にしない。
   * 優先順は 停止 → 注文の形 → run と入力の形 → ほか（EVENT_LOG §4）。停止と注文の形は注文の中身や run・入力を使わないので、
   * 拒否の記録が run と入力を外して残しても（commitSheet）、照合で同じ理由を出し直せる。
   * final を false にすると、約定待ち・評価済みの検査（validateSheet の後）を飛ばす（読めない注文の拒否の照合で使う）
   */
  private rejectionOf(d: Draft, final = true): RejectReason | null {
    const p = d.payload;
    const agentId = String(p.agentId);
    const st = this.agents.get(agentId);
    if (!st) return null; // append が理由を返す
    if (this.isSuspended(agentId, "orders")) return "suspended";
    if (!Array.isArray(p.orders) || !p.orders.every((o) => typeof o === "object" && o !== null && !Array.isArray(o))) return "invalid_order";
    return this.sheetRejection(d, agentId, st, final);
  }

  private sheetRejection(d: Draft, agentId: string, st: AgentState, final: boolean): RejectReason | null {
    const p = d.payload;
    if (!seqsShapeOk(p.runSeq, p.inputSeqs)) return "invalid_sheet";
    const tradingDate = p.tradingDate;
    if (!isValidDate(tradingDate) || !Array.isArray(p.orders)) return "invalid_sheet";
    if (p.holidaysSha256 !== this.calendar?.table.contentSha256) return "invalid_sheet";
    // LLMが見た入力全体（元の run の入力）を、約定日の判断に使ってよい情報かで確かめる
    const run = this.events[(p.runSeq as number) - 1];
    if (this.runProblem(d, agentId, "order") || this.inputProblem(p.inputSeqs, tradingDate) || this.inputProblem((run?.payload as Record<string, unknown> | undefined)?.inputSeqs, tradingDate)) return "invalid_sheet";
    const v = validateSheet(
      { agentId, tradingDate, committedAt: d.recordedAt, orders: p.orders as Order[] },
      { universe: this.universe, alreadyCommitted: this.commits.has(`${agentId}:${tradingDate}`), account: this.ctx.accountOf(agentId), holidays: this.holidays(), accountAsOf: st.asOf, listings: this.listingsFor(tradingDate) },
    );
    if (!v.ok) return v.reason;
    // 前の注文票が約定していない、またはその日以後をもう評価した口座では確定できない（§3.3 の順序）
    if (final && this.notReady(st, tradingDate)) return "account_not_ready";
    return null;
  }

  /** 確定の検査に渡す上場した銘柄。値幅の基準の価格は、約定日より前の直近の価格 */
  private listingsFor(tradingDate: unknown): Map<string, Listing> {
    const date = isValidDate(tradingDate) ? tradingDate : "";
    return new Map([...this.listings].map(([s, l]) => [s, { sharesOutstanding: l.sharesOutstanding, refPrice: (priceBefore(l, date) ?? l.prices[0]!).price }]));
  }

  private notReady(st: AgentState, tradingDate: string): boolean {
    return st.pending !== null || (st.valuedDate !== null && st.valuedDate >= tradingDate) || this.catchUpDue(st);
  }

  /** 臨時休場の追加の引け後処理が、まだ反映していない公表のために要るか（§3.3。翌営業日の注文票と評価より前に書く） */
  private catchUpDue(st: AgentState): boolean {
    if (!st.catchUp) return false;
    return (this.announced.get(nextBusinessDay(st.catchUp.date, this.holidays())) ?? []).length > 0;
  }

  /**
   * 読めない注文の拒否（ordersUnreadable）の理由が、その時点の状態と矛盾しないか。注文の中身は分からないので、
   * 注文を空にして、注文によらない検査を出し直す。停止中なら理由は suspended だけ。ほかで拒むなら、理由はそれか
   * invalid_order（注文の形の検査が先）。拒まないなら、理由は注文の中身で決まるもの（約定待ち・評価済みなら account_not_ready も）
   */
  private unreadableRejectionProblem(d: Draft): string | null {
    const p = d.payload;
    const reason = p.reason;
    const pre = this.rejectionOf({ ...d, type: "order_sheet.committed", payload: { agentId: p.agentId, tradingDate: p.tradingDate, orders: [], runSeq: p.runSeq, inputSeqs: p.inputSeqs, holidaysSha256: this.calendar?.table.contentSha256 } }, false);
    if ((pre !== null && reason === pre) || (pre !== "suspended" && reason === "invalid_order")) return null;
    const notReady = isValidDate(p.tradingDate) && this.notReady(this.agents.get(String(p.agentId))!, p.tradingDate);
    if (pre === null && (ORDER_REASONS.has(reason as RejectReason) || (reason === "account_not_ready" && notReady))) return null;
    return `rejection reason ${String(reason)} does not fit unreadable orders (${String(pre)} without orders)`;
  }

  private check(d: Draft): string | null {
    const writer = WRITERS[d.type];
    if (!writer) return `unknown type ${d.type}`;
    if (!(writer === "system" ? d.actor === "system" : d.actor.startsWith(`${writer}:`))) return `${d.type} must be written by ${writer}`;
    const p = d.payload;
    if (writer === "agent" && d.actor !== `agent:${String(p.agentId)}`) return "agentId does not match the actor";
    const next = this.events.length + 1;
    for (const s of payloadSeqs(p)) if (typeof s !== "number" || !d.refs.includes(s) || !(s >= 1 && s < next)) return `payload refers to ${String(s)} outside refs`;
    const agentId = typeof p.agentId === "string" ? p.agentId : "";
    const st = this.agents.get(agentId);
    const everyone = (d.type === "agent.suspended" || d.type === "agent.resumed") && p.agentId === "*";
    if (AGENT_TYPES.has(d.type) && !st && !everyone) return `unknown agent ${String(p.agentId)}`;
    if (d.type === "agent.registered" && st) return `agent ${agentId} already registered`;
    if (!this.calendar && NEEDS_CALENDAR.has(d.type)) return "no holiday table adopted";
    const H = this.calendar ? this.holidays() : new Set<string>();
    switch (d.type) {
      case "source.captured": {
        const { publishedAt, fetchedAt } = p;
        if (!isTime(publishedAt) || !isTime(fetchedAt) || publishedAt > fetchedAt || fetchedAt > d.recordedAt) return "need publishedAt <= fetchedAt <= recordedAt";
        return null;
      }
      case "corporate_action.announced": {
        // 権利落ち日 X の公表は、どのAIも X の前営業日の引け後処理をまだ済ませていない（または臨時休場の追加の処理をまだ書ける）ときだけ。
        // 遅れた公表は、どの引け後処理でも反映されないので、黙って残さず拒む（運営者が §6.2 で扱う）
        // 権利落ち日は、その時点の休場日（臨時休場を含む）で営業日であること。休場日の公表は、どの引け後処理にも渡らない
        const exDate = p.exDate as string;
        // 上場した銘柄の分割は、株数の上限と値幅の基準の価格を合わせる規則を決めるまで受け付けない（#110）
        if (p.kind === "split" && this.listings.has(p.symbol as string)) return "splits of listed companies are not supported yet";
        let before: string;
        try {
          if (!isBusinessDay(exDate, H)) return "exDate must be a business day";
          before = previousBusinessDay(exDate, H);
        } catch {
          return "exDate is outside the adopted holiday table";
        }
        for (const [id, a] of this.agents) {
          // 権利落ち日以後に始めたAIは、権利落ち日より前に株を持たないので、この公表を受け取らない
          if (a.startDate >= exDate || a.asOf < before || (a.asOf === before && a.catchUp?.date === before)) continue;
          return `agent ${id} already finished the post-close of ${before}`;
        }
        return null;
      }
      case "company.listed": {
        // 架空の企業の上場（MARKET_DESIGN §1・§2）。社名・業種は空でない短い文字列、発行済株式数は上限までの正の整数、最初の価格は呼値に合う値
        if (Object.keys(p).some((k) => !LISTING_FIELDS.includes(k))) return "unknown field in a listing";
        if ((p.symbol as string).startsWith("TST")) return "symbols starting with TST are for tests";
        // 取引対象に入れる前に上場させる（入れたあとに上場すると、確定済みの注文票と約定の仕方が食い違う）
        if (this.universe.has(p.symbol as string)) return "list the company before adding it to the universe";
        if (!isShortText(p.name) || !isShortText(p.sector)) return "name and sector are required (up to 100 characters)";
        if (!Number.isSafeInteger(p.sharesOutstanding) || (p.sharesOutstanding as number) <= 0 || (p.sharesOutstanding as number) > MAX_SHARES) return `sharesOutstanding must be a positive integer up to ${MAX_SHARES}`;
        const price = p.price;
        if (!Number.isSafeInteger(price) || (price as number) < TICK || (price as number) > MAX_PRICE || (price as number) % TICK !== 0) return "price must be a positive multiple of the tick";
        return null;
      }
      case "auction.cleared": {
        // 板寄せの結果（MARKET_DESIGN §3）。価格と約定量の中身は台帳が作り直して確かめる（Ledger.computeAuction）
        const symbol = p.symbol as string;
        const date = p.date as string;
        const l = this.listings.get(symbol);
        if (!l) return "symbol is not listed";
        if (!this.universe.has(symbol)) return "symbol is not in the universe";
        if (this.closed.has(date) || !isBusinessDay(date, H)) return "market was closed";
        if (d.recordedAt < cutoffOf(date)) return "auction recorded before the cutoff";
        if (l.lastAuction !== null && l.lastAuction >= date) return "a later auction of the symbol is already recorded";
        // 現金の確かめは、注文票のほかの銘柄の値幅も使うので、ほかの銘柄の前の日の板寄せを後から書くと結果が変わる
        if (date < this.lastAuctionDate) return "a later auction is already recorded";
        if (cutoffOf(date) <= l.listedAt) return "auction before the listing";
        if (p.refSeq !== priceBefore(l, date)?.seq) return "refSeq must be the latest price before the date";
        if (!sameSeqs(p.sheetSeqs, this.sheetsByDate.get(date) ?? [])) return "sheetSeqs must be every committed sheet for the date";
        const priced = Number.isSafeInteger(p.price) && (p.price as number) > 0 && Number.isSafeInteger(p.volume) && (p.volume as number) > 0;
        return priced || (p.price === null && p.volume === 0) ? null : "invalid price or volume";
      }
      case "shares.allotted": {
        // 上場の日の最初の配分（#110）。まだ何もしていない参加者に、最初の板寄せより前に、発行済株式数の内で配る
        const l = this.listings.get(p.symbol as string);
        if (!l) return "symbol is not listed";
        if (Object.keys(p).some((k) => !ALLOTTED_FIELDS.includes(k))) return "unknown field in an allotment";
        if (l.lastAuction !== null) return "the symbol is already auctioned";
        // 最初の評価の日に板寄せができる銘柄だけ（できないと、評価が書けず先へ進めない）
        if (!this.universe.has(p.symbol as string)) return "symbol is not in the universe";
        // AI投資家は現金だけで始め、株は自分の売買でしか持たない（#110 PR-2d）
        if (st!.kind === "investor") return "shares cannot be allotted to an investor";
        if (cutoffOf(nextBusinessDay(st!.asOf, H)) <= l.listedAt) return "the symbol cannot be auctioned on the first valuation date";
        if (st!.pending || st!.valuedDate !== null || [...this.commits].some((c) => c.startsWith(`${agentId}:`))) return "the agent already started trading";
        if (!Number.isSafeInteger(p.qty) || (p.qty as number) <= 0) return "qty must be a positive integer";
        if (l.allotted + (p.qty as number) > l.sharesOutstanding) return "allotments exceed sharesOutstanding";
        // 取得原価（上場の価格 × 株数）が、正しく扱える整数の範囲に収まること
        if (!Number.isSafeInteger(l.prices[0]!.price * (l.allotted + (p.qty as number)))) return "allotments are too large";
        return null;
      }
      case "company.disclosed": {
        // 決算の発表（MARKET_DESIGN §5）。売上・純利益は円、1株あたり利益と配当は0.1円単位
        if (!this.listings.has(p.symbol as string)) return "symbol is not listed";
        if (Object.keys(p).some((k) => !DISCLOSED_FIELDS.includes(k))) return "unknown field in a disclosure";
        const int = (v: unknown) => Number.isSafeInteger(v);
        if (!int(p.revenue) || (p.revenue as number) < 0 || !int(p.netIncome) || !int(p.eps) || !int(p.dividendPerShare) || (p.dividendPerShare as number) < 0) return "invalid figures";
        return null;
      }
      case "prices.open":
        if (this.closed.has(p.date as string) || !isBusinessDay(p.date as string, H)) return "market was closed";
        return d.recordedAt >= cutoffOf(p.date as string) ? null : "open prices recorded before the cutoff";
      case "prices.close":
        if (!isBusinessDay(p.date as string, H)) return "market was closed";
        // 終値は大引け（15:30）のあと（docs/PAPER_TRADING_RULES.md §1）。締め（8:30）の7時間後
        return d.recordedAt >= cutoffOf(p.date as string) + 7 * 3_600_000 ? null : "close prices recorded before 15:30";
      case "market.closed": {
        const date = p.date as string;
        if (this.opens.has(date)) return "open prices already recorded";
        if ([...this.auctions.keys()].some((k) => k.endsWith(`:${date}`))) return "auction already recorded";
        if (this.closes.has(date)) return "close prices already recorded";
        // すでにその日以後を評価・引け後処理したAIがいれば、営業日の並びが変わって口座が進めなくなる
        for (const a of this.agents.values()) if ((a.valuedDate !== null && a.valuedDate >= date) || a.asOf >= date) return "an agent already passed this date";
        return null;
      }
      case "holidays.adopted": {
        const next = this.ctx.holidayTables.get(String(p.holidaysSha256));
        if (!next || next.contentSha256 !== p.holidaysSha256) return `unknown holiday table ${String(p.holidaysSha256)}`;
        if (!this.calendar) return null;
        if (this.calendar.table.contentSha256 === next.contentSha256) return "this holiday table is already adopted";
        return calendarChange(this.calendar.table, next, this.latest);
      }
      case "universe.set": {
        const symbols = p.symbols;
        if (!Array.isArray(symbols) || !symbols.every((x, i) => typeof x === "string" && SYMBOL.test(x) && (i === 0 || x > (symbols[i - 1] as string)))) return "symbols must be distinct symbol codes in ascending order";
        if (symbols.length === this.universe.size && symbols.every((x) => this.universe.has(x as string))) return "symbols are the same as the current universe";
        const removed = [...this.universe].filter((x) => !symbols.includes(x));
        if (removed.length === 0) return null;
        // 外した銘柄は注文できなくなるので、持っている、または約定待ちの注文票があるAIがいれば外さない（上場廃止の扱いは §9）
        for (const [id, a] of this.agents) {
          if (a.pending) return `agent ${id} has a committed sheet that is not filled yet`;
          const held = removed.find((x) => (this.ctx.accountOf(id).holdings[x]?.qty ?? 0) > 0);
          if (held) return `agent ${id} holds ${held}`;
        }
        return null;
      }
      case "agent.registered": {
        const start = p.startDate;
        // 開始日は、登録した時点で締めがまだ来ていない最初の営業日だけ。先の日にすると、その前の日を臨時休場にできなくなるため
        if (!isValidDate(start) || start !== tradingDateFor(d.recordedAt, H)) return "startDate must be the next trading date";
        // 種類と最初の現金（AI投資家は INITIAL_CASH ちょうど。マーケットメイカーなどは上限まで、#110）
        return registrationProblem(p.kind, p.initialCash);
      }
      case "agent.run":
        if (p.purpose !== "post" && p.purpose !== "order") return "purpose must be post or order";
        return llmRunProblem(p) ?? this.runBatchProblem(d, agentId, H) ?? this.inputProblem(p.inputSeqs, null);
      case "llm.batch.submitted": {
        // ① 提供元に送る前の、依頼の予約（#179）。判断を使う取引日は、依頼を決めた時刻（submittedAt）で締めがまだ来ていない最初の営業日だけ。
        // 提供元のバッチのIDは、送ったあとに llm.batch.sent で足す
        if (Object.keys(p).some((k) => !LLM_SUBMITTED_FIELDS.includes(k))) return "unknown field in a batch submission";
        if (!isShortText(p.provider) || !isShortText(p.modelId) || !isShortText(p.promptVersion)) return "provider, modelId and promptVersion are required (up to 100 characters)";
        if (typeof p.sentBodyHash !== "string" || !SHA256_HEX.test(p.sentBodyHash)) return "sentBodyHash must be a SHA-256 hex digest";
        if (typeof p.customId !== "string" || !CUSTOM_ID.test(p.customId)) return "customId must match ^[A-Za-z0-9_-]{1,64}$";
        // 提供元の一覧で探すときに、別の本文のバッチと取り違えないよう、名前の末尾は本文のハッシュの先頭
        if (!p.customId.endsWith(`-${p.sentBodyHash.slice(0, LLM_CUSTOM_ID_HASH_CHARS)}`)) return `customId must end with - and the first ${String(LLM_CUSTOM_ID_HASH_CHARS)} characters of sentBodyHash`;
        if (!Number.isSafeInteger(p.maxCost) || (p.maxCost as number) < 1) return "maxCost must be a positive integer";
        // 依頼を決めた時刻。取引日と費用の暦日はこれで決める
        const at = p.submittedAt;
        if (!isTime(at) || at > d.recordedAt || d.recordedAt - at > LLM_RECORD_WINDOW_MS) return "submittedAt must be within an hour before recordedAt";
        // 予約に使った料金（閉じたときも同じ料金で数える）と、予約の見積もりに使ったトークン数の上限
        if (!Number.isSafeInteger(p.yenPerUsd) || (p.yenPerUsd as number) < 1) return "yenPerUsd must be a positive integer";
        if (![...LLM_PRICE_FIELDS, "maxInputTokens", "maxOutputTokens"].every((f) => isCount(p[f]))) return "prices and max token counts must be non-negative integers";
        const bound = llmTokenCost({ inputTokens: p.maxInputTokens as number, outputTokens: p.maxOutputTokens as number }, p as unknown as LlmPrice);
        if (bound === null || (p.maxCost as number) < bound) return `maxCost must be at least ${String(bound)} (the cost of the max tokens)`;
        // 本文に書いた出力の上限（max_tokens など）。予約の見積もりの上限を超えると、実際の請求が予約を超えうる
        if (!Number.isSafeInteger(p.bodyMaxOutputTokens) || (p.bodyMaxOutputTokens as number) < 1 || (p.bodyMaxOutputTokens as number) > (p.maxOutputTokens as number)) return "bodyMaxOutputTokens must be a positive integer up to maxOutputTokens";
        try {
          if (p.tradingDate !== tradingDateFor(at, H)) return "tradingDate must be the next trading date";
        } catch {
          return "submittedAt is outside the adopted holiday table";
        }
        // 1日の上限（全提供元の合計）。その日の使用済み（閉じたものは実費、閉じていないものは予約）＋この予約が上限以内のときだけ書ける。
        // 送る前に書くので、上限を超える依頼は送られない。照合（replay）も同じ定数で確かめるので、上限を下げると、
        // それまでの上限で書いた記録が照合を通らなくなりうる（変えるときは、記録した時刻で上限を選ぶ形にする）
        const used = llmCostUsed(this.events, jstDayOf(at)) + (p.maxCost as number);
        return used <= LLM_DAILY_COST_LIMIT ? null : `daily LLM cost limit exceeded (${String(used)} > ${String(LLM_DAILY_COST_LIMIT)})`;
      }
      case "llm.batch.sent": {
        // ③ 送ったあと、提供元が返したバッチのIDを①に足す。1つの①に1回だけ（一意キー）。閉じた①には足せない
        if (Object.keys(p).some((k) => !LLM_SENT_FIELDS.includes(k))) return "unknown field in a batch sending";
        const sub = this.events[(p.batchSeq as number) - 1];
        const subP = sub?.payload as Record<string, unknown> | undefined;
        if (sub?.type !== "llm.batch.submitted" || subP?.agentId !== agentId) return "batchSeq must be llm.batch.submitted of the same agent";
        // 提供元は①と同じ。同じ提供元のバッチのIDは、1つの①にしか書けない（一意キー llmbatchid:<提供元>:<ID>）
        if (p.provider !== subP.provider) return "provider must equal the batch submission";
        if (typeof p.batchId !== "string" || !BATCH_ID.test(p.batchId)) return "batchId must be a provider batch id";
        return this.keys.has(`llmclosed:${String(p.batchSeq)}`) ? "the batch is already closed" : null;
      }
      case "llm.batch.closed": {
        // バッチが閉じた記録。実際の費用が分からなければ、予約した費用をそのまま使う（安全側）
        if (Object.keys(p).some((k) => !LLM_CLOSED_FIELDS.includes(k))) return "unknown field in a batch closing";
        const sub = this.events[(p.batchSeq as number) - 1];
        const sp = sub?.payload as Record<string, unknown> | undefined;
        if (sub?.type !== "llm.batch.submitted" || sp?.agentId !== agentId) return "batchSeq must be llm.batch.submitted of the same agent";
        if (!LLM_RESULTS.includes(p.result)) return "result must be collected, expired or failed";
        const cache = LLM_TOKEN_FIELDS.slice(2);
        if (!isCount(p.cost) || !isCount(p.inputTokens) || !isCount(p.outputTokens) || !cache.every((f) => p[f] === undefined || isCount(p[f]))) return "cost and token counts must be non-negative integers";
        if (p.costUnknown !== undefined && (p.costUnknown !== true || p.cost !== sp.maxCost)) return "an unknown cost must be the reserved maxCost";
        // 送ったか（③があるか）で閉じ方が決まる。③がなければ答えも打ち切りもないので failed だけ。費用は、送っていないと確かなら0
        // （トークン数も0。送れなかった理由 notCreatedError が要る）、分からなければ予約した費用（costUnknown）。
        // ③があれば課金されうるので、答えを受け取っていない閉じ方（expired・failed）は費用0にできない（分からなければ costUnknown）。
        // 答えを受け取ったなら、出力のトークン数は1以上
        const sent = this.keys.has(`llmsent:${String(p.batchSeq)}`);
        const zeroNotSent = !sent && p.costUnknown !== true;
        if (!sent && p.result !== "failed") return "a batch that was not sent can only close as failed";
        if (zeroNotSent && (p.cost !== 0 || !LLM_TOKEN_FIELDS.every((f) => p[f] === undefined || p[f] === 0))) return "a batch that was not sent must cost 0 or the reserved maxCost";
        if (zeroNotSent !== (p.notCreatedError !== undefined)) return "notCreatedError is required exactly when a batch that was not sent closes with cost 0";
        if (zeroNotSent && !LLM_SEND_ERRORS.includes(p.notCreatedError)) return "notCreatedError must be timeout, rate_limited or provider_error";
        if (sent && p.result !== "collected" && p.cost === 0) return "a sent batch that was not collected cannot cost 0";
        if (p.result === "collected" && p.outputTokens === 0) return "a collected batch must have output tokens";
        if (p.costUnknown === true) return LLM_PRICE_FIELDS.every((f) => p[f] === undefined) ? null : "an unknown cost has no price";
        // 料金は予約の料金ちょうど（安い料金や 0 を書いて、その日の使った額を少なく見せられないように）。
        // 提供元が実際にはもっと安く請求しても、予約の料金で数える（多めに数えるので安全側）
        if (!LLM_PRICE_FIELDS.every((f) => p[f] === sp[f])) return "the price must equal the reserved price";
        // 実際の費用は、トークン数と予約の料金から出した値ちょうど。予約を超えるのは書ける（上限の検査が挙げる）
        const want = llmTokenCost(p as unknown as LlmTokens, sp as unknown as LlmPrice);
        return p.cost === want ? null : `cost must be ${String(want)} (from the tokens and the price)`;
      }
      case "post.published":
        if (this.isSuspended(agentId, "posts")) return "suspended";
        if (p.intent !== undefined && !(POST_INTENTS as readonly unknown[]).includes(p.intent)) return `intent must be one of ${POST_INTENTS.join(", ")}`;
        if (p.stance !== undefined && !(POST_STANCES as readonly unknown[]).includes(p.stance)) return `stance must be one of ${POST_STANCES.join(", ")}`;
        return this.runProblem(d, agentId, "post");
      case "order_sheet.committed":
        // 保存済みのログの照合で、祝日の一覧が記録と違うときは、営業日の判定をやり直せない（D-031）
        if (p.holidaysSha256 !== this.calendar?.table.contentSha256) return `holidays table ${String(p.holidaysSha256)} is not the adopted one`;
        return this.rejectionOf(d);
      case "order_sheet.rejected": {
        const allowed = ["agentId", "tradingDate", "reason", "runSeq", "inputSeqs", "orders", "ordersUnreadable"];
        if (Object.keys(p).some((k) => !allowed.includes(k))) return "unknown field in a rejected sheet";
        if (p.ordersUnreadable === true) return p.orders === undefined ? this.unreadableRejectionProblem(d) : "invalid rejected sheet";
        if (p.ordersUnreadable !== undefined || p.orders === undefined) return "invalid rejected sheet";
        // 受け取った注文票から、同じ時点・同じ検査で拒否の理由を出し直し、記録と同じであること
        const again = this.rejectionOf({ ...d, type: "order_sheet.committed", payload: { agentId: p.agentId, tradingDate: p.tradingDate, orders: p.orders, runSeq: p.runSeq, inputSeqs: p.inputSeqs, holidaysSha256: this.calendar?.table.contentSha256 } });
        return again !== null && again === p.reason ? null : `rejection reason ${String(p.reason)} does not match ${String(again)}`;
      }
      case "fills.executed": {
        const pend = st!.pending;
        if (!pend || pend.tradingDate !== p.tradingDate || pend.seq !== p.sheetSeq) return "no committed sheet for this trading date";
        if (this.closed.has(pend.tradingDate)) return p.openSeq === undefined && p.auctionSeqs === undefined ? null : "market was closed";
        // 上場した銘柄の注文は、その銘柄の板寄せの結果で約定する。ほかの銘柄の注文は始値で約定する
        const orders = (this.events[pend.seq - 1]!.payload as Record<string, unknown>).orders as Order[];
        const listed = [...new Set(orders.filter((o) => this.listings.has(o.symbol)).map((o) => o.symbol))];
        const auctionSeqs = listed.map((s) => this.auctions.get(`${s}:${pend.tradingDate}`));
        if (auctionSeqs.some((s) => s === undefined)) return "the listed symbols of the sheet are not auctioned yet";
        if (listed.length === 0 ? p.auctionSeqs !== undefined : !sameSeqs(p.auctionSeqs, (auctionSeqs as number[]).sort((a, b) => a - b))) return "auctionSeqs must be the auctions of the listed symbols in the sheet";
        if (!orders.some((o) => !this.listings.has(o.symbol)) && p.openSeq === undefined) {
          // 始値を使わない約定も、その日の締めのあと（注文票がそろい、板寄せが済んでから）
          return d.recordedAt >= cutoffOf(pend.tradingDate) ? null : "fills recorded before the cutoff";
        }
        const open = this.opens.get(pend.tradingDate);
        return open !== undefined && p.openSeq === open ? null : "openSeq must be prices.open of the trading date";
      }
      case "valuation.recorded": {
        if (st!.pending) return "the committed sheet is not filled yet";
        if (p.date !== nextBusinessDay(st!.asOf, H) || st!.valuedDate === p.date) return "valuation must be for the day after the last post-close";
        if (this.catchUpDue(st!)) return "apply corporate actions moved by the market closure first";
        // 上場した銘柄は、その日の板寄せが済んでから、板寄せの価格で評価する（書く順で評価の価格が変わらないように）
        const held = Object.keys(this.ctx.accountOf(agentId).holdings);
        if (held.some((s) => this.listings.has(s) && !this.auctions.has(`${s}:${String(p.date)}`))) return "auction the held listed symbols of the date first";
        // 上場していない銘柄は、これまでどおりその日の終値で評価する。終値なしで評価できるのは、
        // 取引対象がすべて上場した銘柄で、その日の板寄せが全部済んだとき（その日の価格がそろってから）
        const close = this.closes.get(p.date as string);
        const auctioned = this.universe.size > 0 && [...this.universe].every((s) => this.listings.has(s) && this.auctions.has(`${s}:${String(p.date)}`));
        if (close === undefined && auctioned && p.closeSeq === undefined) return null;
        return close !== undefined && p.closeSeq === close ? null : "closeSeq must be prices.close of the date";
      }
      case "corporate_actions.applied": {
        if (st!.pending) return "the committed sheet is not filled yet";
        if (p.closedSeq !== undefined) {
          // 臨時休場の追加分（§3.3）：D の引け後処理のあと、D の翌営業日を休場にした、その休場について1回だけ
          const c = st!.catchUp;
          if (!c || c.closedSeq !== p.closedSeq || c.date !== p.asOf) return "no market closure to catch up for this agent and date";
        } else if (st!.valuedDate !== p.asOf || st!.asOf === p.asOf) return "value the day before applying corporate actions";
        if (p.exDate !== nextBusinessDay(p.asOf as string, H)) return "exDate must be the next business day";
        // 渡す公表は、権利落ち日がこの日の公表だけを、seq の昇順で（§3.3）
        const seqs = p.announcedSeqs as unknown[];
        for (const [i, s] of seqs.entries()) {
          const e = this.events[(s as number) - 1];
          if (e?.type !== "corporate_action.announced" || (e.payload as Record<string, unknown>).exDate !== p.exDate) return `announcedSeqs must be announcements with exDate ${String(p.exDate)}`;
          if (i > 0 && (s as number) <= (seqs[i - 1] as number)) return "announcedSeqs must be in ascending order";
        }
        // 権利落ち日がこの日の公表は、保有の有無によらず全部渡す（反映の漏れを防ぐ）
        const all = this.announced.get(p.exDate as string) ?? [];
        if (all.length !== seqs.length) return `announcedSeqs must include every announcement with exDate ${String(p.exDate)}`;
        return null;
      }
      case "agent.suspended":
      case "agent.resumed": {
        if (p.scope !== "posts" && p.scope !== "orders" && p.scope !== "both") return "scope must be posts, orders or both";
        if (typeof p.reason !== "string" || p.reason === "") return "reason is required";
        if (d.type === "agent.resumed") {
          const set = this.suspended.get(p.agentId as string);
          const scopes = p.scope === "both" ? ["posts", "orders"] : [p.scope];
          if (!scopes.some((x) => set?.has(x))) return "not suspended (resuming * does not resume a single agent)";
        }
        return null;
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
    for (const f of JUDGED_DATES[e.type] ?? []) if (isValidDate(p[f]) && (p[f] as string) > this.latest) this.latest = p[f] as string;
    switch (e.type) {
      case "holidays.adopted": {
        const table = this.ctx.holidayTables.get(p.holidaysSha256 as string)!;
        this.calendar = { table, covered: coveredHolidays(table, `${table.firstYear}-01-01`, `${table.lastYear}-12-31`) };
        break;
      }
      case "company.listed":
        this.listings.set(p.symbol as string, { sharesOutstanding: p.sharesOutstanding as number, prices: [{ date: "", price: p.price as number, seq: e.seq }], lastAuction: null, listedAt: e.recordedAt, allotted: 0 });
        break;
      case "auction.cleared": {
        const l = this.listings.get(p.symbol as string)!;
        this.auctions.set(`${String(p.symbol)}:${String(p.date)}`, e.seq);
        l.lastAuction = p.date as string;
        this.lastAuctionDate = p.date as string;
        if (p.price !== null) l.prices.push({ date: p.date as string, price: p.price as number, seq: e.seq });
        break;
      }
      case "shares.allotted":
        this.listings.get(p.symbol as string)!.allotted += p.qty as number;
        break;
      case "universe.set":
        this.universe = new Set(p.symbols as string[]);
        break;
      case "prices.open":
        this.opens.set(p.date as string, e.seq);
        break;
      case "prices.close":
        this.closes.set(p.date as string, e.seq);
        break;
      case "corporate_action.announced": {
        const list = this.announced.get(String(p.exDate)) ?? [];
        list.push(e.seq);
        this.announced.set(String(p.exDate), list);
        break;
      }
      case "market.closed": {
        const date = p.date as string;
        const before = previousBusinessDay(date, this.holidays());
        const moved = nextBusinessDay(before, this.holidays()) === date;
        this.closed.set(date, e.seq);
        // 休場の前営業日 D の引け後処理が済んだAIは、権利落ち日が D の翌営業日にずれた公表を、追加の処理で反映する（§3.3）。
        // もともと休みの日（土日・祝日）を休場にしても、D の翌営業日は変わらないので要らない。
        // 追加の処理の前に次の日も休場にしたら、新しい休場で上書きする（前の休場の翌営業日が権利落ち日の公表は、§6.2 の訂正で扱う）
        if (moved) for (const a of this.agents.values()) if (a.asOf === before) a.catchUp = { date: before, closedSeq: e.seq };
        break;
      }
      case "agent.registered":
        this.agents.set(agentId, { startDate: p.startDate as string, asOf: previousBusinessDay(p.startDate as string, this.holidays()), valuedDate: null, pending: null, catchUp: null, kind: (p.kind as ParticipantKind | undefined) ?? "investor" });
        break;
      case "order_sheet.committed":
        this.sheetsByDate.set(p.tradingDate as string, [...(this.sheetsByDate.get(p.tradingDate as string) ?? []), e.seq]);
        st!.pending = { tradingDate: p.tradingDate as string, seq: e.seq };
        st!.catchUp = null;
        this.commits.add(`${agentId}:${String(p.tradingDate)}`);
        break;
      case "fills.executed":
        st!.pending = null;
        break;
      case "valuation.recorded":
        st!.valuedDate = p.date as string;
        st!.catchUp = null;
        break;
      case "corporate_actions.applied":
        st!.asOf = p.asOf as string;
        st!.catchUp = null;
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

  /**
   * LLM の agent.run が、元のバッチ（batchSeq）を正しく指しているか（#179）。規則で動くAIと、これまでの記録は batchSeq を持たない。
   * 指す先は、同じAIの、答えを受け取った（collected）llm.batch.closed。送った本文のハッシュは、その依頼の記録と同じ。
   * run は、その依頼の取引日の締め（8:30）より前に書く（締めのあとの答えは使わない）
   */
  private runBatchProblem(d: Draft, agentId: string, H: ReadonlySet<string>): string | null {
    const p = d.payload;
    if (p.batchSeq === undefined) return null;
    const c = this.events[(p.batchSeq as number) - 1];
    const cp = c?.payload as Record<string, unknown> | undefined;
    if (c?.type !== "llm.batch.closed" || cp?.agentId !== agentId || cp.result !== "collected") return "batchSeq must be a collected llm.batch.closed of the same agent";
    const sp = this.events[(cp.batchSeq as number) - 1]!.payload as Record<string, unknown>;
    if (p.sentBodyHash !== sp.sentBodyHash) return "sentBodyHash must match the batch submission";
    // 入力は、依頼を送る前に記録した情報だけ（送った本文に入っていない情報を、判断に使ったと書けないように）
    if (Array.isArray(p.inputSeqs) && !p.inputSeqs.every((s) => typeof s === "number" && s < (cp.batchSeq as number))) return "inputSeqs must be recorded before the batch submission";
    try {
      return tradingDateFor(d.recordedAt, H) === sp.tradingDate ? null : "the run must be recorded before the cutoff of the batch's trading date";
    } catch {
      return "recordedAt is outside the adopted holiday table";
    }
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
      if ((e.type === "prices.open" || e.type === "prices.close" || e.type === "valuation.recorded" || e.type === "auction.cleared") && !((ip.date as string) < tradingDate)) return "price input not before the trading date";
      // 決算の発表は、記録した時刻が締めより前のものだけ（source.captured の公開時刻と同じ決まり）。
      // 注文票は締めより前に確定し、記録の時刻は戻らないので、今の流れでは起きない。守りのための確かめ
      if (e.type === "company.disclosed" && !(e.recordedAt < cutoffOf(tradingDate))) return "input disclosed after the cutoff";
    }
    return null;
  }
}

/**
 * 祝日の一覧を替えてよいか（§3.5）。ログがもう使った日付（latest まで）の休場日が同じで、
 * 新しい一覧が、いまの一覧の始まりの年から latest の年までを覆うこと。latest より後の日付は直してよい
 */
function calendarChange(cur: HolidayTable, next: HolidayTable, latest: string): string | null {
  const lastUsed = latest === "" ? cur.firstYear : Number(latest.slice(0, 4));
  if (next.firstYear > cur.firstYear || next.lastYear < lastUsed) return `holiday table must cover ${cur.firstYear}-${lastUsed}`;
  for (const d of new Set([...cur.dates, ...next.dates])) {
    if (Number(d.slice(0, 4)) >= cur.firstYear && d <= latest && cur.dates.has(d) !== next.dates.has(d)) return `holiday table changes ${d}, which the log already used`;
  }
  return null;
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
    case "corporate_action.announced":
      // 同じ銘柄・種類・権利落ち日の公表は1件だけ。内容が変われば §6.2 の訂正で表す
      if (typeof p.symbol !== "string" || !SYMBOL.test(p.symbol)) return "invalid symbol";
      if (p.kind !== "split" && p.kind !== "dividend") return "invalid kind";
      return k(["exDate"], () => [`announce:${String(p.symbol)}:${String(p.kind)}:${String(p.exDate)}`]);
    case "company.listed":
      if (typeof p.symbol !== "string" || !SYMBOL.test(p.symbol)) return "invalid symbol";
      return [`listed:${p.symbol}`];
    case "shares.allotted":
      if (typeof p.symbol !== "string" || !SYMBOL.test(p.symbol)) return "invalid symbol";
      return k(["agentId"], () => [`allot:${String(id)}:${String(p.symbol)}`]);
    case "company.disclosed":
      if (typeof p.symbol !== "string" || !SYMBOL.test(p.symbol)) return "invalid symbol";
      if (typeof p.period !== "string" || !PERIOD.test(p.period)) return "invalid period";
      return [`disclosed:${p.symbol}:${p.period}`];
    case "auction.cleared":
      if (typeof p.symbol !== "string" || !SYMBOL.test(p.symbol)) return "invalid symbol";
      return k(["date"], () => [`auction:${String(p.symbol)}:${String(p.date)}`]);
    case "agent.registered":
      return k(["agentId"], () => [`agent:${String(id)}`]);
    case "order_sheet.committed":
      return k(["agentId", "tradingDate"], () => [`sheet:${String(id)}:${String(p.tradingDate)}`]);
    case "fills.executed":
      return k(["agentId", "tradingDate"], () => [`fills:${String(id)}:${String(p.tradingDate)}`]);
    case "agent.run":
      // バッチの1つの答えから書ける実行は、目的（投稿・注文）ごとに1回だけ
      if (p.batchSeq === undefined) return [];
      if (!Number.isSafeInteger(p.batchSeq)) return "invalid batchSeq";
      return [`llmrun:${String(p.batchSeq)}:${String(p.purpose)}`];
    case "llm.batch.submitted":
      return k(["agentId", "tradingDate"], () => [`llmbatch:${String(id)}:${String(p.tradingDate)}`]);
    case "llm.batch.sent":
      // 1つの依頼に、送った記録は1回だけ
      if (!Number.isSafeInteger(p.batchSeq)) return "invalid batchSeq";
      return k(["agentId"], () => [`llmsent:${String(p.batchSeq)}`, `llmbatchid:${String(p.provider)}:${String(p.batchId)}`]);
    case "llm.batch.closed":
      // 1つの依頼は1回だけ閉じる
      if (!Number.isSafeInteger(p.batchSeq)) return "invalid batchSeq";
      return k(["agentId"], () => [`llmclosed:${String(p.batchSeq)}`]);
    case "valuation.recorded":
      return k(["agentId", "date"], () => [`valuation:${String(id)}:${String(p.date)}`]);
    case "corporate_actions.applied": {
      if (!Array.isArray(p.announcedSeqs)) return "invalid announcedSeqs";
      if (p.closedSeq !== undefined && !Number.isSafeInteger(p.closedSeq)) return "invalid closedSeq";
      // 臨時休場の追加分は post_close:<id>:<D>:<休場のseq>（§3.3）
      const day = p.closedSeq === undefined ? String(p.asOf) : `${String(p.asOf)}:${String(p.closedSeq)}`;
      return k(["agentId", "asOf"], () => [`post_close:${String(id)}:${day}`, ...(p.announcedSeqs as unknown[]).map((s) => `ca:${String(id)}:${String(s)}`)]);
    }
    case "ledger.adjusted":
      if (!Number.isSafeInteger(p.correctionSeq)) return "invalid correctionSeq";
      return k(["agentId"], () => [`adjust:${String(id)}:${String(p.correctionSeq)}`]);
    default:
      return [];
  }
}

/**
 * agent.run の、LLM の費用とトークン数の任意の項目（#179）。規則で動くAIは書かない。
 * maxCost：費用の見積もり（予約）。cost：実際の費用（分からなければ maxCost）。どちらも0.1円単位。sentBodyHash：提供元に実際に送った本文のハッシュ
 */
function llmRunProblem(p: Record<string, unknown>): string | null {
  if (p.maxCost !== undefined && (!Number.isSafeInteger(p.maxCost) || (p.maxCost as number) < 1)) return "maxCost must be a positive integer";
  for (const f of ["cost", "inputTokens", "outputTokens"]) if (p[f] !== undefined && !isCount(p[f])) return `${f} must be a non-negative integer`;
  if (p.sentBodyHash !== undefined && (typeof p.sentBodyHash !== "string" || !SHA256_HEX.test(p.sentBodyHash))) return "sentBodyHash must be a SHA-256 hex digest";
  return null;
}

function payloadSeqs(p: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  for (const f of SEQ_FIELDS) if (p[f] !== undefined) out.push(p[f]);
  for (const f of SEQ_LIST_FIELDS) if (Array.isArray(p[f])) out.push(...(p[f] as unknown[]));
  return out;
}

const seqsShapeOk = (runSeq: unknown, inputSeqs: unknown): boolean => Number.isSafeInteger(runSeq) && Array.isArray(inputSeqs) && inputSeqs.every((x) => Number.isSafeInteger(x));

/** 上場した銘柄の状態。prices は最初の価格（date は ""）と、価格のついた板寄せの結果 */
interface ListingState {
  sharesOutstanding: number;
  prices: { date: string; price: number; seq: number }[];
  /** 最後に板寄せをした日（価格がつかなかった日も含む） */
  lastAuction: string | null;
  /** 上場を記録した時刻。締めがこれより後の日からだけ板寄せできる */
  listedAt: number;
  /** 最初の配分（shares.allotted）で配った株数の合計 */
  allotted: number;
}

/** その日より前の直近の価格（値幅の基準。なければ上場の価格） */
function priceBefore(l: ListingState, date: string): { price: number; seq: number } | undefined {
  return l.prices.filter((x) => x.date < date).at(-1);
}

/** seq の並びが、want と同じ（同じ順） */
function sameSeqs(v: unknown, want: readonly number[]): boolean {
  return Array.isArray(v) && v.length === want.length && v.every((s, i) => s === want[i]);
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
