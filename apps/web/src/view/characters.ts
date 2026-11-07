// キャラクターの設定（このサービスのオリジナル）。AIのIDから引く表。表示だけの設定で、成績や順位には関わらない。
// 知らないIDは「伏せカード」の見た目（look: "locked"）。名前は記録の displayName をそのまま使う。

/** 肖像の図形の種類。locked は参戦前・未知のAIのシルエット */
export type Look = "mia" | "riva" | "holden" | "sora" | "gina" | "gem" | "locked";

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
// LLM で考える3体（案Aの既定）。AIのIDではなく、判断の記録の提供元から引く（IDは運用で決まるため）。実在の会社のロゴ・商標は使わない
const SORA: Character = { look: "sora", name: "ミナ・アンバー", title: "「熟考する書記官」Claude で考える", color: "#FFB020", tint: "#1E1406" };
const GINA: Character = { look: "gina", name: "ジーナ・タクト", title: "「万能の弁士」GPT で考える", color: "#8C7CFF", tint: "#130F2E" };
const GEM: Character = { look: "gem", name: "ユノ・ツイン", title: "「二つの顔の観測者」Gemini で考える", color: "#3DA5FF", tint: "#0A1830" };
const BY_PROVIDER = new Map<string, Character>([["anthropic", SORA], ["openai", GINA], ["google", GEM]]);
const LOCKED: Omit<Character, "name"> = { look: "locked", title: "参戦準備中", color: "#A98BD6", tint: "#120A1C" };
/** ゴールデンログのAIは方針を持たない（台本どおりの注文）。見た目だけ借りるので、二つ名は出さず確認用と書く */
const FIXTURE_TITLE = "表示確認用（架空のシナリオのAI）";

/** ai-a・b・c はゴールデンログ（架空のシナリオ）のAI。画面の確認用に同じキャラを割り当てる。Map なので "constructor" などのIDも未知として扱う */
const TABLE = new Map<string, Character>([
  ["ai-ma5", MIA],
  ["ai-reversal", RIVA],
  ["ai-hold", HOLDEN],
  ["ai-a", { ...MIA, title: FIXTURE_TITLE }],
  ["ai-b", { ...RIVA, title: FIXTURE_TITLE }],
  ["ai-c", { ...HOLDEN, title: FIXTURE_TITLE }],
]);

/** loggedName は記録の displayName（知らないIDの表示名に使う）。provider は判断の記録のモデルの提供元（IDが表にないときの手がかり） */
export function characterOf(agentId: string, loggedName: string, provider?: string): Character {
  return TABLE.get(agentId) ?? (provider === undefined ? undefined : BY_PROVIDER.get(provider)) ?? { ...LOCKED, name: loggedName };
}

/** 表示用のハンドル（記録のIDそのまま。例 "@ai-ma5"） */
export const handleOf = (agentId: string): string => `@${agentId}`;
