// LLM の段の試験に使う、架空の市場の世界（#179）。6社の上場・売買役・規則のAI 3体・LLM のAI 3体を、前営業日の夜に用意する。
// 外部通信・DB なし。LLM は偽の提供元（llm-fakes.ts）。
import type { LlmPolicy } from "../../src/contracts";
import type { LogEvent } from "../../src/events/types";
import { IngestedMarketData } from "../../src/ingest/market-data";
import { INITIAL_CASH } from "../../src/ledger/types";
import { type RunnerDeps, runDay } from "../../src/runner/day";
import { LLM_INVESTORS } from "../../src/runner/llm-agents";
import { ruleAgents } from "../../src/runner/rule-agents";
import { RunnerValues } from "../../src/runner/values";
import { discloseDue } from "../../src/runner/world/disclosure";
import { listCompanies } from "../../src/runner/world/listing";
import { liquidityAgents, setUpParticipants } from "../../src/runner/world/participants";
import { InMemoryEventStore } from "../../src/store/memory-store";
import { FakeClock, jst } from "../contracts/fakes";
import { FIXTURE_HOLIDAYS } from "../fixtures/golden";
import { mulberry32 } from "../fixtures/prng";
import { fakeLlm } from "./llm-fakes";

export const SEED = 20261106;
export const PRIOR = "2026-11-06";
export const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
export const LLM_IDS = LLM_INVESTORS.map((a) => a.id);
export const p = (e: LogEvent) => e.payload as Record<string, unknown>;

export async function llmWorld(policy?: LlmPolicy) {
  const clock = new FakeClock(0);
  const holidayTables = new Map([[FIXTURE_HOLIDAYS.contentSha256, FIXTURE_HOLIDAYS]]);
  const rand = mulberry32(0x5a17);
  const values = new RunnerValues(() => Uint8Array.from({ length: 16 }, () => Math.floor(rand() * 256)));
  const store = new InMemoryEventStore(values, holidayTables, clock);
  const llm = fakeLlm(clock, policy);
  const waitUntil = async (at: number) => {
    if (at > clock.now()) clock.set(at);
  };
  const agents = [...(await ruleAgents()), ...(await liquidityAgents(SEED))];
  const deps: RunnerDeps = { store, market: new IngestedMarketData(clock), values, holidayTables, agents, clock, waitUntil, inputDays: 5, seed: SEED, llm: llm.deps };
  const op = (type: "holidays.adopted" | "agent.registered" | "agent.suspended", payload: Record<string, unknown>) => store.append({ type, actor: "operator:owner", refs: [], payload });
  await op("holidays.adopted", { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 });
  clock.set(jst(PRIOR, 18));
  await listCompanies(store, SEED);
  await discloseDue(store, SEED, clock);
  await setUpParticipants(store, DAYS[0]!);
  for (const a of [...(await ruleAgents()), ...LLM_INVESTORS]) await op("agent.registered", { agentId: a.id, displayName: a.id, startDate: DAYS[0], initialCash: INITIAL_CASH });
  const all = () => store.read(0, 1_000_000);
  const of = async (type: LogEvent["type"]) => (await all()).filter((e) => e.type === type);
  return { clock, store, values, holidayTables, deps, llm, op, all, of, run: (d: string) => runDay(d, deps) };
}
