// 検証役（#110 の1つ目の PR #112 の確認）：板寄せ（runAuction・priceBand）を壊しにいく。
// 期待は実装ではなく docs/MARKET_DESIGN.md §2・§3 と #110 の lead の決定から書く：
// - 値幅：前日の価格から「±20%」と「±1円」の広いほうまで。1円刻みで、1円より下げない。その外では約定しない
// - 価格：約定量が最大 → 余りが小さい → 前日に近い → 低い
// - 株数の割り振り：余った側は、成行 → 有利な指値 → 確定時刻の早い順（そのあと注文票の番号・中の順）。最後の1件だけ100株単位で一部約定
// 欠陥の再現は it.fails。乱数は固定シードで、落ちたときは入力をメッセージに出す。
import { describe, expect, it } from "vitest";
import { runAuction, priceBand, TICK, type AuctionInput, type AuctionOrder } from "../../src/ledger/auction";
import { LOT } from "../../src/ledger/types";
import { mulberry32, pick, randInt } from "../fixtures/prng";

const yen = (n: number) => n * 10; // 円 → 0.1円単位

// ---- 文書から書いた模型（BigInt。候補の価格を全部並べて比べる） ----

/** 値幅の候補：1円刻み・1円以上で、前日との差が max(前日の20%, 1円) 以内の価格すべて（5|p−前日| ≤ max(前日, 5円)） */
function bandModel(prev: number): number[] {
  const out: number[] = [];
  const w5 = BigInt(Math.max(prev, yen(5)));
  for (let p = TICK; p <= prev * 2 + yen(2); p += TICK) {
    if (5n * BigInt(Math.abs(p - prev)) <= w5) out.push(p);
  }
  return out;
}

const executableModel = (o: AuctionOrder, p: number) => o.limit === null || (o.side === "buy" ? o.limit >= p : o.limit <= p);

/** 余った側の順位の鍵（小さいほど先） */
const rankKey = (o: AuctionOrder): bigint[] => [o.limit === null ? 0n : 1n, o.limit === null ? 0n : BigInt(o.side === "buy" ? -o.limit : o.limit), BigInt(o.committedAt), BigInt(o.sheetSeq), BigInt(o.index)];
const cmpKeys = (a: bigint[], b: bigint[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
};

function auctionModel(input: AuctionInput) {
  const cands = bandModel(input.prevPrice).map((p) => {
    let buy = 0n;
    let sell = 0n;
    for (const o of input.orders) {
      if (!executableModel(o, p)) continue;
      if (o.side === "buy") buy += BigInt(o.qty);
      else sell += BigInt(o.qty);
    }
    const volume = buy < sell ? buy : sell;
    const surplus = buy > sell ? buy - sell : sell - buy;
    return { p, key: [-volume, surplus, BigInt(Math.abs(p - input.prevPrice)), BigInt(p)], volume };
  });
  cands.sort((a, b) => cmpKeys(a.key, b.key));
  const top = cands[0]!;
  // どの決め方で決まったか（0：約定量、1：余り、2：前日との近さ、3：低い価格）
  const second = cands[1];
  const decidedBy = second ? top.key.findIndex((k, i) => k !== second.key[i]) : -1;
  const price = top.volume > 0n ? top.p : null;
  const filled = new Map<AuctionOrder, bigint>();
  if (price !== null) {
    for (const side of ["buy", "sell"] as const) {
      let left = top.volume;
      const q = input.orders.filter((o) => o.side === side && executableModel(o, price)).sort((a, b) => cmpKeys(rankKey(a), rankKey(b)));
      for (const o of q) {
        const n = BigInt(o.qty) < left ? BigInt(o.qty) : left;
        filled.set(o, n);
        left -= n;
      }
    }
  }
  return {
    decidedBy,
    price,
    volume: price === null ? 0 : Number(top.volume),
    fills: input.orders.map((o) => {
      const qty = Number(filled.get(o) ?? 0n);
      const status = qty === o.qty ? "filled" : qty === 0 ? "expired" : "reduced";
      const reason = status === "filled" ? undefined : price === null ? "no_price" : !executableModel(o, price) ? "limit_not_reached" : "outmatched";
      return { sheetSeq: o.sheetSeq, index: o.index, side: o.side, requestedQty: o.qty, qty, status, ...(reason ? { reason } : {}) };
    }),
  };
}

let nextSeq = 1;
const order = (side: "buy" | "sell", qty: number, limitYen: number | null, committedAt = 0, sheetSeq = nextSeq++, index = 0): AuctionOrder => ({ sheetSeq, index, committedAt, side, qty, limit: limitYen === null ? null : yen(limitYen) });
const run = (prevYen: number, orders: AuctionOrder[]) => runAuction({ symbol: "AAA", prevPrice: yen(prevYen), orders });

describe("値幅（±20% と ±1円の広いほう、1円刻み、1円より下げない）", () => {
  it("前日の価格 0.1円〜300円のすべてと、無作為な高い価格で、下限と上限が文書の模型と一致する", () => {
    const prevs = [...Array.from({ length: 3000 }, (_, i) => i + 1)];
    const rand = mulberry32(0x110);
    for (let i = 0; i < 300; i++) prevs.push(randInt(rand, 3001, 2_000_000));
    for (const prev of prevs) {
      const m = bandModel(prev);
      expect(priceBand(prev), `prev ${prev}`).toEqual({ lower: m[0], upper: m.at(-1) });
    }
  });

  it("安い価格（前日4円）でも±1円まで動ける。20%を超える5円で約定し、6円の売りは値幅の外で約定しない", () => {
    expect(run(4, [order("buy", 100, 5), order("sell", 100, 5)]).price).toBe(yen(5));
    expect(run(4, [order("buy", 100, 3), order("sell", 100, null)]).price).toBe(yen(3));
    const out = run(4, [order("buy", 100, null), order("sell", 100, 6)]);
    expect([out.price, out.fills.map((f) => f.reason)]).toEqual([null, ["no_price", "no_price"]]);
  });

  it("1円より下がらない：前日1円でも0.8円でも、成行どうしは1円で約定し、0円台の価格はつかない", () => {
    for (const prev of [10, 8, 1]) {
      const out = runAuction({ symbol: "AAA", prevPrice: prev, orders: [order("buy", 100, null), order("sell", 100, null)] });
      expect([out.lower, out.price], `prev ${prev}`).toEqual([yen(1), yen(1)]);
    }
  });

  it("前日1000円なら800円〜1200円の端で約定し、1201円の売り・799円の買いは約定しない", () => {
    expect(run(1000, [order("buy", 100, null), order("sell", 100, 1200)]).price).toBe(yen(1200));
    expect(run(1000, [order("buy", 100, null), order("sell", 100, 1201)]).price).toBeNull();
    expect(run(1000, [order("buy", 100, 800), order("sell", 100, null)]).price).toBe(yen(800));
    expect(run(1000, [order("buy", 100, 799), order("sell", 100, null)]).price).toBeNull();
  });

  it("呼値に合わない前日の価格（1001.5円）は、20%の外へ丸めない（上限1201円・下限802円）", () => {
    const out = runAuction({ symbol: "AAA", prevPrice: 10015, orders: [order("buy", 100, null), order("sell", 100, 1202)] });
    expect([out.lower, out.upper, out.price]).toEqual([yen(802), yen(1201), null]);
  });
});

describe("価格の決め方の順（約定量 → 余り → 前日に近い → 低い）", () => {
  it("約定量が最大の価格を、余りや前日との近さより先に選ぶ", () => {
    // 990〜1004円は約定100株、1005〜1010円は300株
    const out = run(1000, [order("buy", 300, 1010), order("sell", 100, 990), order("sell", 200, 1005)]);
    expect([out.price, out.volume]).toEqual([yen(1005), 300]);
  });

  it("約定量の大きい価格のほうが余りも大きくても、約定量を先に見る", () => {
    // 1003円：約定300・余り200。1004円以上：約定200・余り100。1000〜1002円：約定200・余り300
    const out = run(1000, [order("buy", 200, null), order("buy", 300, 1003), order("sell", 200, 1000), order("sell", 100, 1003)]);
    expect([out.price, out.volume]).toEqual([yen(1003), 300]);
  });

  it("約定量が並んだら、前日から遠くても余りの小さい価格を選ぶ", () => {
    // どの価格でも約定100株。1000〜1001円は余り200、1002〜1005円は余り100
    const out = run(1000, [order("buy", 200, 1005), order("buy", 100, 1001), order("sell", 100, 1000)]);
    expect(out.price).toBe(yen(1002));
  });

  it("余りも並んだら、低い価格より前日に近い価格を選ぶ", () => {
    expect(run(1000, [order("buy", 100, null), order("sell", 100, null)]).price).toBe(yen(1000));
  });

  it("前日との近さも並んだら（前日100.5円で100円と101円）、低い価格を選ぶ", () => {
    const out = runAuction({ symbol: "AAA", prevPrice: 1005, orders: [order("buy", 100, null), order("sell", 100, null)] });
    expect(out.price).toBe(yen(100));
  });
});

describe("株数の割り振り（成行 → 有利な指値 → 確定時刻 → 番号 → 中の順。最後の1件だけ100株単位で一部）", () => {
  it("成行は、より有利な指値より先。指値は高い買いが先、同じ指値は早い確定が先。届かない指値は limit_not_reached", () => {
    const orders = [
      order("buy", 300, 1010, 1, 1), // 指値1010円・遅い
      order("buy", 200, null, 5, 2), // 成行・いちばん遅い
      order("buy", 100, 1010, 0, 3), // 指値1010円・早い
      order("buy", 500, 1005, 0, 4), // 1006円には届かない
      order("sell", 400, null, 0, 5),
    ];
    const out = run(1000, orders);
    // どの価格でも売り400。約定400は1010円以下で並び、余りは1006〜1010円で200がいちばん小さく、そのうち前日に近い1006円
    expect([out.price, out.volume]).toEqual([yen(1006), 400]);
    expect(out.fills.map((f) => [f.qty, f.status, f.reason ?? ""])).toEqual([
      [100, "reduced", "outmatched"],
      [200, "filled", ""],
      [100, "filled", ""],
      [0, "expired", "limit_not_reached"],
      [400, "filled", ""],
    ]);
  });

  it("確定時刻が同じなら注文票の番号、番号も同じなら注文票の中の順。並べ替えても同じ結果", () => {
    const orders = [order("sell", 200, null, 7, 9, 1), order("sell", 200, null, 7, 9, 0), order("sell", 200, null, 7, 3, 2), order("buy", 300, null, 0, 1)];
    const a = run(1000, orders);
    const b = run(1000, [...orders].reverse());
    // 番号3 → 番号9の中の順0 → 中の順1
    const bySeq = (r: typeof a) => Object.fromEntries(r.fills.map((f) => [`${f.sheetSeq}:${f.index}`, f.qty]));
    expect(bySeq(a)).toEqual({ "3:2": 200, "9:0": 100, "9:1": 0, "1:0": 300 });
    expect(bySeq(b)).toEqual(bySeq(a));
  });

  it("どちらも約定できる指値どうしでは、確定が遅くても有利な指値が先（売りは安い順、買いは高い順）", () => {
    // 売り：995円で約定300（買い300）。売りは990円と995円の両方が約定でき、安い990円（遅い確定）が先に200、995円は100だけ
    const sells = run(1000, [order("sell", 200, 995, 0, 1), order("sell", 200, 990, 9, 2), order("buy", 300, 995, 0, 3)]);
    expect([sells.price, sells.fills.map((f) => [f.qty, f.reason ?? ""])]).toEqual([yen(995), [[100, "outmatched"], [200, ""], [300, ""]]]);
    // 買い：1005円で約定300（売り300）。高い1010円（遅い確定）が先に200、1005円は100だけ
    const buys = run(1000, [order("buy", 200, 1005, 0, 1), order("buy", 200, 1010, 9, 2), order("sell", 300, 1005, 0, 3)]);
    expect([buys.price, buys.fills.map((f) => [f.qty, f.reason ?? ""])]).toEqual([yen(1005), [[100, "outmatched"], [200, ""], [300, ""]]]);
  });
});

describe("文書の模型との突き合わせ（無作為な板、シード固定）", () => {
  it("価格・約定量・各注文の約定量と理由が模型と一致し、一部約定は片側に高々1件で、それより優先の高い注文は全部約定している", () => {
    const seed = 0x112;
    const rand = mulberry32(seed);
    const stats = { priced: 0, unpriced: 0, reduced: 0, lowBand: 0, offTick: 0, tiesByTime: 0, byVolume: 0, bySurplus: 0, byDistance: 0, byLower: 0 };
    for (let i = 0; i < 1500; i++) {
      const prev = pick(rand, [randInt(rand, 1, 60), randInt(rand, 1, 60) * 10, randInt(rand, 900, 1100) * 10, randInt(rand, 9000, 11000)]);
      const { lower, upper } = priceBand(prev);
      const edges = [lower, upper, lower + TICK, upper - TICK, Math.round(prev / TICK) * TICK, lower - TICK, upper + TICK].filter((x) => x >= TICK);
      // 値幅の端だけでなく、値幅の中のどこかの価格も混ぜる
      const anyInBand = () => lower + TICK * randInt(rand, 0, (upper - lower) / TICK);
      const n = randInt(rand, 0, 10);
      const orders: AuctionOrder[] = [];
      for (let k = 0; k < n; k++) {
        const seq = randInt(rand, 1, 6);
        const idx = orders.filter((o) => o.sheetSeq === seq).length;
        orders.push({
          sheetSeq: seq,
          index: idx,
          committedAt: randInt(rand, 0, 3), // 時刻が並ぶことが多い
          side: rand() < 0.5 ? "buy" : "sell",
          qty: LOT * randInt(rand, 1, 8),
          limit: rand() < 0.25 ? null : rand() < 0.5 ? pick(rand, edges) : anyInBand(),
        });
      }
      const input: AuctionInput = { symbol: "AAA", prevPrice: prev, orders };
      const at = `seed ${seed} i ${i}: ${JSON.stringify(input)}`;
      const got = runAuction(input);
      const { decidedBy, ...want } = auctionModel(input);
      expect({ price: got.price, volume: got.volume, fills: got.fills }, at).toEqual(want);
      // 候補が1つしかない値幅（前日がとても安いとき）は、決め方の比べ合いがないので数えない
      if (got.price !== null && decidedBy >= 0) stats[(["byVolume", "bySurplus", "byDistance", "byLower"] as const)[decidedBy]!]++;
      if (got.price !== null) expect(got.price >= lower && got.price <= upper, at).toBe(true);
      expect(got.volume % LOT, at).toBe(0);
      for (const side of ["buy", "sell"] as const) {
        const mine = got.fills.filter((f) => f.side === side);
        expect(mine.reduce((t, f) => t + f.qty, 0), at).toBe(got.volume);
        expect(mine.filter((f) => f.status === "reduced").length, at).toBeLessThanOrEqual(1);
        for (const f of mine) expect(f.qty % LOT, at).toBe(0);
      }
      stats[got.price === null ? "unpriced" : "priced"]++;
      if (got.fills.some((f) => f.status === "reduced")) stats.reduced++;
      if (prev < yen(5)) stats.lowBand++;
      if (prev % TICK !== 0) stats.offTick++;
      if (new Set(orders.map((o) => o.committedAt)).size < orders.length) stats.tiesByTime++;
    }
    // どの決め方まで進んで価格が決まったかも、それぞれ起きていること
    for (const [k, v] of Object.entries(stats)) expect(v, `${k} ${JSON.stringify(stats)}`).toBeGreaterThan(k === "byLower" ? 5 : 20);
  });
});

describe("入力の穴", () => {
  // 欠陥（低）：注文ごとの株数は安全な整数か確かめるが、合計は確かめない。合計が 2^53 を超えると浮動小数で丸まり、
  // 約定量が100株単位でなくなる（最後の1件の一部約定も100株単位でなくなる）。実際の参加者の現金では届かない大きさ。
  // 直し方の方針：片側の株数の合計が安全な整数（Number.MAX_SAFE_INTEGER 以下）でなければ、例外にする（または株数に現実的な上限を置く）
  it.fails("株数の合計がとても大きくても、約定量は100株単位で、買いと売りの約定量が一致する（さもなければ例外で断る）", () => {
    const Q = 9_007_199_254_740_900; // 100株単位で、安全な整数の上限に近い株数
    const orders = [...Array.from({ length: 5 }, (_, i) => order("buy", Q, null, 0, 100 + i)), ...Array.from({ length: 6 }, (_, i) => order("sell", Q, null, 0, 200 + i))];
    let out;
    try {
      out = run(1000, orders);
    } catch {
      return; // 断るなら、それでよい
    }
    expect(out.volume % LOT).toBe(0);
    const sum = (side: string) => out.fills.filter((f) => f.side === side).reduce((t, f) => t + BigInt(f.qty), 0n);
    expect(sum("buy")).toBe(sum("sell"));
    for (const f of out.fills) expect(f.qty % LOT).toBe(0);
  });

  it("形の崩れた注文（100株単位でない、呼値に合わない指値、0円の指値、重複、売買の誤り）は例外で断る", () => {
    const bad: AuctionOrder[][] = [
      [order("buy", 150, null)],
      [{ ...order("buy", 100, null), limit: 10_005 }],
      [{ ...order("buy", 100, null), limit: 0 }],
      [order("buy", 100, null, 0, 1, 0), order("sell", 100, null, 0, 1, 0)],
      [{ ...order("buy", 100, null), side: "hold" as "buy" }],
      [{ ...order("buy", 100, null), committedAt: -1 }],
    ];
    for (const [i, orders] of bad.entries()) expect(() => run(1000, orders), String(i)).toThrow();
    for (const prev of [0, -10, 1.5, Number.NaN, 100_000_000 * 10 + 1]) expect(() => runAuction({ symbol: "AAA", prevPrice: prev, orders: [] }), String(prev)).toThrow();
  });
});
