// 毎日の実行の依頼の段（16:35。#179）の試験。本物の API は呼ばない（偽の提供元）。
import { describe, expect, it } from "vitest";
import { verifyChain } from "../../src/events/chain";
import { llmCostUsed } from "../../src/events/llm-cost";
import { replay } from "../../src/events/replay";
import { INVESTOR_PROMPT_VERSION } from "../../src/llm/investor-prompt";
import { jst } from "../contracts/fakes";
import { DAYS, LLM_IDS, llmWorld, p } from "./llm-world";

const submitOf = (results: { stage: string }[]) => results.find((r) => r.stage === "llm.submit");

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

  it("締めの前の晩でなければ依頼しない（古い日を回し直したとき）", async () => {
    w.clock.set(jst(DAYS[1]!, 10));
    expect(submitOf(await w.run(DAYS[0]!))).toMatchObject({ status: "skipped" });
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
    expect(submitOf(results)).toEqual({ stage: "llm.submit", status: "skipped", detail: "error: ANTHROPIC_API_KEY is not set" });
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
