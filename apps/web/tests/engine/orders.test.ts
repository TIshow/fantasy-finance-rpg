import { describe, expect, it } from "vitest";
import { reserveUnitPrice, validateOrder, type Account, type RoundOrder } from "@/engine";

const guilds = ["airship", "dragon"];
const prices = { airship: 60, dragon: 40 };
const account = (cash: number, dragon = 0): Account => ({
  id: "team:a",
  kind: "player",
  cash,
  positions: { airship: { qty: 0, costBasis: 0 }, dragon: { qty: dragon, costBasis: dragon * 20 } },
});
const validate = (acct: Account, intent: RoundOrder | { guildId: string; side: "buy" | "sell"; qty: number }, open: RoundOrder[] = []) =>
  validateOrder({ account: acct, openOrders: open, intent, prices, guilds, orderCap: 10 });

describe("予約", () => {
  it("買いの予約単価は min(99, ceil(価格×1.5))", () => {
    expect(reserveUnitPrice(30)).toBe(45);
    expect(reserveUnitPrice(9)).toBe(14);
    expect(reserveUnitPrice(66)).toBe(99);
    expect(reserveUnitPrice(97)).toBe(99);
  });

  it("口数は1〜上限の整数だけ", () => {
    expect(validate(account(1000), { guildId: "dragon", side: "buy", qty: 0 })).toEqual({ ok: false, reason: "invalid_qty" });
    expect(validate(account(1000), { guildId: "dragon", side: "buy", qty: 11 })).toEqual({ ok: false, reason: "invalid_qty" });
    expect(validate(account(1000), { guildId: "dragon", side: "buy", qty: 1.5 })).toEqual({ ok: false, reason: "invalid_qty" });
    expect(validate(account(1000), { guildId: "unknown", side: "buy", qty: 1 })).toEqual({ ok: false, reason: "unknown_guild" });
  });

  it("売買の向きは buy と sell だけ。受け取った余計な項目は注文に持ち込まない", () => {
    const short = { guildId: "dragon", side: "short", qty: 1 } as unknown as RoundOrder;
    expect(validate(account(1000, 3), short)).toEqual({ ok: false, reason: "invalid_side" });
    const forged = { guildId: "dragon", side: "buy", qty: 1, accountId: "mm", kind: "npc", reserveCash: 0, extra: 1 };
    const r = validate(account(1000), forged as RoundOrder);
    expect(r.ok && r.order).toEqual({ accountId: "team:a", kind: "player", guildId: "dragon", side: "buy", qty: 1, reserveCash: 60 });
  });

  it("使える現金は、他の枠の予約額を引いた残り", () => {
    const first = validate(account(1000), { guildId: "airship", side: "buy", qty: 10 });
    expect(first.ok && first.order.reserveCash).toBe(900);
    const open = first.ok ? [first.order] : [];
    expect(validate(account(1000), { guildId: "dragon", side: "buy", qty: 2 }, open)).toEqual({ ok: false, reason: "insufficient_cash" });
    expect(validate(account(1000), { guildId: "dragon", side: "buy", qty: 1 }, open).ok).toBe(true);
    // 同じギルドの枠は置き換えなので、自分自身の予約額は差し引かない
    expect(validate(account(1000), { guildId: "airship", side: "buy", qty: 10 }, open).ok).toBe(true);
  });

  it("売りは保有口数まで。予約額は0", () => {
    expect(validate(account(0, 3), { guildId: "dragon", side: "sell", qty: 4 })).toEqual({ ok: false, reason: "insufficient_holdings" });
    const ok = validate(account(0, 3), { guildId: "dragon", side: "sell", qty: 3 });
    expect(ok.ok && ok.order.reserveCash).toBe(0);
  });
});
