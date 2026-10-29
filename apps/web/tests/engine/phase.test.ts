import { describe, expect, it } from "vitest";
import { acceptsOrders, createProgress, phaseAfter, type Progress, type Trigger } from "@/engine";
import { scenario } from "./fixtures";

const t = scenario.timing;
function step(p: Progress, trigger: Trigger) {
  const r = phaseAfter(p, trigger, t);
  if (!r.ok) throw new Error(`invalid: ${trigger.type} in ${p.phase}`);
  return r;
}

describe("状態機械", () => {
  it("自動進行：ニュース→受付→公開を5回繰り返し、最後に決算", () => {
    let p = step(createProgress(5), { type: "start", now: 0 }).progress;
    let now = 0;
    const effects: string[] = [];
    while (p.phase !== "RESULT") {
      now = p.phaseEndsAt! + (p.phase === "ORDER_OPEN" ? t.graceMs : 0);
      const r = step(p, { type: "tick", now });
      effects.push(...r.effects);
      p = r.progress;
    }
    expect(effects).toEqual(["clearRound", "clearRound", "clearRound", "clearRound", "clearRound", "settle"]);
    expect(p.round).toBe(5);
    expect(now).toBe(5 * (t.newsMs + t.orderMs + t.graceMs + t.publishMs));
  });

  it("締切＋猶予までは注文を受け付け、清算しない", () => {
    let p = step(createProgress(5), { type: "start", now: 0 }).progress;
    p = step(p, { type: "tick", now: t.newsMs }).progress;
    const deadline = p.phaseEndsAt!;
    expect(acceptsOrders(p, deadline + t.graceMs - 1, t)).toBe(true);
    expect(step(p, { type: "tick", now: deadline + t.graceMs - 1 }).changed).toBe(false);
    expect(acceptsOrders(p, deadline + t.graceMs, t)).toBe(false);
    expect(step(p, { type: "tick", now: deadline + t.graceMs }).effects).toEqual(["clearRound"]);
  });

  it("期限前のtickは何度呼んでも変化しない（冪等）", () => {
    const p = step(createProgress(5), { type: "start", now: 0 }).progress;
    for (let i = 0; i < 10; i++) {
      const r = step(p, { type: "tick", now: 100 });
      expect(r.changed).toBe(false);
      expect(r.progress).toBe(p);
    }
  });

  it("一時停止中は受け付けず、再開で残り時間を戻す", () => {
    let p = step(createProgress(5), { type: "start", now: 0 }).progress;
    p = step(p, { type: "tick", now: t.newsMs }).progress;
    p = step(p, { type: "pause", now: t.newsMs + 5_000 }).progress;
    expect(p.phase).toBe("PAUSED");
    expect(acceptsOrders(p, t.newsMs + 5_000, t)).toBe(false);
    expect(step(p, { type: "tick", now: 10 ** 9 }).changed).toBe(false);
    p = step(p, { type: "resume", now: 100_000 }).progress;
    expect(p.phase).toBe("ORDER_OPEN");
    expect(p.phaseEndsAt).toBe(100_000 + t.orderMs - 5_000);
  });

  it("早期締切・延長・中止", () => {
    let p = step(createProgress(5), { type: "start", now: 0 }).progress;
    expect(phaseAfter(p, { type: "closeNow", now: 1 }, t).ok).toBe(false);
    p = step(p, { type: "extend", now: 1, ms: 5_000 }).progress;
    expect(p.phaseEndsAt).toBe(t.newsMs + 5_000);
    p = step(p, { type: "next", now: 2 }).progress;
    expect(step(p, { type: "closeNow", now: 3 }).effects).toEqual(["clearRound"]);
    p = step(p, { type: "abort", now: 4 }).progress;
    expect(p.phase).toBe("ABORTED");
    expect(phaseAfter(p, { type: "abort", now: 5 }, t).ok).toBe(false);
  });

  it("手動モードでは期限で進まず、「次へ」だけで進む", () => {
    let p = step(createProgress(5, "manual"), { type: "start", now: 0 }).progress;
    expect(step(p, { type: "tick", now: 10 ** 9 }).changed).toBe(false);
    p = step(p, { type: "next", now: 1 }).progress;
    expect(p.phase).toBe("ORDER_OPEN");
    expect(acceptsOrders(p, 10 ** 9, t)).toBe(true);
  });
});
