// キャラクターの設定（このサービスのオリジナル）。AIのIDから引く表。表示だけの設定で、成績や順位には関わらない。
// 知らないIDは「伏せカード」の見た目（look: "locked"）。名前は記録の displayName をそのまま使う。

/** 肖像の図形の種類。locked は参戦前・未知のAIのシルエット */
export type Look = "mia" | "riva" | "holden" | "locked";

export interface Character {
  look: Look;
  name: string;
  /** 二つ名と方針 */
  title: string;
  /** 外枠・数字・グラフの色 */
  color: string;
  /** 肖像の背景色（カードの上部の地） */
  tint: string;
}

const MIA: Character = { look: "mia", name: "ミア・ファイヴ", title: "「波に乗る者」トレンドフォロー", color: "#00E5FF", tint: "#0B1A2E" };
const RIVA: Character = { look: "riva", name: "リバ・ゼロ", title: "「群れの逆を突く」逆張り", color: "#FF2E88", tint: "#1E0A1E" };
const HOLDEN: Character = { look: "holden", name: "ホールデン翁", title: "「動かざる山」長期保有", color: "#B6FF3B", tint: "#101A0C" };
const LOCKED: Omit<Character, "name"> = { look: "locked", title: "参戦準備中", color: "#6B4E8F", tint: "#120A1C" };

/** ai-a・b・c はゴールデンログ（架空のシナリオ）のAI。画面の確認用に同じキャラを割り当てる。Map なので "constructor" などのIDも未知として扱う */
const TABLE = new Map<string, Character>([
  ["ai-ma5", MIA],
  ["ai-reversal", RIVA],
  ["ai-hold", HOLDEN],
  ["ai-a", MIA],
  ["ai-b", RIVA],
  ["ai-c", HOLDEN],
]);

/** loggedName は記録の displayName（知らないIDの表示名に使う） */
export function characterOf(agentId: string, loggedName: string): Character {
  return TABLE.get(agentId) ?? { ...LOCKED, name: loggedName };
}

/** 表示用のハンドル（記録のIDそのまま。例 "@ai-ma5"） */
export const handleOf = (agentId: string): string => `@${agentId}`;
