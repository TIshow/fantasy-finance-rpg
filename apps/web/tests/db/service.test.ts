import { afterAll, afterEach, describe, expect, it } from "vitest";
import { generateNpcSheet, type OrderIntent } from "@/engine";
import { scenarioS01 } from "@/scenarios/s01/scenario";
import { prisma } from "@/server/db/client";
import { AppError } from "@/server/errors";
import { advance, cancelOrder, joinMatch, putOrder, testHooks, useInvestigation } from "@/server/service";
import { getState } from "@/server/state";
import { playGame } from "@/sim/play";
import { forceAdvance, host, ledger, newMatch, setDeadline } from "./helpers";

afterAll(async () => {
  await prisma.$disconnect();
});
afterEach(() => {
  delete testHooks.afterClearingWrites;
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}

/** ラウンドごとの決まった注文（DBとエンジンの結果の比較に使う） */
const plan: Record<number, OrderIntent[][]> = {
  1: [[{ guildId: "dragon", side: "buy", qty: 10 }], [{ guildId: "airship", side: "buy", qty: 10 }], [], [{ guildId: "alchemy", side: "buy", qty: 5 }], [], []],
  2: [[], [{ guildId: "airship", side: "sell", qty: 5 }], [{ guildId: "dragon", side: "buy", qty: 3 }], [], [], []],
  3: [[{ guildId: "dragon", side: "sell", qty: 10 }], [], [{ guildId: "dragon", side: "buy", qty: 10 }], [{ guildId: "dragon", side: "buy", qty: 10 }], [{ guildId: "academy", side: "buy", qty: 7 }], []],
  4: [[], [], [], [{ guildId: "dragon", side: "buy", qty: 10 }], [], [{ guildId: "dragon", side: "buy", qty: 10 }]],
  5: [[{ guildId: "dragon", side: "buy", qty: 10 }], [], [{ guildId: "dragon", side: "sell", qty: 10 }], [], [{ guildId: "dragon", side: "buy", qty: 10 }], []],
};

describe("1試合を最後まで（DB）", () => {
  it("6商会で5ラウンドを完走し、DBの結果がエンジンだけの結果と一致する", async () => {
    const m = await newMatch(6);
    const before = await ledger(m.matchId);
    await host(m.matchId, m.hostToken, "start");
    for (let round = 1; round <= 5; round++) {
      if (round > 1) expect((await forceAdvance(m.matchId)).phase).toBe("NEWS");
      expect((await forceAdvance(m.matchId)).phase).toBe("ORDER_OPEN");
      for (let t = 0; t < 6; t++) {
        for (const o of plan[round]![t]!) {
          await putOrder(m.matchId, m.tokens[t], round, o.guildId, { side: o.side, qty: o.qty, baseRevision: 0 });
        }
      }
      expect((await forceAdvance(m.matchId)).phase).toBe("PUBLISHED");
      const after = await ledger(m.matchId);
      expect(after.totalCash).toBe(before.totalCash);
      expect(Object.values(after.byGuild).every((v) => v === 0)).toBe(true);
      expect(after.negative).toBe(0);
    }
    expect((await forceAdvance(m.matchId)).phase).toBe("RESULT");

    const clearings = await prisma.roundClearing.findMany({ where: { matchId: m.matchId }, orderBy: { round: "asc" } });
    const sheet = generateNpcSheet(scenarioS01, { k: 2, seed: 20261029 });
    const engineRun = playGame({
      scenario: scenarioS01,
      sheet,
      teamIds: ["a", "b", "c", "d", "e", "f"],
      strategy: ({ round, teamId }) => ({ orders: plan[round]!["abcdef".indexOf(teamId)]! }),
    });
    expect(clearings.map((c) => c.prices)).toEqual(engineRun.prices.slice(1));

    const final = await ledger(m.matchId);
    expect(final.totalCash).toBe(before.totalCash);
    const match = await prisma.match.findUniqueOrThrow({ where: { id: m.matchId } });
    expect(match.settledAt).not.toBeNull();
    const mm = await prisma.account.findFirstOrThrow({ where: { matchId: m.matchId, kind: "mm" } });
    expect(mm.cash).toBeGreaterThanOrEqual(0);

    const state = await getState(m.matchId, m.tokens[0]);
    expect(state.public.scenario.winner).toBe("dragon");
    expect(state.public.ranking).toHaveLength(6);
    expect(state.own!.allFills!.length).toBeGreaterThan(0);
  });
});

describe("注文", () => {
  it("締切直前に6商会が同時に注文しても、すべて1回の清算に入る", async () => {
    const m = await newMatch(6);
    await host(m.matchId, m.hostToken, "start");
    await forceAdvance(m.matchId);
    await setDeadline(m.matchId, 200);
    const results = await Promise.all(
      m.tokens.map((tok) => putOrder(m.matchId, tok, 1, "dragon", { side: "buy", qty: 10, baseRevision: 0 })),
    );
    expect(results.every((r) => r.revision === 1)).toBe(true);
    await forceAdvance(m.matchId);
    const fills = await prisma.fill.findMany({ where: { matchId: m.matchId, kind: "player" } });
    expect(fills).toHaveLength(6);
    expect(fills.every((f) => f.filled === 10)).toBe(true);
  });

  it("締切＋猶予（1秒）までは受け付け、それを過ぎると拒否する", async () => {
    const m = await newMatch(1);
    await host(m.matchId, m.hostToken, "start");
    await forceAdvance(m.matchId);
    await setDeadline(m.matchId, -500);
    expect(await code(putOrder(m.matchId, m.tokens[0], 1, "dragon", { side: "buy", qty: 1, baseRevision: 0 }))).toBe("ok");
    expect((await advance(m.matchId, { kind: "tick" })).changed).toBe(false);
    await setDeadline(m.matchId, -1500);
    expect(await code(putOrder(m.matchId, m.tokens[0], 1, "airship", { side: "buy", qty: 1, baseRevision: 0 }))).toBe("order_window_closed");
    expect((await advance(m.matchId, { kind: "tick" })).phase).toBe("PUBLISHED");
    expect(await code(putOrder(m.matchId, m.tokens[0], 1, "academy", { side: "buy", qty: 1, baseRevision: 0 }))).toBe("order_window_closed");
  });

  it("同じ注文の再送は同じ結果を返し、古い版番号での上書きは拒否する", async () => {
    const m = await newMatch(1);
    await host(m.matchId, m.hostToken, "start");
    await forceAdvance(m.matchId);
    const put = (qty: number, baseRevision: number) => putOrder(m.matchId, m.tokens[0], 1, "dragon", { side: "buy", qty, baseRevision });
    expect((await put(5, 0)).revision).toBe(1);
    expect((await put(5, 0)).revision).toBe(1); // 再送
    expect(await code(put(7, 0))).toBe("stale_revision"); // 古い画面からの上書き
    expect((await put(7, 1)).revision).toBe(2);
    expect((await cancelOrder(m.matchId, m.tokens[0], 1, "dragon", 2)).status).toBe("cancelled");
    expect((await cancelOrder(m.matchId, m.tokens[0], 1, "dragon", 2)).revision).toBe(3); // 取消の再送
    const orders = await prisma.order.findMany({ where: { matchId: m.matchId } });
    expect(orders).toHaveLength(1);
    await forceAdvance(m.matchId);
    expect(await prisma.fill.count({ where: { matchId: m.matchId, kind: "player" } })).toBe(0);
  });

  it("残高不足・保有不足・他の商会のトークンを拒否する", async () => {
    const m = await newMatch(2);
    await host(m.matchId, m.hostToken, "start");
    await forceAdvance(m.matchId);
    expect(await code(putOrder(m.matchId, m.tokens[0], 1, "dragon", { side: "sell", qty: 1, baseRevision: 0 }))).toBe("insufficient_holdings");
    expect(await code(putOrder(m.matchId, m.tokens[0], 1, "alchemy", { side: "buy", qty: 10, baseRevision: 0 }))).toBe("ok");
    expect(await code(putOrder(m.matchId, m.tokens[0], 1, "airship", { side: "buy", qty: 10, baseRevision: 0 }))).toBe("ok");
    // 予約済み 510G＋420G。残り70Gでは魔法学校10口（23G×10）を予約できない
    expect(await code(putOrder(m.matchId, m.tokens[0], 1, "academy", { side: "buy", qty: 10, baseRevision: 0 }))).toBe("insufficient_cash");
    expect(await code(putOrder(m.matchId, "not-a-token", 1, "dragon", { side: "buy", qty: 1, baseRevision: 0 }))).toBe("unauthorized");
    const other = await newMatch(1);
    expect(await code(putOrder(m.matchId, other.tokens[0], 1, "dragon", { side: "buy", qty: 1, baseRevision: 0 }))).toBe("unauthorized");
  });

  it("一時停止中は受け付けず、再開で残り時間を戻す", async () => {
    const m = await newMatch(1);
    await host(m.matchId, m.hostToken, "start");
    await forceAdvance(m.matchId);
    await host(m.matchId, m.hostToken, "pause");
    expect(await code(putOrder(m.matchId, m.tokens[0], 1, "dragon", { side: "buy", qty: 1, baseRevision: 0 }))).toBe("order_window_closed");
    expect((await advance(m.matchId, { kind: "tick" })).changed).toBe(false);
    await host(m.matchId, m.hostToken, "resume");
    expect(await code(putOrder(m.matchId, m.tokens[0], 1, "dragon", { side: "buy", qty: 1, baseRevision: 0 }))).toBe("ok");
  });
});

describe("締切処理と決算", () => {
  it("締切処理を同時に10回送っても、清算は1回だけ", async () => {
    const m = await newMatch(3);
    await host(m.matchId, m.hostToken, "start");
    await forceAdvance(m.matchId);
    for (const tok of m.tokens) await putOrder(m.matchId, tok, 1, "dragon", { side: "buy", qty: 4, baseRevision: 0 });
    const before = await prisma.match.findUniqueOrThrow({ where: { id: m.matchId } });
    await setDeadline(m.matchId, -2000);
    const results = await Promise.all(Array.from({ length: 10 }, () => advance(m.matchId, { kind: "tick" })));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await prisma.roundClearing.count({ where: { matchId: m.matchId } })).toBe(1);
    expect(await prisma.fill.count({ where: { matchId: m.matchId, kind: "player" } })).toBe(3);
    const after = await prisma.match.findUniqueOrThrow({ where: { id: m.matchId } });
    expect(after.version).toBe(before.version + 1);
  });

  it("清算の途中で失敗しても、部分的な書き込みは残らない", async () => {
    const m = await newMatch(2);
    await host(m.matchId, m.hostToken, "start");
    await forceAdvance(m.matchId);
    await putOrder(m.matchId, m.tokens[0], 1, "dragon", { side: "buy", qty: 10, baseRevision: 0 });
    const before = await ledger(m.matchId);
    const cashBefore = await prisma.account.findMany({ where: { matchId: m.matchId }, select: { id: true, cash: true }, orderBy: { id: "asc" } });
    testHooks.afterClearingWrites = () => {
      throw new Error("simulated crash");
    };
    await setDeadline(m.matchId, -2000);
    await expect(advance(m.matchId, { kind: "tick" })).rejects.toThrow("simulated crash");
    expect(await prisma.fill.count({ where: { matchId: m.matchId } })).toBe(0);
    expect(await prisma.roundClearing.count({ where: { matchId: m.matchId } })).toBe(0);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: m.matchId } })).phase).toBe("ORDER_OPEN");
    expect(await prisma.account.findMany({ where: { matchId: m.matchId }, select: { id: true, cash: true }, orderBy: { id: "asc" } })).toEqual(cashBefore);
    expect(await ledger(m.matchId)).toEqual(before);
    delete testHooks.afterClearingWrites;
    expect((await advance(m.matchId, { kind: "tick" })).phase).toBe("PUBLISHED");
    expect(await prisma.roundClearing.count({ where: { matchId: m.matchId } })).toBe(1);
  });

  it("決算は1回だけ。結果発表のあとは進まない", async () => {
    const m = await newMatch(1);
    await host(m.matchId, m.hostToken, "start");
    await forceAdvance(m.matchId);
    await putOrder(m.matchId, m.tokens[0], 1, "dragon", { side: "buy", qty: 10, baseRevision: 0 });
    for (let i = 0; i < 13; i++) await forceAdvance(m.matchId); // R1公開 → … → R5公開
    expect((await forceAdvance(m.matchId)).phase).toBe("RESULT");
    const team = await prisma.account.findFirstOrThrow({ where: { matchId: m.matchId, kind: "player" } });
    expect((await forceAdvance(m.matchId)).changed).toBe(false);
    expect(await code(host(m.matchId, m.hostToken, "next"))).toBe("invalid_transition");
    const again = await prisma.account.findFirstOrThrow({ where: { matchId: m.matchId, kind: "player" } });
    expect(again.cash).toBe(team.cash);
    expect(await prisma.matchEvent.count({ where: { matchId: m.matchId, type: "settle" } })).toBe(1);
  });

  it("運営操作には運営のトークンが要る", async () => {
    const m = await newMatch(1);
    expect(await code(advance(m.matchId, { kind: "host", action: "start", token: "wrong" }))).toBe("unauthorized");
    expect(await code(advance(m.matchId, { kind: "host", action: "start", token: undefined }))).toBe("unauthorized");
    expect((await host(m.matchId, m.hostToken, "start")).phase).toBe("NEWS");
  });
});

describe("公開の同時性", () => {
  it("公開時刻の前は新価格も自分の約定も見せず、過ぎたら一斉に見せる", async () => {
    const m = await newMatch(1);
    await host(m.matchId, m.hostToken, "start");
    await forceAdvance(m.matchId);
    await putOrder(m.matchId, m.tokens[0], 1, "dragon", { side: "buy", qty: 10, baseRevision: 0 });
    await forceAdvance(m.matchId);
    const before = await getState(m.matchId, m.tokens[0]);
    expect(before.public.phase).toBe("PUBLISHED");
    expect(before.public.pendingReveal).not.toBeNull();
    expect(before.public.prices).toEqual(scenarioS01.initialPrices);
    expect(before.public.lastClearing).toBeNull();
    expect(before.public.ranking).toBeNull();
    expect(before.own!.cash).toBe(1000);
    expect(before.own!.positions.dragon!.qty).toBe(0);
    expect(before.own!.lastFills).toHaveLength(0);
    await prisma.$executeRaw`UPDATE matches SET reveal_at = clock_timestamp() - interval '1 second' WHERE id = ${m.matchId}::uuid`;
    const after = await getState(m.matchId, m.tokens[0]);
    expect(after.public.pendingReveal).toBeNull();
    expect(after.public.prices).toEqual(before.public.pendingReveal!.prices);
    expect(after.own!.positions.dragon!.qty).toBe(10);
    expect(after.own!.lastFills[0]).toMatchObject({ guildId: "dragon", filled: 10 });
    expect(after.public.ranking).toHaveLength(1);
  });
});

describe("参加と調査券", () => {
  it("同じ商会名、開始後の参加、定員超えを拒否する", async () => {
    const m = await newMatch(1);
    expect(await code(joinMatch(m.joinCode, "商会1"))).toBe("nickname_taken");
    expect(await code(joinMatch("000000", "誰か"))).toMatch(/match_not_found|ok/);
    await prisma.match.update({ where: { id: m.matchId }, data: { capacity: 2 } });
    expect(await code(joinMatch(m.joinCode, "商会2"))).toBe("ok");
    expect(await code(joinMatch(m.joinCode, "商会3"))).toBe("match_full");
    await host(m.matchId, m.hostToken, "start");
    await prisma.match.update({ where: { id: m.matchId }, data: { capacity: 12 } });
    expect(await code(joinMatch(m.joinCode, "商会4"))).toBe("match_started");
  });

  it("調査券は窓のあるラウンドで1回だけ。同時に2回送っても1回分", async () => {
    const m = await newMatch(1);
    await host(m.matchId, m.hostToken, "start");
    await forceAdvance(m.matchId);
    expect(await code(useInvestigation(m.matchId, m.tokens[0], "official"))).toBe("no_investigation_window");
    for (let i = 0; i < 6; i++) await forceAdvance(m.matchId); // R3の受付へ
    const m3 = await prisma.match.findUniqueOrThrow({ where: { id: m.matchId } });
    expect([m3.phase, m3.round]).toEqual(["ORDER_OPEN", 3]);
    const results = await Promise.all([
      code(useInvestigation(m.matchId, m.tokens[0], "official")),
      code(useInvestigation(m.matchId, m.tokens[0], "ai")),
    ]);
    expect(results.sort()).toEqual(["investigation_used", "ok"]);
    const state = await getState(m.matchId, m.tokens[0]);
    expect(state.own!.investigation!.round).toBe(3);
  });
});
