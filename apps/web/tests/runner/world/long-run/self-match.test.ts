// 自己約定を数える関数（selfMatches）が、同じ参加者の同じ日・同じ銘柄の売りと買いの約定を見つけること
import { describe, expect, it } from "vitest";
import type { LogEvent } from "../../../../src/events/types";
import { selfMatches } from "./run";

const fills = (agentId: string, tradingDate: string, fs: { symbol: string; side: string; qty: number }[]) => ({ type: "fills.executed", payload: { agentId, tradingDate, fills: fs } }) as unknown as LogEvent;

describe("selfMatches", () => {
  it("売りと買いの両方が約定した銘柄だけを数える（0株の約定や、別の銘柄・別の参加者は数えない）", () => {
    expect(
      selfMatches([
        fills("mm-a", "2026-11-02", [{ symbol: "A", side: "sell", qty: 300 }, { symbol: "A", side: "buy", qty: 300 }]),
        fills("mm-b", "2026-11-02", [{ symbol: "B", side: "sell", qty: 300 }, { symbol: "B", side: "buy", qty: 0 }]),
        fills("noise", "2026-11-02", [{ symbol: "A", side: "sell", qty: 100 }, { symbol: "B", side: "buy", qty: 100 }]),
      ]),
    ).toEqual(["mm-a 2026-11-02 A"]);
  });
});
