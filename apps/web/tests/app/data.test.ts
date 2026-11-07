// 画面のデータの出どころ：DATABASE_URL がなければ固定データ、あれば読むだけの口（pg-reader）から。口は差し替えて確かめる。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../../src/ledger/types";

const reader = vi.hoisted(() => ({ readSnapshotFromEnv: vi.fn() }));
vi.mock("../../src/store/pg-reader", () => reader);

import { loadSource } from "../../src/app/data";
import { buildGoldenLog } from "../fixtures/golden";

const acct = (cash: number): Account => ({ cash, holdings: {} }) as unknown as Account;

describe("画面のデータの出どころ", () => {
  beforeEach(() => reader.readSnapshotFromEnv.mockReset());

  it("DATABASE_URL がなければ（空文字も）固定データを使い、データベースには触れない", async () => {
    for (const env of [{}, { DATABASE_URL: "" }]) {
      const s = await loadSource(env);
      expect(s.view.agents.map((a) => a.agentId)).toEqual(["ai-a", "ai-b", "ai-c"]);
      expect(s.accounts.size).toBe(3);
    }
    expect(reader.readSnapshotFromEnv).not.toHaveBeenCalled();
  });

  it("DATABASE_URL があれば口から読み、口座は AI投資家のものだけにする", async () => {
    const g = await buildGoldenLog(20261104);
    reader.readSnapshotFromEnv.mockResolvedValue({
      events: g.events,
      bodyOf: (h: string) => g.bodies.get(h)?.value,
      accounts: new Map([["ai-a", acct(1)], ["mm-1", acct(2)]]),
      kinds: new Map([["ai-a", "investor"], ["mm-1", "market_maker"]]),
      lastHash: null,
    });
    const env = { DATABASE_URL: "postgres://x" };
    const s = await loadSource(env);
    expect(reader.readSnapshotFromEnv).toHaveBeenCalledWith(env);
    expect([...s.accounts.keys()]).toEqual(["ai-a"]);
    expect(s.view.timeline.length).toBeGreaterThan(0);
  });
});
