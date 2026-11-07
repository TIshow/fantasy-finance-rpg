// 画面のデータの出どころ：DATABASE_URL がなければ固定データ、あれば読むだけの口（pg-reader）から。口は差し替えて確かめる。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEvent } from "../../src/events/types";
import type { Account } from "../../src/ledger/types";

const reader = vi.hoisted(() => ({ readSnapshotFromEnv: vi.fn() }));
vi.mock("../../src/store/pg-reader", () => reader);
const golden = vi.hoisted(() => ({ spy: vi.fn() }));
vi.mock("../fixtures/golden", async (importOriginal) => {
  const m = await importOriginal<typeof import("../fixtures/golden")>();
  return { ...m, buildGoldenLog: (...a: Parameters<typeof m.buildGoldenLog>) => (golden.spy(), m.buildGoldenLog(...a)) };
});

import { loadSource } from "../../src/app/data";
import { buildGoldenLog } from "../fixtures/golden";

const acct = (cash: number): Account => ({ cash, holdings: {} }) as unknown as Account;

describe("画面のデータの出どころ", () => {
  beforeEach(() => {
    reader.readSnapshotFromEnv.mockReset();
    golden.spy.mockReset();
  });

  it("DATABASE_URL がなければ（空文字も）固定データを使い、データベースには触れない", async () => {
    for (const env of [{}, { DATABASE_URL: "" }, { VERCEL_ENV: "preview" }]) {
      const s = await loadSource(env);
      expect(s.view.agents.map((a) => a.agentId)).toEqual(["ai-a", "ai-b", "ai-c"]);
      expect(s.accounts.size).toBe(3);
    }
    expect(reader.readSnapshotFromEnv).not.toHaveBeenCalled();
  });

  it("公開（production）で DATABASE_URL がなければ、固定データに逃げずに例外にする", async () => {
    for (const env of [{ VERCEL_ENV: "production" }, { VERCEL_ENV: "production", DATABASE_URL: "" }]) {
      const err = await loadSource(env).catch((e: unknown) => e);
      expect((err as Error).message).toContain("DATABASE_URL is required");
    }
    expect(golden.spy).not.toHaveBeenCalled();
    expect(reader.readSnapshotFromEnv).not.toHaveBeenCalled();
  });

  it("DATABASE_URL があれば口から読み、本文を引け、AI投資家だけを出す", async () => {
    const g = await buildGoldenLog(20261104);
    golden.spy.mockReset(); // 試験自身が組み立てた分は数えない
    const last = g.events.at(-1)!;
    const mm = { ...last, seq: last.seq + 1, type: "agent.registered", payload: { agentId: "mm-1", displayName: "MM", kind: "market_maker", initialCash: 1 } } as unknown as LogEvent;
    reader.readSnapshotFromEnv.mockResolvedValue({
      events: [...g.events, mm],
      bodyOf: (h: string) => g.bodies.get(h)?.value,
      accounts: new Map([["ai-a", acct(1)], ["mm-1", acct(2)]]),
      kinds: new Map([["ai-a", "investor"], ["mm-1", "market_maker"]]),
      lastHash: null,
    });
    const env = { DATABASE_URL: "postgres://x" };
    const s = await loadSource(env);
    expect(reader.readSnapshotFromEnv).toHaveBeenCalledWith(env);
    expect(golden.spy).not.toHaveBeenCalled();
    expect([...s.accounts.keys()]).toEqual(["ai-a"]);
    expect(s.view.agents.map((a) => a.agentId)).not.toContain("mm-1");
    const posts = s.view.timeline.filter((t) => t.kind === "post");
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) if (p.kind === "post") expect(p.text).toContain("（架空のデータ）");
  });

  it("DB が読めないときは、固定データに逃げずに例外を返す", async () => {
    reader.readSnapshotFromEnv.mockImplementation(async () => {
      throw new Error("boom");
    });
    await expect(loadSource({ DATABASE_URL: "postgres://x" })).rejects.toThrow("boom");
    expect(golden.spy).not.toHaveBeenCalled();
  });
});
