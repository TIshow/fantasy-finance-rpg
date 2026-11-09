// 検証（verifier、大枠 #157 の通しの確認）：本番と同じ入口（scripts/daily-lib.ts の productionSetup と runDaily）で、
// PGlite（Node の中で動く Postgres）に20営業日分の記録を作る。画面のデータの出どころ（src/app/data.ts）を、
// DATABASE_URL ありの道で動かし（接続を開く pgDbFromEnv だけを PGlite に差し替える。読むだけの口 readSnapshotFromEnv は本物）、
// 画面に出る数字が、画面とは別の道で計算した値と一致することを確かめる。別の道は2つ：
// - 記録だけから作り直した台帳（replay）
// - 台帳も画面も使わずに、記録の約定・上場・板寄せから、この試験の中で足し引きした口座と評価額（以下「手計算」）
// 確かめる画面：トップ（buildArena）、AIのページ（ページの関数 AgentPage が組み立てる中身）、銘柄のページ（値段の推移・出来高・持っているAI）、
// AIの一覧（/agents と、AIのページを作る generateStaticParams）。マーケットメイカーなどの売買役が、AI の一覧に出ないこと。
// 20営業日の記録は1回だけ作り、すべての確かめで使い回す。
import type { PGlite } from "@electric-sql/pglite";
import type { ReactElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SqlDb } from "../../src/store/sql";

const conn = vi.hoisted(() => ({ db: undefined as SqlDb | undefined, opened: [] as (string | undefined)[] }));
// 接続を開く関数だけを差し替える。読むだけの口（pg-reader.ts）の読み方・照合・閉じ方は本物のまま通る
vi.mock("../../src/store/pg-db", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/store/pg-db")>();
  return {
    ...m,
    pgDbFromEnv: (env: Readonly<Record<string, string | undefined>>) => {
      conn.opened.push(env.DATABASE_URL);
      if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
      // 口は読み終えたら閉じるので、閉じるのは何もしない形にして、PGlite を使い回す
      return { ...conn.db!, close: async () => undefined };
    },
  };
});

import { getAccounts, getView, loadSource } from "../../src/app/data";
import AgentPage, { generateStaticParams as agentParams } from "../../src/app/agents/[id]/page";
import { generateStaticParams as symbolParams } from "../../src/app/symbols/[symbol]/page";
import { MAX_DAYS } from "../../src/components/SymbolPageView";
import { replay, type Ledger } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { holidayTable } from "../../src/holidays";
import type { Account } from "../../src/ledger/types";
import { COMPANIES } from "../../src/runner/world/companies";
import { readAllEvents } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate } from "../../src/store/sql";
import { buildAgentPage, type AgentPage as AgentPageModel } from "../../src/view/agent-page";
import { buildArena } from "../../src/view/arena";
import { buildBoard } from "../../src/view/board";
import { characterOf } from "../../src/view/characters";
import { priceChart } from "../../src/view/market-chart";
import type { View } from "../../src/view/types";
import { formatYenMark } from "../../src/view/format";
import { productionSetup, runDaily, verifyDatabase } from "../../scripts/daily-lib";
import { FakeClock, jst } from "../contracts/fakes";
import { openPglite, resetSchema } from "../store/pglite";

const URL_FOR_TEST = "postgres://reader@pglite.invalid/ffr";
/** 2026-11-02（月）から 2026-11-24（火）まで、20取引日。11/9 からは土日・祝日も取引日なので、除くのは 11/3 と 11/7・11/8 だけ（D-047。tests/store/twenty-days.test.ts と同じ） */
const FIRST = "2026-11-02";
const LAST = "2026-11-24";
const SYMBOLS = COMPANIES.map((c) => c.symbol);

const p = (e: LogEvent) => e.payload as Record<string, any>;
const jstDate = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

/** 画面の金額の文字（"¥12,345.6"・"-¥1,000"・"+¥207,600"・"▲ +¥5"・"12,345.6円"・"+1,000円"）を、0.1円単位の整数に戻す。画面の整形の関数は使わない */
function yen(text: string | null | undefined): number {
  const m = /([+-]?)¥([\d,]+)(?:\.(\d))?/.exec(text ?? "") ?? /([+-]?)([\d,]+)(?:\.(\d))?円/.exec(text ?? "");
  if (!m) throw new Error(`not a yen text: ${String(text)}`);
  const v = Number(m[2]!.replaceAll(",", "")) * 10 + Number(m[3] ?? 0);
  return m[1] === "-" ? -v : v;
}

interface Hand {
  cash: number;
  holdings: Record<string, { qty: number; cost: number }>;
}
interface HandDay {
  date: string;
  cash: number;
  qty: Record<string, number>;
  total: number;
}

/**
 * 手計算：台帳（src/ledger・src/events）を使わずに、記録を seq の順にたどって口座を足し引きする。
 * 現金は登録の initialCash から、約定は「値段 × 株数」（記録の amount は使わない）で、同じ約定の記録の中では売りを先に。
 * 取得原価は平均法（全部売れば原価も全部減らし、一部なら原価 × 売った株数 ÷ 持っていた株数を四捨五入）。配分の株は上場の値段 × 株数。
 * 評価額は、評価の記録の時点の手計算の現金と株数に、その日以前の直近の値段（上場の値段・値段のついた板寄せ）を掛けたもの
 */
function handCompute(events: readonly LogEvent[]) {
  const kinds = new Map<string, string>();
  const initial = new Map<string, number>();
  const acc = new Map<string, Hand>();
  const listed = new Map<string, number>();
  const prices = new Map<string, { date: string; price: number }[]>();
  const days = new Map<string, HandDay[]>();
  const fills = new Map<string, { seq: number; idx: number; tradingDate: string; sheetSeq: number; symbol: string; side: string; qty: number; requestedQty: number; price: number | null }[]>();
  /** 銘柄・日ごとの、すべての参加者の約定（買いの株数の合計と、約定した値段の集合） */
  const traded = new Map<string, { buyQty: number; sellQty: number; prices: Set<number> }>();
  const lastPriced = (symbol: string, date: string) => {
    const last = (prices.get(symbol) ?? []).filter((x) => x.date <= date).at(-1);
    if (!last) throw new Error(`no price for ${symbol} on ${date}`);
    return last;
  };
  const priceOn = (symbol: string, date: string) => lastPriced(symbol, date).price;
  /** その日の値段がなく、前の日の値段で評価した（PAPER_TRADING_RULES §6「直近の終値で評価し、その旨を表示する」） */
  const staleOn = (symbol: string, date: string) => lastPriced(symbol, date).date < date;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const x = p(e);
    switch (e.type) {
      case "agent.registered":
        kinds.set(x.agentId, x.kind ?? "investor");
        initial.set(x.agentId, x.initialCash);
        acc.set(x.agentId, { cash: x.initialCash, holdings: {} });
        break;
      case "company.listed":
        listed.set(x.symbol, x.price);
        prices.set(x.symbol, [{ date: jstDate(e.recordedAt), price: x.price }]);
        break;
      case "shares.allotted": {
        const h = acc.get(x.agentId)!.holdings;
        const cur = h[x.symbol] ?? { qty: 0, cost: 0 };
        h[x.symbol] = { qty: cur.qty + x.qty, cost: cur.cost + listed.get(x.symbol)! * x.qty };
        break;
      }
      case "auction.cleared":
        if (x.price !== null) prices.get(x.symbol)!.push({ date: x.date, price: x.price });
        break;
      case "fills.executed": {
        const a = acc.get(x.agentId)!;
        const list = (x.fills as any[]).map((f, idx) => ({ ...f, idx }));
        for (const f of list) {
          (fills.get(x.agentId) ?? fills.set(x.agentId, []).get(x.agentId)!).push({ seq: e.seq, idx: f.idx, tradingDate: x.tradingDate, sheetSeq: x.sheetSeq, symbol: f.symbol, side: f.side, qty: f.qty, requestedQty: f.requestedQty, price: f.price });
          if (f.qty > 0) {
            const k = `${f.symbol}|${x.tradingDate}`;
            const t = traded.get(k) ?? traded.set(k, { buyQty: 0, sellQty: 0, prices: new Set() }).get(k)!;
            if (f.side === "buy") t.buyQty += f.qty;
            else t.sellQty += f.qty;
            t.prices.add(f.price);
          }
        }
        for (const f of [...list.filter((f) => f.side === "sell"), ...list.filter((f) => f.side === "buy")]) {
          if (f.qty === 0) continue;
          const amount = f.price * f.qty;
          const h = a.holdings[f.symbol] ?? { qty: 0, cost: 0 };
          if (f.side === "sell") {
            if (f.qty > h.qty) throw new Error(`${x.agentId} seq ${e.seq}: sold more ${f.symbol} than held`);
            const out = f.qty === h.qty ? h.cost : Math.round((h.cost * f.qty) / h.qty);
            a.cash += amount;
            if (f.qty === h.qty) delete a.holdings[f.symbol];
            else a.holdings[f.symbol] = { qty: h.qty - f.qty, cost: h.cost - out };
          } else {
            a.cash -= amount;
            a.holdings[f.symbol] = { qty: h.qty + f.qty, cost: h.cost + amount };
          }
          if (a.cash < 0) throw new Error(`${x.agentId} seq ${e.seq}: cash below zero`);
        }
        break;
      }
      case "valuation.recorded": {
        const a = acc.get(x.agentId)!;
        const qty = Object.fromEntries(Object.entries(a.holdings).map(([s, h]) => [s, h.qty]));
        const total = a.cash + Object.entries(qty).reduce((sum, [s, q]) => sum + q * priceOn(s, x.date), 0);
        (days.get(x.agentId) ?? days.set(x.agentId, []).get(x.agentId)!).push({ date: x.date, cash: a.cash, qty, total });
        break;
      }
    }
  }
  for (const id of kinds.keys()) if (!fills.has(id)) fills.set(id, []);
  const investors = [...kinds].filter(([, k]) => k === "investor").map(([id]) => id);
  return { kinds, investors, initial, acc, days, fills, traded, priceOn, staleOn };
}

let pg: PGlite;
let events: LogEvent[];
let ledger: Ledger;
let hand: ReturnType<typeof handCompute>;
let view: View;
let accounts: Map<string, Account>;
/** AIのページの関数（src/app/agents/[id]/page.tsx の AgentPage）が組み立てた中身。1体ごとに DB を2回読むので、1回だけ作る */
const pages = new Map<string, AgentPageModel>();
const pageOf = async (id: string) => ((await AgentPage({ params: Promise.resolve({ id: encodeURIComponent(id) }) })) as ReactElement<{ page: AgentPageModel }>).props.page;

let db: SqlDb;
const clock = new FakeClock(jst(FIRST, 7));
const holidayTables = new Map([[holidayTable.contentSha256, holidayTable]]);

beforeAll(async () => {
  ({ pg, db } = await openPglite());
  conn.db = db;
  await resetSchema(pg);
  await migrate(db);
  // 本番と同じ入口で、20営業日を、待つ形（`daily run --wait` と同じ）で回す
  const waitUntil = async (at: number) => void (at > clock.now() && clock.set(at));
  for (let t = Date.parse(`${FIRST}T00:00:00Z`); t <= Date.parse(`${LAST}T00:00:00Z`); t += 86_400_000) {
    await runDaily(new Date(t).toISOString().slice(0, 10), { db, clock, waitUntil, prepare: productionSetup, holidayTable });
  }
  await verifyDatabase(db, holidayTable);

  // 画面とは別の道：記録をそのまま読み、台帳を作り直す（replay）。そして手計算
  events = await readAllEvents(db);
  const values = await PgValueStore.open(db);
  ledger = await replay(events, values, { holidayTables });
  hand = handCompute(events);

  // 画面の道：DATABASE_URL ありで、画面のデータの出どころを通す
  vi.stubEnv("DATABASE_URL", URL_FOR_TEST);
  vi.stubEnv("VERCEL_ENV", "production");
  view = await getView();
  accounts = await getAccounts();
  for (const id of hand.investors) pages.set(id, await pageOf(id));
}, 300_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await conn.db?.close();
});

const lastDay = (id: string) => hand.days.get(id)!.at(-1)!;
/** 手計算の評価額から決めた、日ごとの順位（大きい順。同額は同じ順位） */
const handRank = (id: string, date: string) => {
  const totals = hand.investors.flatMap((a) => hand.days.get(a)!.filter((d) => d.date === date).map((d) => d.total));
  return 1 + totals.filter((t) => t > hand.days.get(id)!.find((d) => d.date === date)!.total).length;
};

describe("画面のデータの出どころが、PGlite の20営業日の記録を読む（大枠 #157 の通しの確認）", () => {
  it("前提：DATABASE_URL の道で読み、記録は20営業日分あり、AI投資家が売買し、配当・分割はない", async () => {
    expect(conn.opened.length).toBeGreaterThanOrEqual(2); // getView と getAccounts（cache はページの描画の外では効かない）
    expect(conn.opened.every((u) => u === URL_FOR_TEST)).toBe(true);
    const auctionDates = new Set(events.filter((e) => e.type === "auction.cleared").map((e) => p(e).date as string));
    expect(auctionDates.size).toBe(20);
    expect(hand.investors.sort()).toEqual(["ai-hold", "ai-ma5", "ai-reversal"]);
    for (const id of hand.investors) expect(hand.days.get(id), id).toHaveLength(20);
    // 売買した AI投資家がいる（20営業日で一度も約定しない AI もいる。今の記録では ai-reversal）
    const traders = hand.investors.filter((id) => hand.fills.get(id)!.some((f) => f.qty > 0));
    console.log(`investors with fills in 20 days: ${traders.join(", ")}`);
    expect(traders.length).toBeGreaterThanOrEqual(2);
    // 手計算は配当・分割を扱わないので、ないことを確かめておく
    expect(events.filter((e) => e.type === "corporate_action.announced")).toEqual([]);
    // 売買役がいる（確かめる対象が空でない）
    expect([...hand.kinds.values()].filter((k) => k !== "investor").length).toBeGreaterThan(0);
    // loadSource を直接呼んでも同じ（引数の env の道）
    const s = await loadSource({ DATABASE_URL: URL_FOR_TEST });
    expect(s.view.agents.map((a) => a.agentId)).toEqual(view.agents.map((a) => a.agentId));
  }, 60_000);

  it("AI の一覧・トップ・口座・AIのページの一覧・銘柄のページの持ち主に、マーケットメイカーなどの売買役が出ない", async () => {
    const investors = [...hand.investors].sort();
    expect(view.agents.map((a) => a.agentId).sort()).toEqual(investors);
    expect(buildArena(view).cards.map((c) => c.agentId).sort()).toEqual(investors);
    expect([...accounts.keys()].sort()).toEqual(investors);
    expect((await agentParams()).map((x) => x.id).sort()).toEqual(investors);
    for (const s of SYMBOLS) for (const h of buildBoard(view, s)!.holders) expect(investors).toContain(h.agentId);
    // トップの約定の流れも AI投資家の分だけ（売買役の約定は、名前が AI投資家のキャラの名前にならない）
    const names = investors.map((id) => characterOf(id, view.agents.find((a) => a.agentId === id)!.agentName).name);
    const feedFills = buildArena(view).feed.filter((x) => x.kind === "fill");
    expect(feedFills.length).toBeGreaterThan(0);
    for (const f of feedFills) expect(names.some((n) => f.text.startsWith(n)), f.text).toBe(true);
    // 売買役の AIのページは作られない
    const mm = [...hand.kinds].find(([, k]) => k !== "investor")![0];
    // Next.js の notFound() の例外（digest が "NEXT_HTTP_ERROR_FALLBACK;404"）。ほかの例外では通らない
    await expect(AgentPage({ params: Promise.resolve({ id: mm }) })).rejects.toMatchObject({ digest: expect.stringMatching(/;404$/) });
  }, 60_000);

  it("トップ：各 AI投資家の評価額・損益・順位が、手計算と一致する（日ごとの評価額・前日比・順位も）", () => {
    const { cards, feed } = buildArena(view);
    for (const a of view.agents) {
      const days = hand.days.get(a.agentId)!;
      const init = hand.initial.get(a.agentId)!;
      expect(a.initialCash).toBe(init);
      // AIの一覧（/agents）と、カードのもとになる日ごとの評価
      expect(a.days.map((d) => d.date)).toEqual(days.map((d) => d.date));
      expect(a.days.map((d) => d.total), a.agentId).toEqual(days.map((d) => d.total));
      expect(a.days.map((d) => yen(d.totalText))).toEqual(days.map((d) => d.total));
      expect(a.days.map((d) => yen(d.changeText))).toEqual(days.map((d, i) => d.total - (i === 0 ? init : days[i - 1]!.total)));
      expect(a.days.map((d) => d.rank)).toEqual(days.map((d) => handRank(a.agentId, d.date)));
      // 「直近の終値で評価」の印：持っている銘柄のどれかに、その日の値段がない日
      expect(a.days.map((d) => d.stale), a.agentId).toEqual(days.map((d) => Object.keys(d.qty).some((s) => hand.staleOn(s, d.date))));
      // カード
      const c = cards.find((x) => x.agentId === a.agentId)!;
      const last = lastDay(a.agentId);
      expect(yen(c.totalText)).toBe(last.total);
      expect(yen(c.pnl!.text)).toBe(last.total - init);
      expect(c.rank).toBe(handRank(a.agentId, LAST));
      expect(c.asOf).toBe(`${LAST.slice(5, 7)}/${LAST.slice(8, 10)}`);
      // 構成比の上位2銘柄（評価額の大きい順）
      const top = Object.entries(last.qty).map(([s, q]) => ({ s, v: q * hand.priceOn(s, LAST) })).sort((x, y) => y.v - x.v || (x.s < y.s ? -1 : 1)).slice(0, 2).map((x) => x.s);
      expect(c.top.map((t) => t.symbol)).toEqual(top);
      // 直近の約定
      const lastFill = hand.fills.get(a.agentId)!.filter((f) => f.qty > 0).at(-1);
      if (!lastFill) expect(c.lastTrade).toBeNull();
      else expect(c.lastTrade).toBe(`${lastFill.tradingDate.slice(5, 7)}/${lastFill.tradingDate.slice(8, 10)} ${lastFill.side === "buy" ? "買" : "売"} ${lastFill.symbol} ${lastFill.qty}株`);
    }
    // 「直近の終値で評価」の印の付いた日が1件以上ある（印の付く場合を通っている）
    const staleRows = view.agents.flatMap((a) => a.days.filter((d) => d.stale).map((d) => `${a.agentId} ${d.date}`));
    console.log(`stale valuation days: ${staleRows.join(", ") || "none"}`);
    expect(staleRows.length).toBeGreaterThan(0);
    // カードの並びは順位の順
    expect(cards.map((c) => c.rank)).toEqual([...cards.map((c) => c.rank)].sort((x, y) => x! - y!));
    // 流れの「首位」の行（key は rank-<日付>）：その日の手計算の最大の評価額と、その AI の名前（同額なら「同額」の行）
    const rankItems = feed.filter((f) => f.kind === "rank");
    expect(rankItems.filter((r) => r.text.includes("総資産")).length).toBeGreaterThan(0);
    for (const r of rankItems) {
      const date = r.key.replace(/^rank-/, "");
      const totals = hand.investors.map((id) => ({ id, total: hand.days.get(id)!.find((d) => d.date === date)!.total }));
      const max = Math.max(...totals.map((t) => t.total));
      const leaders = totals.filter((t) => t.total === max);
      if (leaders.length > 1) {
        expect(r.text, date).toContain("同額");
        continue;
      }
      const leader = leaders[0]!.id;
      const name = characterOf(leader, view.agents.find((a) => a.agentId === leader)!.agentName).name;
      expect(r.text.startsWith(`${name}が首位`), `${date}: ${r.text}`).toBe(true);
      expect(yen(r.text), date).toBe(max);
    }
  }, 60_000);

  it("口座（getAccounts）：AI投資家の現金・株数・取得原価が、作り直した台帳と手計算に一致する", () => {
    for (const id of hand.investors) {
      const shown = accounts.get(id)!;
      expect(shown, id).toEqual(ledger.account(id));
      const h = hand.acc.get(id)!;
      expect(shown.cash, id).toBe(h.cash);
      expect(shown.holdings, id).toEqual(h.holdings);
    }
  }, 60_000);

  it("AIのページ：総資産・損益・現金・持ち株（株数・評価額・取得単価・含み損益）・約定の件数・順位が、手計算と台帳に一致する", async () => {
    // 持ち株の行が1件以上ある（空の比較で通らない）
    expect(hand.investors.reduce((n, id) => n + pages.get(id)!.holdings.length, 0)).toBeGreaterThan(0);
    for (const id of hand.investors) {
      const page = pages.get(id)!;
      const last = lastDay(id);
      const init = hand.initial.get(id)!;
      const days = hand.days.get(id)!;
      expect(yen(page.stats!.totalText)).toBe(last.total);
      expect(yen(page.stats!.changeText)).toBe(last.total - days.at(-2)!.total);
      expect(yen(page.stats!.pnlText)).toBe(last.total - init);
      expect(page.stats!.fills).toBe(hand.fills.get(id)!.filter((f) => f.qty > 0).length);
      expect(page.rank).toBe(handRank(id, LAST));
      // 現金：手計算・台帳・最後の評価の記録が同じ
      expect(yen(page.cash!.text), id).toBe(last.cash);
      expect(last.cash).toBe(ledger.account(id).cash);
      // 持ち株
      const acct = ledger.account(id);
      expect(page.holdings.map((x) => x.symbol).sort(), id).toEqual(Object.keys(last.qty).sort());
      for (const hc of page.holdings) {
        const qty = last.qty[hc.symbol]!;
        const price = hand.priceOn(hc.symbol, LAST);
        const cost = hand.acc.get(id)!.holdings[hc.symbol]!.cost;
        expect(hc.qty, `${id} ${hc.symbol}`).toBe(qty);
        expect(acct.holdings[hc.symbol]!.qty).toBe(qty);
        expect(yen(hc.closeText)).toBe(price);
        expect(hc.stale, `${id} ${hc.symbol}`).toBe(hand.staleOn(hc.symbol, LAST));
        expect(yen(hc.valueText)).toBe(qty * price);
        expect(hc.unitCostText, `${id} ${hc.symbol}: 取得単価が出ない`).not.toBeNull();
        expect(yen(hc.unitCostText)).toBe(Math.round(cost / qty));
        expect(yen(hc.unrealized!.text)).toBe(qty * price - cost);
      }
    }
  }, 60_000);

  it("AIのページの売買の履歴：約定の行が記録の約定と1件ずつ一致し、新しい約定日から並ぶ", async () => {
    for (const id of hand.investors) {
      const page = pages.get(id)!;
      const rows = page.history.filter((r) => r.symbol !== null);
      const expected = [...hand.fills.get(id)!].sort((a, b) => (a.tradingDate < b.tradingDate ? 1 : a.tradingDate > b.tradingDate ? -1 : a.seq - b.seq || a.idx - b.idx));
      expect(rows.length, id).toBe(expected.length);
      const sheets = new Map(events.filter((e) => e.type === "order_sheet.committed").map((e) => [e.seq, e]));
      rows.forEach((r, i) => {
        const f = expected[i]!;
        const m = /^ (\d+)株(?: @(¥[\d,.]+))?(?:（注文 (\d+)株）)?$/.exec(r.tail);
        expect(m, r.tail).not.toBeNull();
        expect(r.key).toBe(`f${f.seq}-${f.idx}`);
        expect(r.dateText).toBe(`${f.tradingDate.slice(5, 7)}/${f.tradingDate.slice(8, 10)}`);
        expect(r.head).toBe(f.side === "buy" ? "買" : "売");
        expect(r.symbol).toBe(f.symbol);
        expect(Number(m![1])).toBe(f.qty);
        expect(m![2] === undefined ? null : yen(m![2])).toBe(f.price);
        expect(m![3] === undefined ? f.qty : Number(m![3])).toBe(f.requestedQty);
        // 注文票：確定の時刻（日本時間）と、判断の記録の seq
        const s = sheets.get(f.sheetSeq)!;
        expect(r.runSeq).toBe(p(s).runSeq);
        expect(r.committedText).toBe(new Date(s.recordedAt + 9 * 3_600_000).toISOString().slice(5, 16).replace("-", "/").replace("T", " "));
      });
      // 注文のない注文票・拒否された注文票の行も、記録の件数と同じ
      const empty = events.filter((e) => e.type === "order_sheet.committed" && p(e).agentId === id && (p(e).orders as unknown[]).length === 0).length;
      const rejected = events.filter((e) => e.type === "order_sheet.rejected" && p(e).agentId === id).length;
      expect(page.history.filter((r) => r.head === "注文なし").length).toBe(empty);
      expect(page.history.filter((r) => r.status === "拒否").length).toBe(rejected);
    }
  }, 60_000);

  it("銘柄のページ：値段の推移（板寄せの値段）と出来高が、約定の記録から足した値と、板寄せの記録に一致する。持っているAIの株数・評価額も手計算と一致する", async () => {
    expect((await symbolParams()).map((x) => x.symbol)).toEqual(expect.arrayContaining([...SYMBOLS].sort()));
    for (const s of SYMBOLS) {
      const company = view.market.companies.find((c) => c.listing.symbol === s)!;
      expect(yen(company.listing.listedPriceText)).toBe(events.map(p).find((x) => x.symbol === s && x.price !== undefined && x.sharesOutstanding !== undefined)!.price);
      const cleared = events.filter((e) => e.type === "auction.cleared" && p(e).symbol === s);
      expect(company.days.map((d) => d.date)).toEqual(cleared.map((e) => p(e).date));
      expect(company.days.length).toBeLessThanOrEqual(MAX_DAYS);
      for (const d of company.days) {
        const t = hand.traded.get(`${s}|${d.date}`);
        // 出来高 = その日のその銘柄の買いの約定の株数の合計 = 売りの合計（すべての参加者）
        expect(Number(d.volumeText.replaceAll(",", "").replace("株", "")), `${s} ${d.date}`).toBe(t?.buyQty ?? 0);
        expect(d.volume).toBe(t?.sellQty ?? 0);
        // 値段：約定があればその1つの値段。なければ「値つかず」で、評価には直近の値段を使う
        if (t) {
          expect([...t.prices], `${s} ${d.date}`).toHaveLength(1);
          expect(d.price).toBe([...t.prices][0]);
          expect(yen(d.priceText)).toBe([...t.prices][0]);
        } else {
          expect(d.price).toBeNull();
          expect(yen(d.carriedText)).toBe(hand.priceOn(s, d.date));
        }
      }
      // グラフの高値・安値の表示
      const chart = priceChart(company.days.slice(-MAX_DAYS), company.listing.listedPrice, formatYenMark)!;
      const priced = company.days.flatMap((d) => (d.price === null ? [] : [hand.traded.get(`${s}|${d.date}`) ? [...hand.traded.get(`${s}|${d.date}`)!.prices][0]! : NaN]));
      if (priced.length > 0) {
        expect(yen(chart.range!.highText)).toBe(Math.max(...priced));
        expect(yen(chart.range!.lowText)).toBe(Math.min(...priced));
      }
      // 決算の発表（台帳は持たない数字なので、発表の記録と直接比べる）。最新が先
      const disclosed = events.filter((e) => e.type === "company.disclosed" && p(e).symbol === s).reverse();
      expect(company.disclosures.map((d) => d.seq)).toEqual(disclosed.map((e) => e.seq));
      const plain = (t: string) => (t.startsWith("-") ? -1 : 1) * Number(t.replace(/[-¥,]/g, ""));
      company.disclosures.forEach((d, i) => {
        const x = p(disclosed[i]!);
        expect([plain(d.revenueText), plain(d.netIncomeText), yen(d.epsText), yen(d.dividendText)], `${s} ${String(x.period)}`).toEqual([x.revenue, x.netIncome, x.eps, x.dividendPerShare]);
      });
      // 持っているAI（最後の評価の日の株数と評価額）
      const holders = buildBoard(view, s)!.holders;
      const expected = hand.investors.filter((id) => (lastDay(id).qty[s] ?? 0) > 0);
      expect(holders.map((h) => h.agentId).sort()).toEqual(expected.sort());
      for (const h of holders) {
        expect(h.qty).toBe(lastDay(h.agentId).qty[s]);
        expect(yen(h.valueText)).toBe(h.qty * hand.priceOn(s, LAST));
        expect(h.stale).toBe(hand.staleOn(s, LAST));
      }
    }
  }, 60_000);
  // 画面の作り直しは1時間ごとなので、毎日の実行の途中の記録を読むことがある。架空の市場では、寄り付きの板寄せ・約定と評価が
  // 1回の実行の中で続けて書かれ、1件ずつ別のトランザクションなので、その間に読むと「今日の約定はあるが評価はまだ（または一部だけ）」が見える。
  // その状態は、評価の追記を途中で失敗させて作る。この確かめは記録を書き足すので、最後に置く
  it("次の営業日の途中（判断のあと・約定のあと評価の前・評価が一部だけ）に読んでも、トップと AIのページの数字は手計算と一致し、順位は評価のそろった日で、評価のあとに約定した銘柄は取得単価を出さない", async () => {
    const NEXT = "2026-11-25";
    const crashingOn = (type: string, n: number): SqlDb => {
      let seen = 0;
      return { ...db, transaction: (fn) => db.transaction((tx) => fn({ ...tx, query: (t, q) => (t.startsWith("INSERT INTO events") && q?.[2] === type && ++seen === n ? Promise.reject(new Error("crash")) : tx.query(t, q)) })) };
    };
    // 評価は参加者の順に書かれる。前の日の順で、最初の AI投資家の評価までを書き、その次（2体目の AI投資家か売買役）で落とす
    const order = events.filter((e) => e.type === "valuation.recorded" && p(e).date === LAST).map((e) => p(e).agentId as string);
    const firstInvestor = order.findIndex((id) => hand.investors.includes(id));
    expect(firstInvestor).toBeGreaterThanOrEqual(0);
    const steps = [
      { label: "7:00 判断のあと", at: jst(NEXT, 7), db: () => db },
      { label: "9:35 約定のあと・評価の前", at: jst(NEXT, 9, 35), db: () => crashingOn("valuation.recorded", 1) },
      { label: "9:35 評価が一部だけ", at: jst(NEXT, 9, 36), db: () => crashingOn("valuation.recorded", firstInvestor + 2) },
    ];
    const seenStates = new Set<number>();
    let hiddenCost = 0;
    for (const step of steps) {
      clock.set(Math.max(clock.now(), step.at));
      await runDaily(NEXT, { db: step.db(), clock, prepare: productionSetup, holidayTable }).catch((e: Error) => expect(e.message).toBe("crash"));
      const evs = await readAllEvents(db);
      const h2 = handCompute(evs);
      const valuedToday = h2.investors.filter((id) => h2.days.get(id)!.at(-1)!.date === NEXT);
      seenStates.add(valuedToday.length);
      const v = await getView();
      const accts = await getAccounts();
      const led = await replay(evs, await PgValueStore.open(db), { holidayTables });
      const cards = buildArena(v).cards;
      const filledToday = new Set(evs.filter((e) => e.type === "fills.executed" && p(e).tradingDate === NEXT && (p(e).fills as { qty: number }[]).some((f) => f.qty > 0)).map((e) => p(e).agentId as string));
      // 順位は、評価がそろった最後の日（AI投資家の全員に評価がある日）のもの
      const settled = valuedToday.length === h2.investors.length ? NEXT : LAST;
      const rankOn = (id: string, date: string) => 1 + h2.investors.filter((a) => h2.days.get(a)!.find((d) => d.date === date)!.total > h2.days.get(id)!.find((d) => d.date === date)!.total).length;
      for (const id of h2.investors) {
        const last = h2.days.get(id)!.at(-1)!;
        const where = `${step.label} ${id}`;
        expect(accts.get(id), where).toEqual(led.account(id));
        expect(accts.get(id)!.cash, where).toBe(h2.acc.get(id)!.cash);
        const c = cards.find((x) => x.agentId === id)!;
        expect(yen(c.totalText), where).toBe(last.total);
        expect(c.asOf, where).toBe(`${last.date.slice(5, 7)}/${last.date.slice(8, 10)}`);
        expect(c.rank, where).toBe(rankOn(id, settled));
        // AgentPage は buildAgentPage(getView(), getAccounts(), id) を返すだけなので、同じ組み立てを、1回読んだ値で呼ぶ
        const page = buildAgentPage(v, accts, id)!;
        expect(yen(page.stats!.totalText), where).toBe(last.total);
        expect(yen(page.cash!.text), where).toBe(last.cash);
        expect(page.rank, where).toBe(rankOn(id, settled));
        expect(page.holdings.map((x) => x.qty), where).toEqual(page.holdings.map((x) => last.qty[x.symbol]));
        for (const hc of page.holdings) {
          const tradedAfterValuation = filledToday.has(id) && last.date !== NEXT;
          if (tradedAfterValuation) {
            expect(hc.unitCostText, `${where} ${hc.symbol}`).toBeNull();
            hiddenCost++;
          }
          else expect(yen(hc.unitCostText), `${where} ${hc.symbol}`).toBe(Math.round(h2.acc.get(id)!.holdings[hc.symbol]!.cost / hc.qty));
        }
      }
      console.log(`${step.label}: investors filled today ${[...filledToday].filter((id) => h2.investors.includes(id)).join(",") || "none"}; valued today ${valuedToday.join(",") || "none"}`);
    }
    // 「評価が一部だけ」の状態を、実際に作れたこと
    expect([...seenStates].some((n) => n > 0 && n < 3), JSON.stringify([...seenStates])).toBe(true);
    // 「評価より後に約定したので取得単価を出さない」側を、実際に通ったこと
    expect(hiddenCost).toBeGreaterThan(0);
  }, 120_000);

  // 「直近の終値で評価」の印（PAPER_TRADING_RULES §6）を持ち株の画面で確かめるため、記録を書き足して、
  // AI投資家の持っている銘柄に値段がつかなかった日を最終日にする。この確かめも記録を書き足すので、最後に置く
  it("持っている銘柄に値段がつかなかった日が最終日のとき、AIのページの持ち株と銘柄のページの持ち主に印が付き、値段は直近の値段で、評価額は手計算と一致する", async () => {
    const waitUntil = async (at: number) => void (at > clock.now() && clock.set(at));
    let t = Date.parse("2026-11-25T00:00:00Z");
    let found: { id: string; symbol: string; date: string } | undefined;
    let h2 = hand;
    let evs = events;
    for (let n = 0; n < 40 && !found; n++, t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      await runDaily(date, { db, clock, waitUntil, prepare: productionSetup, holidayTable });
      evs = await readAllEvents(db);
      h2 = handCompute(evs);
      for (const id of h2.investors) {
        const last = h2.days.get(id)!.at(-1)!;
        const symbol = Object.keys(last.qty).find((s) => h2.staleOn(s, last.date));
        if (symbol && last.date === date) found = { id, symbol, date };
      }
    }
    expect(found, "40日のうちに、持っている銘柄に値段がつかない日がなかった").toBeDefined();
    console.log(`stale holding on the last day: ${JSON.stringify(found)}`);
    const { id, symbol, date } = found!;
    const v = await getView();
    const accts = await getAccounts();
    const last = h2.days.get(id)!.at(-1)!;
    const page = buildAgentPage(v, accts, id)!;
    expect(page.stats!.asOf).toBe(`${date.slice(5, 7)}/${date.slice(8, 10)}`);
    expect(yen(page.stats!.totalText)).toBe(last.total);
    for (const hc of page.holdings) {
      expect(hc.stale, hc.symbol).toBe(h2.staleOn(hc.symbol, date));
      expect(yen(hc.closeText), hc.symbol).toBe(h2.priceOn(hc.symbol, date));
      expect(yen(hc.valueText), hc.symbol).toBe(hc.qty * h2.priceOn(hc.symbol, date));
    }
    expect(page.holdings.find((x) => x.symbol === symbol)!.stale).toBe(true);
    // その日の板寄せは「値つかず」で、直近の値段を添える
    const day = v.market.companies.find((c) => c.listing.symbol === symbol)!.days.find((d) => d.date === date)!;
    expect(day.price).toBeNull();
    expect(yen(day.carriedText)).toBe(h2.priceOn(symbol, date));
    // 銘柄のページの持ち主
    const holder = buildBoard(v, symbol)!.holders.find((x) => x.agentId === id)!;
    expect(holder.stale).toBe(true);
    expect(holder.qty).toBe(last.qty[symbol]);
    expect(yen(holder.valueText)).toBe(last.qty[symbol]! * h2.priceOn(symbol, date));
    // 日ごとの一覧の印も、その日に付く
    expect(v.agents.find((a) => a.agentId === id)!.days.at(-1)!.stale).toBe(true);
  }, 180_000);
});
