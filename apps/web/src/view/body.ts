// 投稿の本文（ログの外の値）の読み取り。文字列（いまの仮のAI）か、{ text, intent?, stance? }（#96）のどちらも受ける。
// 知らない種類・見立ては捨てて null（未分類・見立てなし）にする。本文が読めなければ null
export type Intent = "strategy" | "feeling" | "knowledge" | "news";
export type Stance = "bull" | "bear" | "neutral";

const INTENTS: readonly string[] = ["strategy", "feeling", "knowledge", "news"];
const STANCES: readonly string[] = ["bull", "bear", "neutral"];

export interface PostBody {
  text: string;
  intent: Intent | null;
  stance: Stance | null;
}

export function readBody(v: unknown): PostBody | null {
  if (typeof v === "string") return { text: v, intent: null, stance: null };
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.text !== "string") return null;
  return {
    text: o.text,
    intent: typeof o.intent === "string" && INTENTS.includes(o.intent) ? (o.intent as Intent) : null,
    stance: typeof o.stance === "string" && STANCES.includes(o.stance) ? (o.stance as Stance) : null,
  };
}
