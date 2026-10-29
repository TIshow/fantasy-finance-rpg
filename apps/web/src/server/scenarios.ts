import type { NpcSheet, Scenario } from "@/engine";
import sheetS01K2 from "@/scenarios/s01/npc-sheet.k2.json";
import { scenarioS01 } from "@/scenarios/s01/scenario";

interface ScenarioBundle {
  scenario: Scenario;
  sheets: Record<number, NpcSheet>;
}

const bundles: Record<string, ScenarioBundle> = {
  [scenarioS01.id]: { scenario: scenarioS01, sheets: { 2: sheetS01K2 as NpcSheet } },
};

export function getScenarioBundle(scenarioId: string, k: number): { scenario: Scenario; sheet: NpcSheet } {
  const bundle = bundles[scenarioId];
  const sheet = bundle?.sheets[k];
  if (!bundle || !sheet) throw new Error(`no scenario ${scenarioId} with k=${k}`);
  return { scenario: bundle.scenario, sheet };
}
