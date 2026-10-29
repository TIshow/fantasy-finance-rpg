import { fixedSheetPolicy, type NpcSheet } from "@/engine";
import sheetJson from "@/scenarios/s01/npc-sheet.k2.json";
import { scenarioS01 } from "@/scenarios/s01/scenario";

export const scenario = scenarioS01;
export const sheet = sheetJson as NpcSheet;
export const policy = fixedSheetPolicy(sheet);
export const guilds = scenario.guilds.map((g) => g.id);
export const teams = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
