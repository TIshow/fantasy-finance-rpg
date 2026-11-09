// 検証役（大枠 #139：#30 の毎日の実行のコマンド・#113 PR-3b・#138 の確認）。本番の準備（productionSetup）で、
// PGlite（試験用の Postgres）の保管に対して runDaily を回し、記録・照合・二重の記録の穴を突く。
// 成り立つはずのこと（#30・#113 の lead コメント、PAPER_TRADING_RULES §1、MARKET_DESIGN §5）：
// (1) あとから前の日を回し直しても、記録は増えない（同じ日をすぐ2回回す場合は daily-production.test.ts）。
//     ただし、引けのあとから次の取引日の締めまでに回した実行は、次の取引日の判断だけを書く（#228 の夜の実行）
// (2) GitHub Actions の形（待たずに 06:50・07:20・09:35・16:35 に回す）でも、待つ形で回したのと同じ台帳になる
// (3) 取引対象が架空の6社だけなら、その日の評価と引け後の処理は、9:30 の板寄せのあと、09:35 の回に書く。記録の時刻は
//     実際に書いた時刻のまま。16:35 の回は、その日の分は何も書かず、次の取引日の判断だけを書く（#228。前は何も書かなかった）
// (4) 毎日の実行は、上場の日に上場の前の四半期の決算を発表する（#143 で直った。確かめるのは daily-production.test.ts）
// (5) verify（verifyDatabase）は、連鎖のハッシュを作り直した改ざん（数字の書き換え・1件の抜き取り）も、
//     ログの外の値の書き換えも見逃さない。止まる理由は連鎖ではなく、書き換えた記録の再計算の食い違いや、抜けた記録の検査
// 売買役の数字（値の幅・注文の確率など）は変わりうるので、件数や値段は決め打ちにせず、参加者の数や記録の性質で確かめる
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventHash } from "../../src/events/hash";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { holidayTable } from "../../src/holidays";
import { readAllEvents } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate, type SqlDb } from "../../src/store/sql";
import { productionSetup, runDaily, verifyDatabase } from "../../scripts/daily-lib";
import { FakeClock, jst } from "../contracts/fakes";
import { openPglite, resetSchema } from "../store/pglite";

let pg: PGlite;
let db: SqlDb;
beforeAll(async () => {
  ({ pg, db } = await openPglite());
}, 60_000);
afterAll(() => db.close());

const fresh = async () => {
  await resetSchema(pg);
  await migrate(db);
};
const p = (e: LogEvent) => e.payload as Record<string, unknown>;
/** 3営業日（11/9〜11/11。祝日なし） */
const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11"];
const holidayTables = new Map([[holidayTable.contentSha256, holidayTable]]);

/** 待つ形：1日1回、決まった時刻まで時計を進めながら回す（--wait） */
async function runWaiting(days: readonly string[]) {
  const clock = new FakeClock(jst(days[0]!, 6, 50));
  const waitUntil = async (at: number) => void (at > clock.now() && clock.set(at));
  for (const d of days) {
    if (clock.now() < jst(d, 6, 50)) clock.set(jst(d, 6, 50));
    await runDaily(d, { db, clock, prepare: productionSetup, holidayTable, waitUntil });
  }
  return clock;
}

/** GitHub Actions の形：待たずに、決まった時刻に何度も回す（#30 の platform コメントの時刻） */
async function runLikeActions(days: readonly string[], afterEach?: (run: { date: string; at: string }) => Promise<void>) {
  const clock = new FakeClock(jst(days[0]!, 6, 50));
  for (const d of days) {
    for (const [hh, mm] of [[6, 50], [7, 20], [9, 35], [16, 35]] as const) {
      clock.set(Math.max(clock.now(), jst(d, hh, mm)));
      await runDaily(d, { db, clock, prepare: productionSetup, holidayTable });
      await afterEach?.({ date: d, at: `${hh}:${mm}` });
    }
  }
  return clock;
}

const accountsOf = async (events: readonly LogEvent[]) => {
  const ledger = await replay(events, await PgValueStore.open(db), { holidayTables });
  const ids = events.filter((e) => e.type === "agent.registered").map((e) => p(e).agentId as string);
  return Object.fromEntries(ids.map((id) => [id, ledger.account(id)]));
};

describe("毎日の実行のコマンドを、本番の準備で3営業日回す（PGlite）", () => {
  // 前は「休日の当日（11/14・11/15）に回しても増えない」も確かめていた。D-047 で 11/9 以後の土日は取引日になったので外した
  it("前の日をあとから（新しい日から古い日へ）回し直しても、その日までの記録は1件も増えない。夜に回すと次の取引日の判断だけを1回書く", async () => {
    await fresh();
    const clock = await runWaiting(DAYS);
    const before = await readAllEvents(db);
    clock.set(jst("2026-11-11", 23));
    for (const d of DAYS.slice().reverse()) await runDaily(d, { db, clock, prepare: productionSetup, holidayTable });
    // 11/11 の 23:00 は 11/12 の受け付けの中なので、11/11 の実行が 11/12 の判断を書く（#228）。前の日の分は増えない
    const night = await readAllEvents(db);
    expect(night.slice(0, before.length)).toEqual(before);
    const extra = night.slice(before.length);
    expect(extra.filter((e) => e.type === "order_sheet.committed").map((e) => p(e).tradingDate)).toEqual(before.filter((e) => e.type === "agent.registered").map(() => "2026-11-12"));
    expect([...new Set(extra.map((e) => e.type))].filter((t) => !["agent.run", "order_sheet.committed", "post.published"].includes(t))).toEqual([]);
    // もう一度回しても、何も増えない
    for (const d of DAYS.slice().reverse()) await runDaily(d, { db, clock, prepare: productionSetup, holidayTable });
    expect(await readAllEvents(db)).toEqual(night);
    // 1日の記録の形：参加者ごと・日ごとに注文票・約定・評価・引け後が1件ずつ、銘柄ごと・日ごとに板寄せが1件
    const n = (t: LogEvent["type"]) => before.filter((e) => e.type === t).length;
    const participants = n("agent.registered");
    const symbols = n("company.listed");
    expect(participants).toBeGreaterThan(symbols);
    for (const t of ["order_sheet.committed", "fills.executed", "valuation.recorded", "corporate_actions.applied"] as const) expect(n(t), t).toBe(participants * DAYS.length);
    expect(n("auction.cleared")).toBe(symbols * DAYS.length);
    expect([n("universe.set"), n("holidays.adopted")]).toEqual([1, 1]);
    await verifyDatabase(db, holidayTable);
  }, 120_000);

  it("GitHub Actions の形（待たずに1日4回）で回しても、毎回の照合が通り、待つ形と同じ口座になる", async () => {
    await fresh();
    await runWaiting(DAYS);
    const waited = await accountsOf(await readAllEvents(db));
    await fresh();
    await runLikeActions(DAYS, async () => void (await verifyDatabase(db, holidayTable)));
    expect(await accountsOf(await readAllEvents(db))).toEqual(waited);
  }, 180_000);

  // 以前は欠陥として報告した動き（15:30 より前に評価を書く）。架空の6社だけのときは、その日の値段が 9:30 の板寄せで決まり、
  // そのあと変わらないので、lead が認めた（#139 の 12:35 UTC の lead コメントの3）
  it("Actions の形では、その日の評価と引け後の処理を、板寄せのあと 09:35 の回に参加者ごとに1回ずつ書き、16:35 の回は何も書かない", async () => {
    await fresh();
    const days = DAYS.slice(0, 2);
    // 16:35 の回の前後で、記録の数を控える
    const afterClose: { date: string; before: number; after: number }[] = [];
    let count = 0;
    await runLikeActions(days, async ({ date, at }) => {
      const n = (await readAllEvents(db)).length;
      if (at === "16:35") afterClose.push({ date, before: count, after: n });
      count = n;
    });
    expect(afterClose.map((x) => x.date)).toEqual(days);
    const events = await readAllEvents(db);
    // 16:35 の回は、次の取引日の判断（agent.run・注文票・投稿）だけを書く（#228）
    for (const x of afterClose) {
      const wrote = events.slice(x.before, x.after);
      const next = String(Number(x.date.slice(8)) + 1).padStart(2, "0");
      expect([...new Set(wrote.map((e) => e.type))].filter((t) => !["agent.run", "order_sheet.committed", "post.published"].includes(t)), `16:35 of ${x.date}`).toEqual([]);
      expect(wrote.filter((e) => e.type === "order_sheet.committed").every((e) => p(e).tradingDate === `${x.date.slice(0, 8)}${next}`), `16:35 of ${x.date}`).toBe(true);
      expect(wrote.filter((e) => e.type === "order_sheet.committed").length, `16:35 of ${x.date}`).toBeGreaterThan(0);
    }
    const participants = events.filter((e) => e.type === "agent.registered").map((e) => p(e).agentId as string).sort();
    expect(participants.length).toBeGreaterThan(0);
    for (const d of days) {
      const dayOf = (e: LogEvent) => (e.type === "valuation.recorded" ? p(e).date : p(e).asOf) === d;
      for (const type of ["valuation.recorded", "corporate_actions.applied"] as const) {
        const mine = events.filter((e) => e.type === type && dayOf(e));
        // 参加者ごとにちょうど1回
        expect(mine.map((e) => p(e).agentId as string).sort(), `${type} ${d}`).toEqual(participants);
        for (const e of mine) {
          // 記録の時刻は、09:35 の回で実際に書いた時刻（時計はその回のあいだ 09:35 のまま）
          expect(e.recordedAt, `${type} ${String(p(e).agentId)} ${d}`).toBeGreaterThanOrEqual(jst(d, 9, 35));
          expect(e.recordedAt, `${type} ${String(p(e).agentId)} ${d}`).toBeLessThan(jst(d, 9, 36));
        }
        // その日の板寄せ（6社すべて）より後に書いた
        const auctions = events.filter((e) => e.type === "auction.cleared" && p(e).date === d);
        expect(auctions.length).toBeGreaterThan(0);
        const lastAuction = Math.max(...auctions.map((e) => e.seq));
        for (const e of mine) expect(e.seq).toBeGreaterThan(lastAuction);
      }
    }
  }, 120_000);

  // 上場の日の決算の発表（以前の欠陥。#143 で直った）は、daily-production.test.ts の
  // 「毎日の実行のコマンドだけで、上場の日に、6社の上場の前の四半期を発表する」が、銘柄と四半期まで確かめる（重複なので、ここからは外した）
});

/** 書き換えた記録を、連鎖のハッシュを先頭から作り直して DB に入れ直す（表の持ち主がトリガを外した場合） */
async function forge(events: readonly LogEvent[]): Promise<void> {
  const out: LogEvent[] = [];
  for (const [i, e] of events.entries()) {
    const { hash: _, ...rest } = { ...e, seq: i + 1, prevHash: i === 0 ? "0".repeat(64) : out[i - 1]!.hash };
    out.push({ ...rest, hash: await eventHash(rest) });
  }
  await pg.exec("ALTER TABLE events DISABLE TRIGGER USER; DELETE FROM events;");
  for (const e of out) {
    await pg.query("INSERT INTO events (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)", [
      e.seq, e.schema, e.type, e.recordedAt, e.actor, JSON.stringify(e.keys), JSON.stringify(e.refs), JSON.stringify(e.payload), e.prevHash, e.hash,
    ]);
  }
  await pg.exec("ALTER TABLE events ENABLE TRIGGER USER;");
}

/**
 * 抜いたあと、refs と payload の中の seq（名前が Seq・Seqs で終わる項目）を、新しい番号に付け替える。
 * 抜いた先を指す数は、並びからは捨て、1つの値ならその直前の記録を指させる
 */
function drop(events: readonly LogEvent[], pick: (e: LogEvent) => boolean): LogEvent[] {
  const kept = events.filter((e) => !pick(e));
  expect(kept.length).toBe(events.length - 1);
  const to = new Map(kept.map((e, i) => [e.seq, i + 1]));
  const one = (v: number) => to.get(v) ?? kept.filter((e) => e.seq < v).length;
  const seqs = (v: unknown): unknown => (Array.isArray(v) ? v.flatMap((x) => (typeof x === "number" ? (to.has(x) ? [to.get(x)] : []) : [walk(x)])) : typeof v === "number" ? one(v) : walk(v));
  const walk = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(walk) : typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /Seqs?$/.test(k) ? seqs(x) : walk(x)])) : v;
  return kept.map((e) => ({ ...e, refs: seqs(e.refs) as number[], payload: walk(e.payload) as LogEvent["payload"] }));
}

describe("verify：連鎖を作り直した改ざんも見逃さない（PGlite）", () => {
  let original: LogEvent[] = [];
  const edit = (pick: (e: LogEvent) => boolean, change: (payload: Record<string, unknown>) => void) =>
    original.map((e) => {
      if (!pick(e)) return e;
      const payload = structuredClone(e.payload) as Record<string, unknown>;
      change(payload);
      return { ...e, payload };
    });

  beforeAll(async () => {
    await fresh();
    await runWaiting(DAYS);
    original = await readAllEvents(db);
    // 作り直しの手順そのものが正しいこと：変えずに作り直せば、照合は通る
    await forge(original);
    await verifyDatabase(db, holidayTable);
  }, 120_000);

  const lastDay = DAYS.at(-1)!;
  /** 書き換えた記録そのもの（の種類）で、記録と再計算が食い違ったと止まる */
  const recorded = (type: string) => new RegExp(`^seq \\d+ \\(${type.replace(".", "\\.")}\\): recorded `);
  const cases: [string, () => LogEvent[], RegExp][] = [
    ["評価の合計を10（1円）増やす", () => edit((e) => e.type === "valuation.recorded" && p(e).agentId === "ai-hold" && p(e).date === lastDay, (x) => void ((x.total as number) += 10)), recorded("valuation.recorded")],
    ["評価の現金を10増やす", () => edit((e) => e.type === "valuation.recorded" && p(e).agentId === "noise" && p(e).date === DAYS[0], (x) => void ((x.cash as number) += 10)), recorded("valuation.recorded")],
    ["板寄せの価格を1段ずらす", () => edit((e) => e.type === "auction.cleared" && p(e).price !== null && p(e).date === DAYS[1], (x) => void ((x.price as number) += 10)), recorded("auction.cleared")],
    ["約定の株数を100増やす", () => edit((e) => e.type === "fills.executed" && (p(e).fills as { qty: number }[]).some((f) => f.qty > 0), (x) => void ((x.fills as { qty: number }[]).find((f) => f.qty > 0)!.qty += 100)), recorded("fills.executed")],
    // 配分の株数は検査の範囲内なので、配分そのものは通り、その参加者の次の約定か評価が、記録と再計算の食い違いで止まる
    ["最初の配分の株数を変える", () => edit((e) => e.type === "shares.allotted" && p(e).agentId === "noise", (x) => void ((x.qty as number) += 1)), /^seq \d+ \((fills\.executed|valuation\.recorded)\): recorded /],
    ["引け後の処理を1件抜き、番号と参照をすべて詰め直す", () => drop(original, (e) => e.type === "corporate_actions.applied" && p(e).agentId === "ai-ma5" && p(e).asOf === DAYS[0]), /^seq \d+ \(order_sheet\.committed\): account_not_ready$/],
    ["板寄せの結果を1件抜き、番号と参照をすべて詰め直す", () => drop(original, (e) => e === original.find((x) => x.type === "auction.cleared" && p(x).date === DAYS[1])), /^seq \d+ \(fills\.executed\): the listed symbols of the sheet are not auctioned yet$/],
    ["ある日の約定を1件抜き、番号と参照をすべて詰め直す", () => drop(original, (e) => e.type === "fills.executed" && p(e).agentId === "ai-hold" && p(e).tradingDate === DAYS[1]), /^seq \d+ \(valuation\.recorded\): the committed sheet is not filled yet$/],
  ];
  for (const [name, make, why] of cases) {
    it(`${name}と、照合が止まる（連鎖の誤りではなく、記録の中身で）`, async () => {
      try {
        await forge(make());
        const err = await verifyDatabase(db, holidayTable).then(
          () => null,
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        expect(err).not.toBeNull();
        expect(err).not.toMatch(/^chain:/);
        expect(err).toMatch(why);
      } finally {
        await forge(original);
      }
    }, 60_000);
  }

  it("ログの外に置いた判断の出力は、トリガを外しても表の制約が書き換えを断り、制約まで外して書き換えると照合が止まる", async () => {
    const run = original.find((e) => e.type === "agent.run" && p(e).ok === true)!;
    const tamper = () => pg.query("UPDATE stored_values SET content = to_jsonb($1::text) WHERE hash = $2", ['{"orders":[],"post":null,"note":"forged"}', p(run).outputHash]);
    await pg.exec("ALTER TABLE stored_values DISABLE TRIGGER USER;");
    try {
      await expect(tamper()).rejects.toThrow("check constraint");
      // 本文のハッシュを確かめる制約（定義に sha256 を含むもの）の名前を、表の定義から引く
      const { rows } = await pg.query<{ conname: string; def: string }>("SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'stored_values'::regclass AND contype = 'c'");
      const hashCheck = rows.filter((r) => r.def.includes("sha256"));
      expect(hashCheck.length).toBe(1);
      await pg.exec(`ALTER TABLE stored_values DROP CONSTRAINT "${hashCheck[0]!.conname}";`);
      await tamper();
      await expect(verifyDatabase(db, holidayTable)).rejects.toThrow("does not match its hash");
    } finally {
      await fresh();
      await runWaiting(DAYS);
      original = await readAllEvents(db);
    }
  }, 120_000);

  // 限界（指摘：低。宛先：lead）：末尾を消した記録や、何からも参照されない投稿を抜いて連鎖を作り直した記録は、連鎖も台帳も
  // 正しいので照合が通る。気づけるのは、前に外へ控えた最後のハッシュ・件数と比べたときだけ（verify は控えを受け取らない）
  for (const [name, make, kind] of [
    ["末尾の1日分を消す", () => original.slice(0, original.findIndex((e) => e.type === "agent.run" && e.recordedAt >= jst(lastDay, 0))), "prefix"],
    ["AIの投稿を1件抜き、番号と参照をすべて詰め直す", () => drop(original, (e) => e === original.find((x) => x.type === "post.published")), "rechained"],
  ] as const) {
    it(`${name}と、照合は通ってしまう（気づけるのは、外に控えた件数と最後のハッシュと比べたときだけ）`, async () => {
      const report = await verifyDatabase(db, holidayTable);
      try {
        await forge(make());
        const after = await verifyDatabase(db, holidayTable);
        expect(after.events).toBeLessThan(report.events);
        if (kind === "prefix") {
          // 末尾を消しただけの記録は、元の記録の途中までと同じ。最後のハッシュは、元の記録のその位置のハッシュと一致する
          expect(after.lastHash).toBe(original[after.events - 1]!.hash);
        } else {
          // 途中を抜いて詰め直した記録は、抜いた位置より後のハッシュがすべて変わり、元の記録のどのハッシュとも一致しない
          expect(original.map((e) => e.hash)).not.toContain(after.lastHash);
        }
      } finally {
        await forge(original);
      }
    }, 60_000);
  }
});
