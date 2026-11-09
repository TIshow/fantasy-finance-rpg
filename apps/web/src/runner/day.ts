// 1日の流れ（#27 PR-1）。取引日 T について、前の日の残り（始値の約定・引け後）→ 判断（締めより前）→ 寄り付きの約定
// → 引け後の処理と評価、の順に行う。T の引けのあとに回したときは、続けて次の取引日の判断（と LLM の受け取り）も進める
// （判断の受け付けは、前の取引日の引けのあとから。#228）。取引日は架空の市場の暦（D-047。2026-11-09 から毎日）。書くのは保管（EventStore）だけ。約定・評価・引け後の中身は、runner が持つ台帳
// （Ledger.compute*）で作る。どの段も、ログを見て済んでいる分は飛ばし、欠けている分だけを書くので、同じ日をもう一度
// 回しても二重にならず、途中で落ちても回し直せば続きから進む。外部通信・DB なし。LLM は渡された口（deps.llm）だけを使う。
// 前提：保管に書くのは、1つの runner だけ（runDay の途中に別の書き手が追記すると、写しと合わずに例外になる）。
import type { Clock, EventStore, MarketDataPort, PriceObservation, SheetInput } from "../contracts";
import { EventLog } from "../events/append";
import { canonicalize } from "../events/canonical";
import { sha256Hex } from "../events/hash";
import { Ledger } from "../events/replay";
import type { LogEvent } from "../events/types";
import type { HolidayTable } from "../holidays/table";
import { cutoffOf, decisionOpensAt, isTradingDay, nextTradingDay, previousTradingDay } from "../ledger/ledger";
import type { Account, Deciyen, Order } from "../ledger/types";
import type { ValuesPort } from "../store/pg-values";
import { type SplitInput, adjustCloses } from "./adjust";
import { llmCollect } from "./llm-collect";
import { type Appended, type DayAccess, type LlmDeps, LocalCopyError, errorText, llmSubmit } from "./llm-stage";
import { discloseDue } from "./world/disclosure";

/** 判断の入力：その時点までに記録した終値（seq つき）。値はログの外から引き、凍結した写しを渡す */
export interface CloseInput {
  seq: number;
  date: string;
  prices: Readonly<Record<string, Deciyen | null>>;
}

/** 上場した銘柄の、判断の時点までの記録（seq つき）。上場の価格・判断の日より前の板寄せの結果・締めより前の決算の発表 */
export interface ListedInput {
  symbol: string;
  listing: { seq: number; price: Deciyen; sharesOutstanding: number };
  /** 値幅の基準の価格：判断の日より前で、価格のついた直近の板寄せ（日数で切らない）。まだなければ上場の記録。注文票の検査と同じ決め方 */
  refPrice: { seq: number; price: Deciyen };
  /** 板寄せの結果（古い順。新しい方から inputDays 日分） */
  auctions: readonly { seq: number; date: string; price: Deciyen | null; volume: number }[];
  /** 決算の発表（記録の順。新しい方から4四半期分） */
  disclosures: readonly { seq: number; period: string; revenue: number; netIncome: number; eps: Deciyen; dividendPerShare: Deciyen }[];
}

export interface DecisionInput {
  agentId: string;
  tradingDate: string;
  at: number;
  /** 終値。値は分割で調整済み（権利落ち日より前の値を from/to 倍。splits から adjustCloses で作り直せる） */
  closes: readonly CloseInput[];
  /** 終値の列の間（最初の終値の日より後、判断の日まで）が権利落ち日の分割。公表の seq を inputSeqs に入れる */
  splits: readonly SplitInput[];
  /** 口座。根拠のイベント（そのAIの最後の引け後の処理）の seq を inputSeqs に入れる */
  account: Account;
  /** 取引対象のうち上場した銘柄（銘柄コードの順）。記録の seq を inputSeqs に入れる */
  listed: readonly ListedInput[];
  /**
   * 最初の現金（登録の initialCash）と、最初に配った株（shares.allotted。銘柄ごとの合計）。登録と配分の記録の seq を
   * inputSeqs に入れる。売買役が、最初からのずれで注文を片寄らせるのに使う
   */
  start: { cash: Deciyen; shares: Readonly<Record<string, number>> };
}

export interface Decision {
  orders: Order[];
  post: { board: string; text: string } | null;
  /** 判断の説明（出力の一部としてログの外に残す） */
  note: string;
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
  /**
   * 値と本文を置く・引く口（メモリの RunnerValues か、Postgres の PgValueStore）。store に渡したものと同じものを渡す
   * （store は追記の前に、ここに置いた値をハッシュで引いて確かめる）
   */
  values: ValuesPort;
  holidayTables: ReadonlyMap<string, HolidayTable>;
  agents: readonly RunnerAgent[];
  /** 時計の権威（保管と同じもの） */
  clock: Clock;
  /** at まで待つ（本番は実際に待つ。試験は時計を進める）。at が過去ならすぐ戻る */
  waitUntil(at: number): Promise<void>;
  /** 判断の入力に渡す終値の日数（新しい方から） */
  inputDays?: number;
  /**
   * 架空の企業の決算を発表するときの乱数の種（上場と同じもの）。渡せば、前の日の残りを補ったあと・判断の前と、
   * 1日の最後に、時期が来た四半期の決算（company.disclosed）を書く。渡さなければ発表しない（呼ぶ側が discloseDue を呼ぶ）
   */
  seed?: number;
  /**
   * LLM の AI 投資家（#179）。渡せば、引けのあとにその次の取引日の分を各社のバッチに依頼し（llmSubmit）、
   * 答えが返ったら、取引日の締めまでのどの実行でも受け取って投稿と注文票を書く（llmCollect。規則の AI の判断のあと）。
   * 渡さなければ LLM を呼ばない
   */
  llm?: LlmDeps;
  /**
   * true なら、次の取引日の判断を受け付ける時間（date の引けのあとから、次の取引日の締めの前まで）に始めた実行で、
   * date の段のあとに、次の取引日の判断と LLM の受け取りも進める（夜の実行。#228）。毎日の実行（runDaily）は true にする。
   * 渡さなければ、date の段だけ（次の取引日の判断は、その日の runDay が受け付けの始まりから行う）
   */
  decideNext?: boolean;
}

const HOUR = 3_600_000;
/**
 * 寄り付きの取り込み（9:30）・引けの取り込み（16:30）。日本時間。closed（架空の市場の休み。EventLog.holidays()）を渡せば、
 * 判断の受け付けの始まり（decideAt：前の取引日の引けの 16:30。decisionOpensAt。#228）も返す
 */
export function scheduleOf(date: string): { openAt: number; closeAt: number };
export function scheduleOf(date: string, closed: ReadonlySet<string>): { decideAt: number; openAt: number; closeAt: number };
export function scheduleOf(date: string, closed?: ReadonlySet<string>) {
  const at = { openAt: cutoffOf(date) + HOUR, closeAt: cutoffOf(date) + 8 * HOUR };
  return closed ? { decideAt: decisionOpensAt(date, closed), ...at } : at;
}

/**
 * 段ごとの結果：書いた・済んでいた・待つ（データがまだない、など）・飛ばした（締めの後など）。待った段は、回し直せば進む。
 * date は、次の取引日の段（引けのあとに続けて進めた判断と受け取り）にだけ付ける
 */
export type StageResult = { stage: string; status: "written" | "done" | "waiting" | "skipped"; detail?: string; date?: string };

/**
 * date（取引日）の分を、済んでいない段から進める。deps.decideNext が true で、次の取引日の判断を受け付ける時間
 * （date の引けのあとから、次の取引日の締めの前まで）に始めた実行なら、続けて次の取引日の判断と LLM の受け取りも進める
 * （夜の実行で、翌朝を待たずに判断する。#228）。date が取引日でない（臨時休場）ときも、次の取引日の判断は進める。
 * 引けより前に始めて引けまで待った実行（--wait）は、次の取引日の判断を、次の取引日の runDay に任せる
 * （その runDay は、受け付けの始まり（decideAt）がもう来ているので、待たずに判断する）
 */
export async function runDay(date: string, deps: RunnerDeps): Promise<StageResult[]> {
  const startedAt = deps.clock.now();
  const day = await Day.load(deps);
  const out: StageResult[] = [];
  const disclose = async () => {
    if (deps.seed === undefined) return;
    const written = await day.disclose(deps.seed);
    if (written.length > 0) out.push({ stage: "disclose", status: "written", detail: written.join(",") });
  };
  /**
   * 前の取引日 closeDate の引けのあとに出すはずだった LLM の依頼を、まだなければ出す（夜の実行が抜けたとき）。済んでいる・時間の外なら
   * llmSubmit は何も書かない。書いた・待つ・失敗だけを結果に残す（ふだんは、前の日の夜に済んでいるか、時間の外で飛ばす）
   */
  const lateSubmit = async (closeDate: string) => {
    if (!deps.llm) return;
    const r = await llmStage("llm.submit", () => llmSubmit(day.access(), deps.llm!, closeDate));
    if (r.status === "written" || r.status === "waiting" || (r.detail ?? "").startsWith("error: ")) out.push(r);
  };
  const collect = async (d: string) => (deps.llm ? [await llmStage("llm.collect", () => llmCollect(day.access(!deps.llm!.policy.dryRun), deps.llm!, d))] : []);
  if (!isTradingDay(date, day.log.holidays())) out.push({ stage: "day", status: "skipped", detail: "not a trading day" });
  else {
    const prev = previousTradingDay(date, day.log.holidays());
    const s = scheduleOf(date, day.log.holidays());
    await deps.waitUntil(s.decideAt);
    let submitted = false;
    const decideStage = async () => {
      out.push(...(await day.catchUp(prev)));
      // 前の日の板寄せをここで補ったなら、その日の引けのあとに来た発表も、判断の前に書く（判断が、締めより前の発表を見るように）
      await disclose();
      // 前の日の夜の実行（16:35・17:50・23:50）がすべて抜け、日付の変わったあと（04:50 など）が最初の実行なら、
      // この日の分の LLM の依頼をここで出す（引け後の処理 → 依頼 → 判断 → 受け取りの順。済んでいれば llmSubmit は何も書かない）。
      // 毎日の実行（decideNext）だけ。依頼は締めの前・前の日の引けのあとだけ書け、出した依頼はもう出さない
      if (deps.decideNext === true && !submitted) {
        submitted = true;
        await lateSubmit(prev);
      }
      const r = [await day.decide(date, prev), ...(await collect(date))];
      out.push(...r);
      return r.some((x) => x.status === "waiting");
    };
    // 待つ段があれば、朝（締めの1時間半前）にもう一度試す。実際に待つ実行（--wait・試験）だけ。待たない実行（GitHub Actions）は、
    // 時計が進まないので試し直さず、あとの実行（04:50・06:50・07:20）が進める
    if (await decideStage()) {
      const morning = cutoffOf(date) - 1.5 * HOUR;
      if (deps.clock.now() < morning) {
        await deps.waitUntil(morning);
        if (deps.clock.now() >= morning) await decideStage();
      }
    }
    await deps.waitUntil(s.openAt);
    out.push(await day.open(date));
    await deps.waitUntil(s.closeAt);
    out.push(...(await day.catchUp(date)));
    await disclose();
    if (deps.llm) out.push(await llmStage("llm.submit", () => llmSubmit(day.access(), deps.llm!, date)));
  }
  // 次の取引日の判断：受け付けの時間の中で、まだ締めの前のときだけ（手で古い日を回したときに、締めを過ぎた日を「間に合わなかった」と書かない）
  const next = nextTradingDay(date, day.log.holidays());
  const now = deps.clock.now();
  if (deps.decideNext === true && startedAt >= decisionOpensAt(next, day.log.holidays()) && now < cutoffOf(next)) {
    const prevOfNext = previousTradingDay(next, day.log.holidays());
    // 朝の実行と同じ順：前の日の残りを補い、時期が来た決算を書いてから判断する（発表は板寄せの日の 15:30 のあとなので、
    // 引けのあとに書いた分で、次の締めまでに来る発表はすべて）
    const tagged = (r: StageResult): StageResult => ({ ...r, date: next });
    out.push(...(await day.catchUp(prevOfNext)));
    await disclose();
    // date が臨時休場の日なら、その日の段では依頼を出していない（取引日の段は llmSubmit(date) で済んでいる）
    await lateSubmit(prevOfNext);
    out.push(tagged(await day.decide(next, prevOfNext)));
    out.push(...(await collect(next)).map(tagged));
  }
  return out;
}

/**
 * LLM の段の例外は、その段の結果（detail が "error: " で始まる）にして、ほかの段を止めない（毎日の実行は、この結果で失敗の終了コードにする）。
 * 文は例外の文だけ（API キーは口の外に出ない）。改行・制御文字を空白にし、200文字で切る（errorText）
 */
async function llmStage(stage: string, f: () => Promise<StageResult>): Promise<StageResult> {
  try {
    return await f();
  } catch (e) {
    return { stage, status: "skipped", detail: `error: ${errorText(e)}` };
  }
}

/** AIが返した判断の形を確かめ、記録する形にする（post と note を省いたものは、null と空の文字列）。形が違えば例外 */
function decisionOf(d: unknown): Decision {
  if (typeof d !== "object" || d === null) throw new TypeError("decision must be an object");
  const { orders, post, note } = d as Record<string, unknown>;
  if (!Array.isArray(orders)) throw new TypeError("orders must be an array");
  if (note !== undefined && typeof note !== "string") throw new TypeError("note must be a string");
  if (post !== undefined && post !== null) {
    const { board, text } = (typeof post === "object" ? post : {}) as Record<string, unknown>;
    if (typeof board !== "string" || typeof text !== "string") throw new TypeError("post must have a board and a text");
    return { orders: orders as Order[], post: { board, text }, note: note ?? "" };
  }
  return { orders: orders as Order[], post: null, note: note ?? "" };
}

type Payload = Record<string, unknown>;
const pl = (e: LogEvent) => e.payload as Payload;
const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) for (const x of Object.values(Object.freeze(v))) deepFreeze(x);
  return v;
};

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

  private find(type: LogEvent["type"], match: (p: Payload) => boolean = () => true): LogEvent | undefined {
    return this.log.events.find((e) => e.type === type && match(pl(e)));
  }

  private async sync(r: { ok: true; event: LogEvent } | { ok: false; reason: string }, what: string): Promise<LogEvent> {
    if (!r.ok) throw new Error(`${what}: ${r.reason}`);
    const problem = await this.log.admit(r.event);
    if (problem) throw new Error(`${what}: ${problem}`);
    await this.ledger.apply(r.event);
    return r.event;
  }

  private append(type: Parameters<EventStore["append"]>[0]["type"], actor: Parameters<EventStore["append"]>[0]["actor"], payload: Payload, refs: number[] = []) {
    return this.deps.store.append({ type, actor, refs, payload }).then((r) => this.sync(r, type));
  }

  /**
   * LLM の段（llm-stage.ts）に渡す口。追記は断られても例外にせず、書けたら写しにも当てる。
   * orders が false（試運転）なら、注文票を確定する口（commitSheet）を持たない凍結したオブジェクトを返す
   */
  access(orders = false): DayAccess {
    // 保管に書けたのに写しに当てられなければ LocalCopyError（写しと保管がずれるので、LLM の段は段ごと止める）
    const write = async (r: Appended, what: string): Promise<Appended> => {
      if (!r.ok) return r;
      try {
        return { ok: true, event: await this.sync(r, what) };
      } catch (e) {
        throw new LocalCopyError(e instanceof Error ? e.message : String(e));
      }
    };
    const base = {
      events: () => this.log.events,
      holidays: () => this.log.holidays(),
      account: (id: string) => this.ledger.account(id),
      clock: this.deps.clock,
      values: this.deps.values,
      append: async (type: Parameters<DayAccess["append"]>[0], payload: Payload, refs: number[]) => write(await this.deps.store.append({ type, actor: "system", refs, payload }), type),
      post: async (payload: Payload, refs: number[]) => write(await this.deps.store.append({ type: "post.published", actor: `agent:${String(payload.agentId)}`, refs, payload }), "post.published"),
    };
    if (!orders) return Object.freeze(base);
    return Object.freeze({ ...base, commitSheet: async (id: string, sheet: SheetInput) => write(await this.deps.store.commitSheet(id, sheet), `commitSheet ${id}`) });
  }

  /** 時期が来た決算の発表を書き、写しにも当てる（discloseDue が保管に追記した分を、ここで検査して取り込む） */
  async disclose(seed: number): Promise<string[]> {
    const s = this.deps.store;
    const store: EventStore = {
      read: (after, limit) => s.read(after, limit),
      last: () => s.last(),
      commitSheet: () => Promise.reject(new Error("disclose does not commit sheets")),
      append: async (draft) => {
        const r = await s.append(draft);
        if (r.ok) await this.sync(r, draft.type);
        return r;
      },
    };
    return discloseDue(store, seed, this.deps.clock);
  }

  /** その日に動くAI（登録済みで、開始日が date 以前） */
  private agentsOn(date: string): string[] {
    return this.log.events.filter((e) => e.type === "agent.registered" && (pl(e).startDate as string) <= date).map((e) => pl(e).agentId as string);
  }

  private universe(): string[] {
    const u = this.log.events.filter((e) => e.type === "universe.set").at(-1);
    return u ? (pl(u).symbols as string[]) : [];
  }

  /** 取引対象がすべて上場した銘柄か。そうなら、外の始値・終値を取り込まず、板寄せの価格だけで動く（#113 PR-3b） */
  private listedOnly(): boolean {
    const listed = this.listings();
    const u = this.universe();
    return u.length > 0 && u.every((x) => listed.has(x));
  }

  /** date の板寄せがそろったか（date の締めより前に上場した、取引対象の銘柄すべて。臨時休場の日は板寄せがない） */
  private auctionsDone(date: string): boolean {
    if (this.find("market.closed", (p) => p.date === date)) return true;
    const listed = this.listings();
    return this.universe().every((x) => !listed.has(x) || cutoffOf(date) <= listed.get(x)! || this.find("auction.cleared", (p) => p.symbol === x && p.date === date) !== undefined);
  }

  /** date の価格がそろったか：終値。取引対象がすべて上場した銘柄なら、板寄せ */
  private pricesDone(date: string): boolean {
    return this.listedOnly() ? this.auctionsDone(date) : this.find("prices.close", (p) => p.date === date) !== undefined;
  }

  /** 上場した銘柄（company.listed）と、その記録の時刻。これらの価格は外から取り込まず、板寄せで決める */
  private listings(): Map<string, number> {
    return new Map(this.log.events.filter((e) => e.type === "company.listed").map((e) => [pl(e).symbol as string, e.recordedAt]));
  }

  /**
   * 判断の入力にする、取引対象のうち上場した銘柄の記録。板寄せは date より前の日の分、決算の発表は date の締めより前に
   * 記録した分だけ（まだ発表していない業績で判断しないように）
   */
  private listedInputs(date: string): ListedInput[] {
    const listed = this.listings();
    const days = this.deps.inputDays ?? 20;
    return this.universe()
      .filter((x) => listed.has(x))
      .map((symbol) => {
        const listing = this.find("company.listed", (p) => p.symbol === symbol)!;
        const before = this.log.events.filter((e) => e.type === "auction.cleared" && pl(e).symbol === symbol && (pl(e).date as string) < date);
        const auctions = before.slice(-days);
        const ref = before.filter((e) => pl(e).price !== null).at(-1) ?? listing;
        const disclosures = this.log.events.filter((e) => e.type === "company.disclosed" && pl(e).symbol === symbol && e.recordedAt < cutoffOf(date)).slice(-4);
        return {
          symbol,
          listing: { seq: listing.seq, price: pl(listing).price as Deciyen, sharesOutstanding: pl(listing).sharesOutstanding as number },
          refPrice: { seq: ref.seq, price: pl(ref).price as Deciyen },
          auctions: auctions.map((e) => ({ seq: e.seq, date: pl(e).date as string, price: pl(e).price as Deciyen | null, volume: pl(e).volume as number })),
          disclosures: disclosures.map((e) => {
            const q = pl(e);
            return { seq: e.seq, period: q.period as string, revenue: q.revenue as number, netIncome: q.netIncome as number, eps: q.eps as Deciyen, dividendPerShare: q.dividendPerShare as Deciyen };
          }),
        };
      });
  }

  /** ログの停止・再開から、いまの停止を求める（EventLog と同じ決め方。"*" は全体） */
  private suspended(agentId: string, scope: "posts" | "orders"): boolean {
    const on = new Map<string, Set<string>>();
    for (const e of this.log.events) {
      if (e.type !== "agent.suspended" && e.type !== "agent.resumed") continue;
      const p = pl(e);
      const set = on.get(p.agentId as string) ?? new Set<string>();
      for (const x of p.scope === "both" ? ["posts", "orders"] : [p.scope as string]) (e.type === "agent.suspended" ? set.add(x) : set.delete(x));
      on.set(p.agentId as string, set);
    }
    return [agentId, "*"].some((id) => on.get(id)?.has(scope) ?? false);
  }

  /**
   * 窓から、取引対象のうち上場した銘柄以外の date の観測を引いて prices.* を書き、出典ごとに source.captured を書く。1銘柄でもなければ待つ。
   * 済んでいれば、その記録の取得時刻までの観測で、欠けた source.captured だけを補う（prices.* の後に落ちたとき）
   */
  private async ingest(date: string, kind: "open" | "close"): Promise<LogEvent | StageResult> {
    const stage = kind === "open" ? "prices.open" : "prices.close";
    const recorded = this.find(stage, (p) => p.date === date);
    const view = this.deps.market.asOf(recorded ? (pl(recorded).fetchedAt as number) + 1 : this.deps.clock.now());
    const obs: PriceObservation[] = [];
    const listed = this.listings();
    for (const symbol of this.universe().filter((x) => !listed.has(x))) {
      // 新しい日の観測があっても、その日の最新の版を選ぶ（後から前の日を回し直せるように）
      const o = (await view.history(symbol)).filter((x) => x.date === date && x.kind === kind).at(-1);
      if (!o) return { stage, status: "waiting", detail: `no ${kind} of ${symbol} for ${date}` };
      obs.push(o);
    }
    if (obs.length === 0) return { stage, status: "waiting", detail: "no universe" };
    const sources = [...new Set(obs.map((o) => o.source))].sort();
    let event = recorded;
    if (!event) {
      const valuesHash = await this.deps.values.putValue(Object.fromEntries(obs.map((o) => [o.symbol, o.price])));
      event = await this.append(stage, "system", { date, source: sources.join(","), fetchedAt: Math.max(...obs.map((o) => o.fetchedAt)), valuesHash });
    }
    const contentHash = pl(event).valuesHash;
    for (const source of sources) {
      if (this.find("source.captured", (p) => p.contentHash === contentHash && p.source === source)) continue;
      const mine = obs.filter((o) => o.source === source);
      await this.append("source.captured", "system", { source, publishedAt: Math.max(...mine.map((o) => o.publishedAt)), fetchedAt: Math.max(...mine.map((o) => o.fetchedAt)), contentHash });
    }
    return event;
  }

  /**
   * 判断の受け付けの時間（前の取引日の引けのあとから、date の締めの前まで）に、AIごとに入力を固定して agent.run を書き、
   * 投稿と注文票の確定を行う。受け付けの始まりより前なら待つ（保管が注文票を断るので、書く前に止める）。
   * 判断（出力）は、正規化した JSON をログの外に置き、outputHash で引き直せるようにする。run を書いた後に落ちたら、
   * 回し直しでは判断をやり直さず、記録した run の出力と入力から、欠けた投稿・注文票だけを補う。
   * 停止中のAIは、投稿を作らない（投稿の停止）・注文票は保管に渡して拒否（suspended）を残す（注文の停止）。
   * 判断が例外を投げたAIは、失敗の run（ok: false、provider_error）を残して次のAIへ進む（エラー文は残さない。EVENT_LOG §1）。
   * 出力が記録の形に直せないAI（NFC でない文字・U+0000・小数の株数など）も、失敗の run（invalid_output）を残して次へ進む。
   */
  async decide(date: string, prev: string): Promise<StageResult> {
    const stage = "decide";
    if (this.find("prices.open", (p) => p.date === date)) return { stage, status: "skipped", detail: "after the open" };
    if (this.deps.clock.now() < decisionOpensAt(date, this.log.holidays())) return { stage, status: "waiting", detail: `before the decision window of ${date}` };
    if (!this.pricesDone(prev)) return { stage, status: "waiting", detail: this.listedOnly() ? `auctions of ${prev} not done` : `no close of ${prev}` };
    // 取引対象がすべて上場した銘柄なら、終値は入力に入れない（切り替えの前の古い終値に、取引対象の外の銘柄が残るため）
    const closes = this.listedOnly() ? [] : this.log.events.filter((e) => e.type === "prices.close").slice(-(this.deps.inputDays ?? 20));
    let wrote = false;
    const late: string[] = [];
    const notReady: string[] = [];
    for (const agent of this.deps.agents.filter((a) => this.agentsOn(date).includes(a.id))) {
      const id = agent.id;
      const registered = this.find("agent.registered", (p) => p.agentId === id)!;
      const noPosts = this.suspended(id, "posts");
      // 前の日の引け後の処理が済むまで判断しない（古い口座で判断すると、注文票が account_not_ready で拒否されて戻せない）
      // 臨時休場の追加分（closedSeq つき）があれば、その最後の記録を基準にする（休場の日の run を拾わないように）
      const prevDone = this.log.events.filter((e) => e.type === "corporate_actions.applied" && pl(e).agentId === id && pl(e).asOf === prev).at(-1);
      // 投稿も注文も停止中のAIは、待たずに飛ばす（判断しないので、古い口座で判断するおそれがない）
      if ((pl(registered).startDate as string) < date && !prevDone) {
        if (!(noPosts && this.suspended(id, "orders"))) notReady.push(id);
        continue;
      }
      // この日の run：前の日の引け後の処理より後のもの（開始日なら、そのAIの run はこの日の分しかない）
      const runs = this.log.events.filter((e) => e.seq > (prevDone?.seq ?? 0) && e.type === "agent.run" && pl(e).agentId === id);
      if (runs.some((r) => pl(r).ok !== true)) continue; // 失敗を記録済み
      if (runs.length === 0 && noPosts && this.suspended(id, "orders")) continue;
      // 注文票まで済んでいれば、何もしない（締めのあとの回し直しで、間に合わなかったと数えないように。投稿は注文の判断の記録より前に済んでいる）
      const orderDone = runs.find((r) => pl(r).purpose === "order");
      if (orderDone && this.log.events.some((e) => (e.type === "order_sheet.committed" || e.type === "order_sheet.rejected") && pl(e).runSeq === orderDone.seq)) continue;
      if (this.deps.clock.now() >= cutoffOf(date)) {
        late.push(id);
        continue;
      }
      let decision: Decision;
      let inputSeqs: number[];
      /** 記録の形（正規化した JSON）にした出力。記録した run から作り直すときは、その本文 */
      let output: string;
      if (runs.length > 0) {
        // 判断は、注文用の run があればその出力（注文票が指すもの）。この日の run の出力がすべて同じでなければ止める
        // （毎日の実行は1つの判断から同じ出力を書くので、違えばほかの書き手が足した記録がある。#179 の verifier の低）
        // （出力は run ごとに別の乱数で置くので、ハッシュではなく全文で比べる）
        const source = orderDone ?? runs[0]!;
        const textOf = (r: LogEvent) => {
          const body = this.deps.values.body(pl(r).outputHash as string);
          if (!body) throw new Error(`output of run ${r.seq} is not available`);
          return body.value;
        };
        output = textOf(source);
        const other = runs.find((r) => textOf(r) !== output || canonicalize(pl(r).inputSeqs) !== canonicalize(pl(source).inputSeqs));
        // 運営者への案内：記録は消せないので、2つの run を確かめて lead に知らせる。その日の締めを過ぎてから回し直すと、このAIは間に合わなかった扱いで飛ばされ、ほかのAIは進む
        if (other)
          throw new Error(
            `run ${other.seq} does not match the decision of run ${source.seq} (output or inputs differ; another writer may have added records). ` +
              `Do not edit the log: check both agent.run records and report to lead. After the cutoff of ${date}, a rerun skips this AI as late and the other AIs go on`,
          );
        decision = JSON.parse(output) as Decision;
        inputSeqs = pl(source).inputSeqs as number[];
      } else {
        // 口座の根拠：最後の引け後の処理（まだなければ登録）
        const basis = this.log.events.filter((e) => e.type === "corporate_actions.applied" && pl(e).agentId === id).at(-1) ?? registered;
        // 分割を知っていたことを残す：列の間の分割の公表と、それを反映したそのAIの引け後の処理を入力に入れる
        const first = closes[0] ? (pl(closes[0]).date as string) : date;
        // 権利落ち日が休場になった公表は、どの引け後の処理にも渡らない（§6.2 で運営者が決める）ので、列も調整しない
        const H = this.log.holidays();
        const inRange = (exDate: string) => first < exDate && exDate <= date && isTradingDay(exDate, H);
        const splits = this.log.events.filter((e) => e.type === "corporate_action.announced" && pl(e).kind === "split" && inRange(pl(e).exDate as string)).map((e) => {
          const v = this.deps.values.get(pl(e).valuesHash as string)!.value as { from: number; to: number };
          return { seq: e.seq, symbol: pl(e).symbol as string, exDate: pl(e).exDate as string, from: v.from, to: v.to };
        });
        const applied = this.log.events.filter((e) => e.type === "corporate_actions.applied" && pl(e).agentId === id && inRange(pl(e).exDate as string) && (pl(e).announcedSeqs as number[]).some((s) => splits.some((x) => x.seq === s)));
        const listed = this.listedInputs(date);
        const listedSeqs = listed.flatMap((x) => [x.listing.seq, x.refPrice.seq, ...x.auctions.map((a) => a.seq), ...x.disclosures.map((q) => q.seq)]);
        const allotted = this.log.events.filter((e) => e.type === "shares.allotted" && pl(e).agentId === id);
        const shares: Record<string, number> = {};
        for (const e of allotted) shares[pl(e).symbol as string] = (shares[pl(e).symbol as string] ?? 0) + (pl(e).qty as number);
        const start = { cash: pl(registered).initialCash as Deciyen, shares };
        inputSeqs = [...new Set([...closes.map((e) => e.seq), ...splits.map((x) => x.seq), ...applied.map((e) => e.seq), basis.seq, ...listedSeqs, registered.seq, ...allotted.map((e) => e.seq)])];
        const raw = closes.map((e) => ({ seq: e.seq, date: pl(e).date as string, prices: this.deps.values.get(pl(e).valuesHash as string)!.value as CloseInput["prices"] }));
        const input = deepFreeze(structuredClone({ agentId: id, tradingDate: date, at: this.deps.clock.now(), closes: adjustCloses(raw, splits), splits, account: this.ledger.account(id), listed, start }));
        let d: Decision;
        try {
          d = await agent.decide(input);
        } catch {
          await this.run(agent, "order", date, inputSeqs, input.at, null, "provider_error");
          wrote = true;
          continue;
        }
        try {
          // 判断の記録を書く前に、出力の形（orders が配列・post が null か掲示板と本文が文字列・note が文字列）を確かめ、
          // 記録の形（正規化した JSON）に直す。NFC でない文字・U+0000・小数などは、ここで断る。注文の各要素の中身は、
          // 注文票の確定の検査が拒否の記録にする（形が違っても例外にしない）。投稿の掲示板と本文も、ここを通れば、
          // あとで本文を置くとき・投稿を記録するときに断られない。
          // 確定・投稿に使うのは、記録した出力を読み直したもの（回し直しのときと同じものにする）
          output = canonicalize(decisionOf(d));
          decision = JSON.parse(output) as Decision;
        } catch {
          await this.run(agent, "order", date, inputSeqs, input.at, null, "invalid_output");
          wrote = true;
          continue;
        }
      }
      const runSeq = async (purpose: "post" | "order") => {
        const recorded = runs.find((r) => pl(r).purpose === purpose);
        if (recorded) return recorded.seq;
        wrote = true;
        return this.run(agent, purpose, date, inputSeqs, this.deps.clock.now(), output);
      };
      if (decision.post && !noPosts) {
        const postRun = await runSeq("post");
        if (!this.find("post.published", (p) => p.runSeq === postRun)) {
          const bodyHash = await this.deps.values.putBody(decision.post.text);
          // 引用は終値だけ（口座の根拠は出典ではない）
          const citeSeqs = inputSeqs.filter((seq) => this.log.events[seq - 1]?.type === "prices.close");
          await this.append("post.published", `agent:${id}`, { agentId: id, board: decision.post.board, bodyHash, citeSeqs, runSeq: postRun }, [postRun, ...citeSeqs]);
          wrote = true;
        }
      }
      const orderRun = await runSeq("order");
      const sheetDone = this.log.events.some((e) => (e.type === "order_sheet.committed" || e.type === "order_sheet.rejected") && pl(e).runSeq === orderRun);
      // 売買しない日も空の注文票を確定する（締めより前に「売買しない」と決めたことを残す。約定は空の fills.executed）
      if (!sheetDone) {
        await this.sync(await this.deps.store.commitSheet(id, { tradingDate: date, orders: decision.orders, runSeq: orderRun, inputSeqs }), `commitSheet ${id}`);
        wrote = true;
      }
    }
    if (notReady.length > 0) return { stage, status: "waiting", detail: `post-close of ${prev} not done: ${notReady.join(",")}` };
    if (late.length > 0) return { stage, status: "skipped", detail: `after the cutoff: ${late.join(",")}` };
    return { stage, status: wrote ? "written" : "done" };
  }

  /** agent.run を書く。output が null なら失敗の run。リクエストのハッシュは、AIに渡したものの識別（入力の seq と約定日）から作る */
  private async run(agent: RunnerAgent, purpose: "post" | "order", tradingDate: string, inputSeqs: number[], startedAt: number, output: string | null, errorCode: "provider_error" | "invalid_output" = "provider_error"): Promise<number> {
    const requestHash = await sha256Hex(new TextEncoder().encode(canonicalize({ model: agent.model, prompt: agent.prompt, purpose, tradingDate, inputSeqs })));
    const base = { agentId: agent.id, purpose, model: agent.model, prompt: agent.prompt, inputSeqs, requestHash, startedAt, finishedAt: this.deps.clock.now() };
    const payload = output === null ? { ...base, ok: false, errorCode } : { ...base, outputHash: await this.deps.values.putBody(output), ok: true };
    return (await this.append("agent.run", "system", payload, inputSeqs)).seq;
  }

  /**
   * upTo までで、終値か引け後の処理が済んでいない日を、古い順に進める（始値の約定 → 引け後）。待った日で止める。
   * 1日ずつ前にさかのぼり、済んでいる日（またはAIの登録より前の日）で止める（データが2日以上遅れても追いつける）
   */
  async catchUp(upTo: string): Promise<StageResult[]> {
    const H = this.log.holidays();
    const days: string[] = [];
    for (let d = upTo; ; d = previousTradingDay(d, H)) {
      const agents = this.agentsOn(d);
      const done = this.pricesDone(d) && agents.every((id) => this.find("corporate_actions.applied", (p) => p.agentId === id && p.asOf === d && p.closedSeq === undefined));
      if (done) break;
      days.unshift(d);
      if (agents.length === 0) break;
    }
    const out: StageResult[] = [];
    for (const d of days) {
      out.push(await this.open(d));
      if (out.at(-1)!.status === "waiting") break;
      out.push(await this.afterClose(d));
      if (out.at(-1)!.status === "waiting") break;
    }
    return out;
  }

  /**
   * 締めのあと、上場した銘柄ごとに板寄せの結果（auction.cleared）を書き、上場していない銘柄の始値を取り込んで、
   * 確定した注文票を約定させる。上場した銘柄の注文は板寄せの結果で、ほかの銘柄の注文は始値で約定する（MARKET_DESIGN §3）
   */
  async open(date: string): Promise<StageResult> {
    if (this.deps.clock.now() < cutoffOf(date)) return { stage: "open", status: "waiting", detail: "before the cutoff" };
    const listed = this.listings();
    const sheets = this.log.events.filter((e) => e.type === "order_sheet.committed" && pl(e).tradingDate === date);
    // 板寄せの日付は戻せない（後の日を先に書くと、前の日をもう書けない）。前の取引日の板寄せがそろうまで待つ
    // （回し忘れた日があり、追いつきが前の日で止まっているとき）
    const prev = previousTradingDay(date, this.log.holidays());
    const behind = this.universe().filter((x) => listed.has(x) && cutoffOf(prev) > listed.get(x)! && !this.find("auction.cleared", (p) => p.symbol === x && p.date === prev));
    if (behind.length > 0) return { stage: "open", status: "waiting", detail: `auctions of ${prev} not done: ${behind.join(",")}` };
    let wrote = false;
    // 板寄せには、その日の全員の注文票を渡す（締めのあとなので、もう増えない）。銘柄コードの順に書く
    // 臨時休場の日は板寄せをしない（休場の扱いは #27 の判断待ち）
    const closed = this.find("market.closed", (p) => p.date === date) !== undefined;
    for (const symbol of this.universe().filter((x) => listed.has(x))) {
      // 締めのあとに上場した銘柄は、その日の板寄せがない
      if (closed || cutoffOf(date) <= listed.get(symbol)! || this.find("auction.cleared", (p) => p.symbol === symbol && p.date === date)) continue;
      const sheetSeqs = sheets.map((e) => e.seq);
      const { payload } = this.ledger.computeAuction(symbol, date, sheetSeqs);
      await this.append("auction.cleared", "system", { symbol, date, ...payload, sheetSeqs }, [payload.refSeq, ...sheetSeqs]);
      wrote = true;
    }
    let openSeq: number | undefined;
    if (this.universe().some((x) => !listed.has(x))) {
      const open = await this.ingest(date, "open");
      if (!("seq" in open)) return open;
      openSeq = open.seq;
    }
    for (const sheet of sheets) {
      const agentId = pl(sheet).agentId as string;
      if (this.find("fills.executed", (p) => p.agentId === agentId && p.tradingDate === date)) continue;
      const symbols = new Set((pl(sheet).orders as Order[]).map((o) => o.symbol).filter((x) => listed.has(x)));
      const auctionSeqs = this.log.events.filter((e) => e.type === "auction.cleared" && pl(e).date === date && symbols.has(pl(e).symbol as string)).map((e) => e.seq);
      const f = await this.ledger.computeFills(agentId, sheet.seq, openSeq, auctionSeqs);
      const refs = [sheet.seq, ...(openSeq === undefined ? [] : [openSeq]), ...auctionSeqs];
      await this.append("fills.executed", "system", { agentId, tradingDate: date, sheetSeq: sheet.seq, ...(openSeq === undefined ? {} : { openSeq }), ...(auctionSeqs.length > 0 ? { auctionSeqs } : {}), ...f.payload }, refs);
      wrote = true;
    }
    return { stage: "open", status: wrote ? "written" : "done" };
  }

  /**
   * 終値を取り込み、AIごとに評価と引け後の処理。引け後の処理には、権利落ち日が次の取引日の企業行動の公表をすべて
   * （seq の昇順で）渡し、分割・配当を反映する（EVENT_LOG §3.3）。約定待ちの注文票があれば待つ
   */
  async afterClose(date: string): Promise<StageResult> {
    const stage = "after_close";
    const unfilled = this.log.events.filter((e) => e.type === "order_sheet.committed" && (pl(e).tradingDate as string) <= date && !this.find("fills.executed", (p) => p.sheetSeq === e.seq));
    if (unfilled.length > 0) return { stage, status: "waiting", detail: `sheets not filled: ${unfilled.map((e) => e.seq).join(",")}` };
    // 取引対象がすべて上場した銘柄なら、終値を取り込まず、その日の板寄せの価格で評価する
    let closeSeq: number | undefined;
    if (this.listedOnly()) {
      if (!this.auctionsDone(date)) return { stage, status: "waiting", detail: `auctions of ${date} not done` };
    } else {
      const close = await this.ingest(date, "close");
      if (!("seq" in close)) return close;
      closeSeq = close.seq;
    }
    const auctionSeqs = this.log.events.filter((e) => e.type === "auction.cleared" && pl(e).date === date).map((e) => e.seq);
    const exDate = nextTradingDay(date, this.log.holidays());
    // 前の日の引け後の処理が済んでいないAIがいれば、この日の評価もできない（順に1日ずつ進む）
    const prev = previousTradingDay(date, this.log.holidays());
    const behind = this.agentsOn(prev).filter((id) => !this.find("corporate_actions.applied", (p) => p.agentId === id && p.asOf === prev));
    if (behind.length > 0) return { stage, status: "waiting", detail: `post-close of ${prev} not done: ${behind.join(",")}` };
    // 公表は、どのAIもこの日の引け後の処理を済ませる前にしか書けない（#67）ので、ここで読んだものがすべて
    const announcedSeqs = this.log.events.filter((e) => e.type === "corporate_action.announced" && pl(e).exDate === exDate).map((e) => e.seq);
    let wrote = false;
    for (const agentId of this.agentsOn(date)) {
      if (!this.find("valuation.recorded", (p) => p.agentId === agentId && p.date === date)) {
        const basis = closeSeq === undefined ? { payload: {}, refs: auctionSeqs } : { payload: { closeSeq }, refs: [closeSeq] };
        await this.append("valuation.recorded", "system", { agentId, date, ...basis.payload, ...this.ledger.computeValuation(agentId, date) }, basis.refs);
        wrote = true;
      }
      if (!this.find("corporate_actions.applied", (p) => p.agentId === agentId && p.asOf === date && p.closedSeq === undefined)) {
        const ca = await this.ledger.computeCorporate(agentId, date, exDate, announcedSeqs);
        await this.append("corporate_actions.applied", "system", { agentId, asOf: date, exDate, announcedSeqs, ...ca.payload }, announcedSeqs);
        wrote = true;
      }
    }
    return { stage, status: wrote ? "written" : "done" };
  }
}
