// ログからの台帳の再計算と照合（docs/EVENT_LOG.md §7）。
// 約定・分割配当・評価の中身を作る関数（compute*）と、記録を照合する関数（replay）は同じ計算を使う。
// 価格と分割・配当の内容はログの外にあり（§5.2）、ValueStore から受け取ってハッシュを確かめる。
import { applyCorporateActions, type Dividend, type Split } from "../ledger/corporate";
import { executeSheet, newAccount, totalValue } from "../ledger/ledger";
import { INITIAL_CASH, type Account, type Deciyen, type Fill, type Order } from "../ledger/types";
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
  /** 銘柄ごとの、最後に分割を反映した権利落ち日 */
  private readonly lastSplit = new Map<string, string>();

  constructor(private readonly store: ValueStore) {}

  account(agentId: string): Account {
    const a = this.accounts.get(agentId);
    if (!a) throw new Error(`unknown agent ${agentId}`);
    return a;
  }

  /** 約定の中身。sheetSeq は order_sheet.committed、openSeq は prices.open（臨時休場なら undefined） */
  async computeFills(agentId: string, sheetSeq: number, openSeq: number | undefined) {
    const sheet = this.payloadOf(sheetSeq, "order_sheet.committed");
    const orders = sheet.orders as Order[];
    const before = this.account(agentId);
    let account: Account;
    let fills: Fill[];
    if (openSeq === undefined) {
      // 臨時休場：全件失効（売り→買いの並びは executeSheet と同じ）
      account = before;
      fills = [...orders.filter((o) => o.side === "sell"), ...orders.filter((o) => o.side === "buy")].map((o) => ({ symbol: o.symbol, side: o.side, requestedQty: o.qty, qty: 0, price: null, amount: 0, status: "expired", reason: "market_closed" }));
    } else {
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
      const v = (await this.valuesOf(s, "corporate_action.announced")) as Announcement;
      if (v.kind === "split") splits.push({ symbol: p.symbol as string, exDate, from: v.from, to: v.to });
      else dividends.push({ symbol: p.symbol as string, exDate, perShare: v.perShare });
    }
    // 端数の換金に使う終値は、その銘柄の直近の終値（§3.3）
    const closes: Record<string, Deciyen> = {};
    const closeSeqs: Record<string, number> = {};
    for (const s of splits) {
      const c = this.closeOn(s.symbol, asOf);
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
    const prices: Record<string, Deciyen> = {};
    for (const symbol of Object.keys(account.holdings).sort()) {
      const c = this.closeOn(symbol, date);
      if (!c) throw new Error(`no close price for ${symbol} up to ${date}`);
      // 分割より前の終値で、分割後の株数を評価しない。直近の終値が分割前なら、調整の規則（PAPER_TRADING_RULES §6）を実装するまで止める
      const split = this.lastSplit.get(symbol);
      if (split !== undefined && c.date < split) throw new Error(`latest close of ${symbol} is before its split on ${split}`);
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
    if (e.seq !== this.byseq.length + 1) throw new Error(`seq ${e.seq} out of order`);
    this.byseq.push(e);
    const p = e.payload as Payload;
    const at = `seq ${e.seq} (${e.type})`;
    switch (e.type) {
      case "agent.registered":
        if (p.initialCash !== INITIAL_CASH) throw new Error(`${at}: initialCash must be INITIAL_CASH`);
        this.accounts.set(p.agentId as string, newAccount());
        break;
      case "prices.close": {
        const closes = (await this.valuesOf(e.seq, "prices.close")) as Prices;
        for (const [symbol, price] of Object.entries(closes)) {
          if (price === null) continue;
          const list = this.closeHistory.get(symbol) ?? [];
          list.push({ price, seq: e.seq, date: p.date as string });
          this.closeHistory.set(symbol, list);
        }
        break;
      }
      case "fills.executed": {
        const r = await this.computeFills(p.agentId as string, p.sheetSeq as number, p.openSeq as number | undefined);
        same(at, { fills: p.fills, accountHash: p.accountHash }, r.payload);
        this.accounts.set(p.agentId as string, r.account);
        break;
      }
      case "corporate_actions.applied": {
        const r = await this.computeCorporate(p.agentId as string, p.asOf as string, p.exDate as string, p.announcedSeqs as number[]);
        same(at, { actions: p.actions, accountHash: p.accountHash }, r.payload);
        this.accounts.set(p.agentId as string, r.account);
        for (const s of r.splitSymbols) this.lastSplit.set(s, p.exDate as string);
        break;
      }
      case "valuation.recorded":
        same(at, { cash: p.cash, positions: p.positions, total: p.total }, this.computeValuation(p.agentId as string, p.date as string));
        break;
    }
  }

  /** date までの直近の終値。翌日以降の終値が先に記録されていても使わない */
  private closeOn(symbol: string, date: string): LatestClose | undefined {
    const list = this.closeHistory.get(symbol) ?? [];
    let best: LatestClose | undefined;
    for (const c of list) if (c.date <= date && (!best || c.date >= best.date)) best = c;
    return best;
  }

  private payloadOf(seq: number, type: LogEvent["type"]): Payload {
    const e = this.byseq[seq - 1];
    if (e?.type !== type) throw new Error(`seq ${seq} is not ${type}`);
    return e.payload as Payload;
  }

  /** ログの外の値を受け取り、イベントに書いたハッシュと合うかを確かめる */
  private async valuesOf(seq: number, type: LogEvent["type"]): Promise<unknown> {
    const hash = this.payloadOf(seq, type).valuesHash;
    if (typeof hash !== "string") throw new Error(`seq ${seq}: valuesHash is missing`);
    const v = this.store.get(hash);
    if (!v) throw new Error(`seq ${seq}: values are not available`);
    if ((await bodyHash(v.salt, { value: v.value })) !== hash) throw new Error(`seq ${seq}: values do not match valuesHash`);
    return v.value;
  }
}

/** 記録と再計算を、正規化した JSON で比べる */
function same(at: string, recorded: unknown, computed: unknown): void {
  if (canonicalize(recorded) !== canonicalize(computed)) throw new Error(`${at}: recorded ${canonicalize(recorded)} but recomputed ${canonicalize(computed)}`);
}

/** ログ全体を先頭から再計算し、AIごとの口座を返す。食い違えば例外 */
export async function replay(events: readonly LogEvent[], store: ValueStore): Promise<Ledger> {
  const ledger = new Ledger(store);
  for (const e of events) await ledger.apply(e);
  return ledger;
}
