// 毎日の実行の依頼の段（16:35。#179）の試験。本物の API は呼ばない（偽の提供元）。
import { describe, expect, it } from "vitest";
import { verifyChain } from "../../src/events/chain";
import { llmCostUsed } from "../../src/events/llm-cost";
import { replay } from "../../src/events/replay";
import { INVESTOR_PROMPT_VERSION } from "../../src/llm/investor-prompt";
import { jst } from "../contracts/fakes";
import { llmFailed } from "../../scripts/daily-lib";
import { errorText } from "../../src/runner/llm-stage";
import type { StageResult } from "../../src/runner/day";
import { DAYS, LLM_IDS, llmWorld, p } from "./llm-world";

const submitOf = (results: StageResult[]) => results.find((r) => r.stage === "llm.submit");

describe("依頼の段（前の営業日の引けのあと）", async () => {
  const w = await llmWorld();
  const results = await w.run(DAYS[0]!);
  const subs = await w.of("llm.batch.submitted");

  it("引けのあとに、3体の依頼を、次の営業日の分として予約し（①）、送り、バッチのIDを記録する（③）", async () => {
    expect(submitOf(results)).toMatchObject({ status: "written" });
    expect(subs.map((e) => [p(e).agentId, p(e).tradingDate, p(e).promptVersion])).toEqual(LLM_IDS.map((id) => [id, DAYS[1], INVESTOR_PROMPT_VERSION]));
    expect(subs.map((e) => p(e).provider)).toEqual(["anthropic", "openai", "google"]);
    const sent = await w.of("llm.batch.sent");
    expect(sent.map((e) => p(e).batchSeq)).toEqual(subs.map((e) => e.seq));
    // 予約は Claude 6.4円・GPT 22.4円・Gemini 3.6円（3体で32.4円）
    expect(subs.map((e) => p(e).maxCost)).toEqual([64, 224, 36]);
    expect(llmCostUsed(await w.all(), "2026-11-09")).toBe(324);
  });

  it("3体に同じ指示の文と同じ入力の文を送る（違うのはモデルとAIのID）。入力は依頼より前の記録だけで、上場した6銘柄の値段・決算と口座を含む", async () => {
    const bodies = Object.values(w.llm.providers).map((f) => JSON.parse(f.sent[0]!) as { messages: { role: string; content: string }[] });
    expect(bodies).toHaveLength(3);
    const users = bodies.map((b) => b.messages[1]!.content.replace(/^あなた：.*$/m, ""));
    expect(new Set(users).size).toBe(1);
    expect(new Set(bodies.map((b) => b.messages[0]!.content)).size).toBe(1);
    for (const s of ["VRN1", "ORS1", "MRH1", "SLN1", "QON1", "LPO1"]) expect(users[0]).toContain(`## ${s} `);
    expect(users[0]).toContain(`取引日：${DAYS[1]}`);
    expect(users[0]).toContain("現金：10000000円");
    expect(users[0]).toMatch(/\n11\/09,\d+,\d+\n/); // 依頼した日の板寄せ
  });

  it("記録は連鎖と照合を通る。同じ日を回し直しても、二重に依頼しない", async () => {
    expect(await verifyChain(await w.all())).toEqual([]);
    await replay(await w.all(), w.values, { holidayTables: w.holidayTables });
    const again = await w.run(DAYS[0]!);
    expect(submitOf(again)).toMatchObject({ status: "done" });
    expect(await w.of("llm.batch.submitted")).toHaveLength(3);
    expect(Object.values(w.llm.providers).map((f) => f.sent.length)).toEqual([1, 1, 1]);
  });

  it("引けの取り込み（16:30）より前は依頼しない（板寄せのあとの 9:35 の実行で引け後の処理が済んでも、大引けのあとの決算を待つ）", async () => {
    const m = await llmWorld(undefined, { manualClock: true });
    await m.runAt(DAYS[0]!, 6, 50);
    const morning = await m.runAt(DAYS[0]!, 9, 35);
    expect((await m.of("corporate_actions.applied")).some((e) => p(e).asOf === DAYS[0])).toBe(true);
    expect(submitOf(morning)).toMatchObject({ status: "skipped", detail: `before the close of ${DAYS[0]}` });
    expect(submitOf(await m.runAt(DAYS[0]!, 16, 35))).toMatchObject({ status: "written" });
    expect((await m.of("llm.batch.submitted")).every((e) => e.recordedAt === jst(DAYS[0]!, 16, 35))).toBe(true);
  });

  it("締めの前の晩でなければ依頼しない（古い日を回し直したとき）", async () => {
    w.clock.set(jst(DAYS[1]!, 10));
    expect(submitOf(await w.run(DAYS[0]!))).toMatchObject({ status: "skipped" });
  });
});

describe("例外の文", () => {
  it("キーらしい文字列を伏せる", () => {
    const t = errorText(new Error("bad key sk-ant-api03-abcdefghijklmnop and AIzaSyA1234567890abcdefghij, Authorization: Bearer abc.def-ghijk key=0123456789abcdef"));
    expect(t).toBe("bad key [redacted] and [redacted], Authorization: Bearer [redacted] key=[redacted]");
    expect(errorText(new Error("hash 0123abcd short sk-1"))).toBe("hash 0123abcd short sk-1");
  });
});

describe("依頼の段：上限・送れなかったとき", () => {
  it("1日の上限（policy）を超える予約は、送らずに agent.run の失敗（budget_exceeded・費用0）を残す", async () => {
    const w = await llmWorld({ dailyCostLimit: 100, dryRun: false });
    const r = submitOf(await w.run(DAYS[0]!));
    expect(r).toMatchObject({ status: "written" });
    // Claude（6.4円）は収まり、GPT（22.4円）は 6.4+22.4 > 10円 で断られ、Gemini（3.6円）は収まる
    expect((await w.of("llm.batch.submitted")).map((e) => p(e).agentId)).toEqual(["ai-claude", "ai-gemini"]);
    const runs = await w.of("agent.run");
    const gpt = runs.filter((e) => p(e).agentId === "ai-gpt");
    expect(gpt.map((e) => [p(e).ok, p(e).errorCode, p(e).cost, p(e).maxCost])).toEqual([[false, "budget_exceeded", 0, 224]]);
    expect(w.llm.providers.openai!.sent).toEqual([]);
    // 回し直しても、同じ budget_exceeded を二重に書かない
    w.clock.set(w.clock.now() + 60_000);
    await w.run(DAYS[0]!);
    expect((await w.of("agent.run")).filter((e) => p(e).agentId === "ai-gpt")).toHaveLength(1);
  });

  it("3体の予約の合計が目標（80円）を超える設定なら、どのAIも依頼せず、段を失敗（error:）にする", async () => {
    const w = await llmWorld();
    w.deps.llm = { ...w.deps.llm!, yenPerUsd: 400 };
    const r = submitOf(await w.run(DAYS[0]!));
    expect(r).toMatchObject({ status: "skipped", detail: expect.stringMatching(/^error: the daily reservations \(\d+\) exceed the target \(800\)$/) });
    expect(llmFailed([r!])).toBe(true);
    expect(await w.of("llm.batch.submitted")).toEqual([]);
  });

  it("1体で例外が出ても、ほかのAIは依頼する。段は失敗（error:）で、例外の文は1行・200文字までにする", async () => {
    const w = await llmWorld();
    const orig = w.deps.llm!.portOf;
    w.deps.llm = { ...w.deps.llm!, portOf: (provider, clock) => (provider === "openai" ? (() => { throw new Error(`boom\r\nline2\u0085${"x".repeat(300)}`); })() : orig(provider, clock)) };
    const results = await w.run(DAYS[0]!);
    const r = submitOf(results)!;
    expect(r).toMatchObject({ status: "written" });
    expect(r.detail).toMatch(/^error: ai-gpt: boom line2 x+…$/);
    expect(r.detail!.length).toBeLessThan(230);
    expect(llmFailed(results)).toBe(true);
    expect((await w.of("llm.batch.sent")).map((e) => p(e).agentId)).toEqual(["ai-claude", "ai-gemini"]);
  });

  it("作られていないと確か（notCreated）なら費用0で閉じ、失敗の run を残す。分からない（billingUnknown）なら①だけ残す", async () => {
    const w = await llmWorld();
    w.llm.providers.openai!.send = () => ({ ok: false, errorCode: "rate_limited", notCreated: true });
    w.llm.providers.google!.send = () => ({ ok: false, errorCode: "timeout", billingUnknown: true });
    await w.run(DAYS[0]!);
    const closed = await w.of("llm.batch.closed");
    expect(closed.map((e) => [p(e).agentId, p(e).result, p(e).cost, p(e).notCreatedError])).toEqual([["ai-gpt", "failed", 0, "rate_limited"]]);
    expect((await w.of("agent.run")).filter((e) => LLM_IDS.includes(p(e).agentId as string)).map((e) => [p(e).agentId, p(e).errorCode])).toEqual([["ai-gpt", "rate_limited"]]);
    expect((await w.of("llm.batch.sent")).map((e) => p(e).agentId)).toEqual(["ai-claude"]);
    // Gemini の予約は、閉じるまで使ったものとして数える
    expect(llmCostUsed(await w.all(), "2026-11-09")).toBe(64 + 36);
    await replay(await w.all(), w.values, { holidayTables: w.holidayTables });
  });

  it("口が作れない（API キーがないなど）ときは、LLM の段の結果に error: を残し、ほかの段は止めない", async () => {
    const w = await llmWorld();
    w.deps.llm = { ...w.deps.llm!, portOf: () => { throw new Error("ANTHROPIC_API_KEY is not set"); } };
    const results = await w.run(DAYS[0]!);
    expect(submitOf(results)).toEqual({ stage: "llm.submit", status: "skipped", detail: LLM_IDS.map((id) => `${id}: ANTHROPIC_API_KEY is not set`).join("; ").replace(/^/, "error: ") });
    expect((await w.of("valuation.recorded")).length).toBeGreaterThan(0);
    expect(await w.of("llm.batch.submitted")).toEqual([]);
  });

  it("投稿も注文も停止中のAIは依頼しない", async () => {
    const w = await llmWorld();
    await w.op("agent.suspended", { agentId: "ai-claude", scope: "both", reason: "試験" });
    await w.run(DAYS[0]!);
    expect((await w.of("llm.batch.submitted")).map((e) => p(e).agentId)).toEqual(["ai-gpt", "ai-gemini"]);
  });
});
