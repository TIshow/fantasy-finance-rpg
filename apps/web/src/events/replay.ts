// ログからの台帳の再計算と照合（docs/EVENT_LOG.md §7）。
// 約定・分割配当・評価の中身を作る関数（compute*）と、記録を照合する関数（replay）は同じ計算を使う。
// 価格と分割・配当の内容はログの外にあり（§5.2）、ValueStore から受け取ってハッシュを確かめる。
import { applyCorporateActions, type Dividend, type Split } from "../ledger/corporate";
import { executeSheet, newAccount, totalValue } from "../ledger/ledger";
import { INITIAL_CASH, type Account, type Deciyen, type Fill, type Order } from "../ledger/types";
import { EventLog, type AppendContext } from "./append";
import { canonicalize } from "./canonical";
import { accountHash, bodyHash } from "./hash";
import type { LogEvent } from "./types";

/** ログの外の値。キーは値のハッシュ（イベントの valuesHash） */
export interface ValueStore {
  get(hash: string): { salt: Uint8Array; value: unknown } | undefined;
}

type Prices = Readonly<Record<string, Deciyen | null>>;
type Announcement = { kind: "split"; from: number; to: number } | { kind: "dividend"; perShare: Deciyen };
type Payload = Record<string, unknown>;
/** 台帳に当てる（または当てられるかを確かめる）イベント */
type Candidate = Pick<LogEvent, "seq" | "type" | "payload">;

interface LatestClose {
  price: Deciyen;
  seq: number;
  date: string;
}

export interface Position {
  symbol: string;
  qty: number;
  price: Deciyen;
  /** 評価に使った終値の prices.close の seq（直近の終値を使えば、評価日より前の日） */
  closeSeq: number;
}

export class Ledger {
  private readonly accounts = new Map<string, Account>();
  private readonly byseq: LogEvent[] = [];
  /** 銘柄ごとの終値の履歴（記録の順） */
  private readonly closeHistory = new Map<string, LatestClose[]>();
  /** 日付ごとの終値（その日の値に銘柄の項目があるかを見るため） */
  private readonly closesByDate = new Map<string, Prices>();
  /** AIごと・銘柄ごとの、反映した分割の権利落ち日 */
  private readonly splitsApplied = new Map<string, Map<string, string[]>>();
  /** 再計算に一度失敗したら、それ以降は受け付けない（途中から進めると口座がずれるため） */
  private failed: string | null = null;

  constructor(private readonly store: ValueStore) {}

  /** 口座の写し（書き換えても台帳は変わらない） */
  account(agentId: string): Account {
    if (this.failed) throw new Error(`ledger stopped at ${this.failed}`);
    const a = this.accounts.get(agentId);
    if (!a) throw new Error(`unknown agent ${agentId}`);
    return { cash: a.cash, holdings: Object.fromEntries(Object.entries(a.holdings).map(([k, h]) => [k, { ...h }])) };
  }

  /** 約定の中身。sheetSeq は order_sheet.committed、openSeq は prices.open（臨時休場なら undefined） */
  async computeFills(agentId: string, sheetSeq: number, openSeq: number | undefined) {
    const sheet = this.payloadOf(sheetSeq, "order_sheet.committed");
    if (sheet.agentId !== agentId) throw new Error(`seq ${sheetSeq} is not a sheet of ${agentId}`);
    const orders = sheet.orders as Order[];
    const before = this.account(agentId);
    let account: Account;
    let fills: Fill[];
    if (openSeq === undefined) {
      // 臨時休場：全件失効（売り→買いの並びは executeSheet と同じ）
      account = before;
      fills = [...orders.filter((o) => o.side === "sell"), ...orders.filter((o) => o.side === "buy")].map((o) => ({ symbol: o.symbol, side: o.side, requestedQty: o.qty, qty: 0, price: null, amount: 0, status: "expired", reason: "market_closed" }));
    } else {
      if (this.payloadOf(openSeq, "prices.open").date !== sheet.tradingDate) throw new Error(`seq ${openSeq} is not the open of ${String(sheet.tradingDate)}`);
      const opens = (await this.valuesOf(openSeq, "prices.open")) as Prices;
      ({ account, fills } = executeSheet(before, { agentId, tradingDate: sheet.tradingDate as string, committedAt: this.byseq[sheetSeq - 1]!.recordedAt, orders }, opens));
    }
    return { account, payload: { fills, accountHash: await accountHash(account) } };
  }

  /** 分割・配当の反映の中身。公表は §3.3 の決め方（権利落ち日が exDate、seq の昇順）で渡す */
  async computeCorporate(agentId: string, asOf: string, exDate: string, announcedSeqs: readonly number[]) {
    const splits: Split[] = [];
    const dividends: Dividend[] = [];
    for (const s of announcedSeqs) {
      const p = this.payloadOf(s, "corporate_action.announced");
      if (p.exDate !== exDate) throw new Error(`seq ${s} is not an announcement with exDate ${exDate}`);
      const v = (await this.valuesOf(s, "corporate_action.announced")) as Announcement;
      if (v.kind === "split") splits.push({ symbol: p.symbol as string, exDate, from: v.from, to: v.to });
      else dividends.push({ symbol: p.symbol as string, exDate, perShare: v.perShare });
    }
    // 端数の換金に使う終値は、その銘柄の直近の終値（§3.3）
    const closes: Record<string, Deciyen> = {};
    const closeSeqs: Record<string, number> = {};
    for (const s of splits) {
      const c = this.closeOn(s.symbol, asOf);
      if (c && this.account(agentId).holdings[s.symbol]) this.guardStale(agentId, s.symbol, c, asOf);
      if (c) {
        closes[s.symbol] = c.price;
        closeSeqs[s.symbol] = c.seq;
      }
    }
    const { account, events } = applyCorporateActions(this.account(agentId), exDate, { splits, dividends }, closes);
    const actions = events.map((e) => (e.kind === "split" && e.close !== null ? { ...e, closeSeq: closeSeqs[e.symbol]! } : e));
    return { account, splitSymbols: splits.map((s) => s.symbol), payload: { actions, accountHash: await accountHash(account) } };
  }

  /** 評価の中身。各銘柄は、その日までの直近の終値で評価する（§6） */
  computeValuation(agentId: string, date: string) {
    const account = this.account(agentId);
    const positions: Position[] = [];
    const today = this.closesByDate.get(date);
    const prices: Record<string, Deciyen> = {};
    for (const symbol of Object.keys(account.holdings).sort()) {
      const c = this.closeOn(symbol, date);
      if (!c) throw new Error(`no close price for ${symbol} up to ${date}`);
      // その日の終値の値には、保有銘柄の項目が（値がなくても null で）あること（§3.1）
      if (today && !Object.hasOwn(today, symbol)) throw new Error(`close prices of ${date} do not list ${symbol}`);
      this.guardStale(agentId, symbol, c, date);
      prices[symbol] = c.price;
      positions.push({ symbol, qty: account.holdings[symbol]!.qty, price: c.price, closeSeq: c.seq });
    }
    return { cash: account.cash, positions, total: totalValue(account, prices) };
  }

  /**
   * 1件を再計算して記録と照合し、口座を進める。食い違えば例外。
   * 追記の処理（append.ts）が順序と参照を確かめたログを、先頭から順に渡す
   */
  async apply(e: LogEvent): Promise<void> {
    if (this.failed) throw new Error(`ledger stopped at ${this.failed}`);
    if (e.seq !== this.byseq.length + 1) throw new Error(`seq ${e.seq} out of order`);
    try {
      const commit = await this.evaluate(e);
      // 呼び出し側は1件ずつ当てる。待つあいだに別の apply が進んでいたら、台帳がずれるので止める
      if (e.seq !== this.byseq.length + 1) throw new Error(`seq ${e.seq} was applied concurrently`);
      this.byseq.push(e);
      commit();
    } catch (err) {
      this.failed = `seq ${e.seq}`;
      throw err;
    }
  }

  /**
   * 次の seq に、このイベントを当てられるか。状態は変えない。断るなら理由を返す（apply なら例外になるもの）。
   * apply と同じ evaluate を通すので、check が通れば apply も通り、check が断れば apply も断る。
   * 保管は書く前にこれを呼び、台帳が断るイベントを追記だけのログに残さない。
   * この保証は、check・書き込み・apply を同じ直列の区間で行い、そのあいだに別のイベントを当てないときだけ成り立つ。
   * ログの外の値は、check の前に ValueStore に置いておく
   */
  async check(d: { type: LogEvent["type"]; payload: unknown }): Promise<string | null> {
    if (this.failed) return `ledger stopped at ${this.failed}`;
    try {
      await this.evaluate({ seq: this.byseq.length + 1, type: d.type, payload: d.payload });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** 1件を再計算して記録と照合する。状態は変えず、当てるための変更を返す。食い違えば例外 */
  private async evaluate(e: Candidate): Promise<() => void> {
    const p = e.payload as Payload;
    const at = `seq ${e.seq} (${e.type})`;
    const none = () => {};
    switch (e.type) {
      case "agent.registered":
        if (p.initialCash !== INITIAL_CASH) throw new Error(`${at}: initialCash must be INITIAL_CASH`);
        return () => this.accounts.set(p.agentId as string, newAccount());
      case "prices.open":
        // 値はいま確かめる（約定まで待つと、その日の約定が全員止まる）
        await this.valuesOf(e.seq, "prices.open", e);
        return none;
      case "prices.close": {
        const closes = (await this.valuesOf(e.seq, "prices.close", e)) as Prices;
        return () => {
          this.closesByDate.set(p.date as string, closes);
          for (const [symbol, price] of Object.entries(closes)) {
            if (price === null) continue;
            const list = this.closeHistory.get(symbol) ?? [];
            list.push({ price, seq: e.seq, date: p.date as string });
            this.closeHistory.set(symbol, list);
          }
        };
      }
      case "corporate_action.announced":
        // 値と種類をいま確かめる（引け後処理まで待つと、その権利落ち日の引け後処理が全員止まる）
        await this.valuesOf(e.seq, "corporate_action.announced", e);
        return none;
      case "fills.executed": {
        const r = await this.computeFills(p.agentId as string, p.sheetSeq as number, p.openSeq as number | undefined);
        same(at, { fills: p.fills, accountHash: p.accountHash }, r.payload);
        return () => this.accounts.set(p.agentId as string, r.account);
      }
      case "corporate_actions.applied": {
        const r = await this.computeCorporate(p.agentId as string, p.asOf as string, p.exDate as string, p.announcedSeqs as number[]);
        same(at, { actions: p.actions, accountHash: p.accountHash }, r.payload);
        return () => {
          this.accounts.set(p.agentId as string, r.account);
          const mine = this.splitsApplied.get(p.agentId as string) ?? new Map<string, string[]>();
          for (const s of r.splitSymbols) mine.set(s, [...(mine.get(s) ?? []), p.exDate as string]);
          this.splitsApplied.set(p.agentId as string, mine);
        };
      }
      case "valuation.recorded":
        same(at, { cash: p.cash, positions: p.positions, total: p.total }, this.computeValuation(p.agentId as string, p.date as string));
        return none;
      default:
        return none;
    }
  }

  /**
   * 分割より前の終値で、分割後の株数を評価しない。このAIが反映した分割のうち、終値の日より後・date 以前の権利落ち日があれば止める
   * （分割に合わせた価格の規則、PAPER_TRADING_RULES §6 を実装するまで）
   */
  private guardStale(agentId: string, symbol: string, c: LatestClose, date: string): void {
    for (const ex of this.splitsApplied.get(agentId)?.get(symbol) ?? []) {
      if (c.date < ex && ex <= date) throw new Error(`latest close of ${symbol} is before its split on ${ex}`);
    }
  }

  /** date までの直近の終値。翌日以降の終値が先に記録されていても使わない */
  private closeOn(symbol: string, date: string): LatestClose | undefined {
    const list = this.closeHistory.get(symbol) ?? [];
    let best: LatestClose | undefined;
    for (const c of list) if (c.date <= date && (!best || c.date >= best.date)) best = c;
    return best;
  }

  /** seq のイベントの中身。self は、まだ当てていない（evaluate 中の）イベント */
  private payloadOf(seq: number, type: LogEvent["type"], self?: Candidate): Payload {
    const e = self?.seq === seq ? self : this.byseq[seq - 1];
    if (e?.type !== type) throw new Error(`seq ${seq} is not ${type}`);
    return e.payload as Payload;
  }

  /** ログの外の値を受け取り、イベントに書いたハッシュと合うかを確かめる */
  private async valuesOf(seq: number, type: LogEvent["type"], self?: Candidate): Promise<unknown> {
    const hash = this.payloadOf(seq, type, self).valuesHash;
    if (typeof hash !== "string") throw new Error(`seq ${seq}: valuesHash is missing`);
    const v = this.store.get(hash);
    if (!v) throw new Error(`seq ${seq}: values are not available`);
    if ((await bodyHash(v.salt, { value: v.value })) !== hash) throw new Error(`seq ${seq}: values do not match valuesHash`);
    if (type === "corporate_action.announced") {
      const problem = announcementValueProblem(this.payloadOf(seq, type, self), v.value);
      if (problem) throw new Error(`seq ${seq}: ${problem}`);
    } else if (!isPrices(v.value)) throw new Error(`seq ${seq}: values have the wrong shape for ${type}`);
    return v.value;
  }
}

/**
 * 公表のログの外の値が、形どおりで、イベントの種類（kind）と同じか。違えば理由。
 * 台帳は公表を当てるときにこれで止まる。書く前の検査（保管の側）でも同じものを使う
 */
export function announcementValueProblem(payload: Readonly<Record<string, unknown>>, value: unknown): string | null {
  if (!isAnnouncement(value)) return "values have the wrong shape for corporate_action.announced";
  const kind = (value as { kind: string }).kind;
  return kind === payload.kind ? null : `announced kind ${String(payload.kind)} does not match the values (${kind})`;
}

/** 記録と再計算を、正規化した JSON で比べる */
function same(at: string, recorded: unknown, computed: unknown): void {
  if (canonicalize(recorded) !== canonicalize(computed)) throw new Error(`${at}: recorded ${canonicalize(recorded)} but recomputed ${canonicalize(computed)}`);
}

const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

function isPrices(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((x) => x === null || posInt(x));
}

function isAnnouncement(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  if (a.kind === "split") return posInt(a.from) && posInt(a.to);
  return a.kind === "dividend" && typeof a.perShare === "number" && Number.isSafeInteger(a.perShare) && a.perShare >= 0;
}

/**
 * 保存済みのログ全体を先頭から確かめ、AIごとの口座を返す。食い違えば例外。
 * 各イベントは、追記のときと同じ検査（EventLog.admit：順序・参照・一意キー・連鎖・注文票の validateSheet）を通してから台帳に当てる
 */
export async function replay(events: readonly LogEvent[], store: ValueStore, ctx: Omit<AppendContext, "accountOf">): Promise<Ledger> {
  const ledger = new Ledger(store);
  const log = new EventLog({ ...ctx, accountOf: (id) => ledger.account(id) });
  for (const e of events) {
    const problem = await log.admit(e);
    if (problem) throw new Error(problem);
    await ledger.apply(e);
  }
  return ledger;
}
