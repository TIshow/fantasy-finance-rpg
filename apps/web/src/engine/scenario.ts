import type { GuildId, GuildMap } from "./types";

export type NpcArchetype = "trend" | "news" | "contrarian" | "short" | "long";
export type InvestigationSourceId = "newspaper" | "official" | "ai";
export type InvestigationWindow = 1 | 2;

export interface ScenarioGuild {
  id: GuildId;
  name: string;
  seal: string;
  project: string;
  color: string;
}

export interface ScenarioRound {
  /** 1から始まるラウンド番号 */
  index: number;
  act: string;
  title: string;
  news: string;
  details?: { label: string; text: string }[];
  investigationWindow?: InvestigationWindow;
}

export interface InvestigationSource {
  id: InvestigationSourceId;
  name: string;
  topic: string;
  result: string;
}

export interface Timing {
  newsMs: number;
  orderMs: number;
  publishMs: number;
  /** 清算から全端末が一斉に公開するまでの待ち */
  revealDelayMs: number;
  /** 締切後も注文を受け付ける猶予 */
  graceMs: number;
}

/** シナリオは内容と値だけを持つ。注文処理や清算の規則はエンジン側にある。 */
export interface Scenario {
  id: string;
  version: number;
  title: string;
  guilds: ScenarioGuild[];
  initialPrices: GuildMap<number>;
  /** 参加者0人のときの各ラウンド清算後の表示価格（NPC注文表の生成目標） */
  targetPrices: GuildMap<number>[];
  rounds: ScenarioRound[];
  investigations: Record<InvestigationWindow, InvestigationSource[]>;
  winner: GuildId;
  initialCash: number;
  orderCap: number;
  timing: Timing;
  npcArchetypes: Record<NpcArchetype, number>;
}
