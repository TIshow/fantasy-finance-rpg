// src/contracts の型の使い方の例と、メモリ上の偽物が契約を満たすことの確認。
// 契約を満たすことの確認は conformance.ts にあり、platform は自分の実装を渡して同じテストを当てられる。
// ここには、実装によらない型だけの確認と、偽物にだけ要る確認を置く。
import { describe, expect, it } from "vitest";
import type { Clock, DraftInput, EventReader, EventStore, OrderlessEventStore, PriceObservation } from "../../src/contracts";
import { EventLog } from "../../src/events/append";
import { newAccount } from "../../src/ledger/ledger";
import { describeEventStoreContract, describeLlmContract, describeMarketDataContract } from "./conformance";
import { FakeClock, FakeLlm, MemoryEventStore, MemoryMarketData, jst, jstDay } from "./fakes";

describeEventStoreContract("MemoryEventStore", (env) => new MemoryEventStore(new EventLog({ holidayTables: env.holidayTables, accountOf: () => newAccount() }), env.clock));
describeMarketDataContract("MemoryMarketData", (observations, clock) => new MemoryMarketData(observations, clock));
describeLlmContract("FakeLlm", (policy, clock, backend) => new FakeLlm(policy, clock, backend));

describe("Clock", () => {
  it("UNIXミリ秒の整数を返し、recordedAt にそのまま使える", () => {
    const clock: Clock = new FakeClock(jst("2026-11-10", 9));
    expect(Number.isSafeInteger(clock.now())).toBe(true);
    expect(jstDay(clock.now())).toBe("2026-11-10");
  });
});

describe("型の確認（実装によらない）", () => {
  const store = {} as EventStore;

  it("DraftInput に recordedAt は渡せない（時刻は保管が決める）", () => {
    // @ts-expect-error recordedAt は DraftInput にない
    const forged: DraftInput = { type: "source.captured", actor: "system", refs: [], payload: {}, recordedAt: 1 };
    void forged;
  });

  it("DraftInput に注文票の type は渡せない（commitSheet からだけ書ける）", () => {
    // @ts-expect-error order_sheet.committed は DraftInput の type から除かれている
    const a: DraftInput = { type: "order_sheet.committed", actor: "agent:ai-a", refs: [], payload: {} };
    // @ts-expect-error order_sheet.rejected も同じ
    const b: DraftInput = { type: "order_sheet.rejected", actor: "system", refs: [], payload: {} };
    void [a, b];
  });

  it("EventStore に更新・削除の口はなく、EventReader に追記の口はない", () => {
    // @ts-expect-error 削除の口は契約にない
    void store.delete;
    // @ts-expect-error 更新の口は契約にない
    void store.update;
    const reader: EventReader = store;
    // @ts-expect-error EventReader に append はない
    void reader.append;
  });

  it("OrderlessEventStore は commitSheet を型に持つ口を持たない（保証ではなく便宜。契約のコメントを見る）", () => {
    const orderless: OrderlessEventStore = store;
    // @ts-expect-error OrderlessEventStore に commitSheet はない
    void orderless.commitSheet;
  });

  it("始値の観測に出来高は載せられない", () => {
    // @ts-expect-error 始値の観測に出来高は載せられない
    const bad: PriceObservation = { symbol: "TSTA", date: "2026-11-11", kind: "open", price: 1, volume: 1000, publishedAt: 1, fetchedAt: 2, source: "x" };
    void bad;
    const good: PriceObservation = { symbol: "TSTA", date: "2026-11-11", kind: "close", price: 1, volume: 1000, publishedAt: 1, fetchedAt: 2, source: "x" };
    void good;
  });
});
