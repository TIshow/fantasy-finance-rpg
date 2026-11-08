// LLM の AI 投資家のプロンプト（版つき）と、送る入力の文（#179）。
// 3体（Claude・GPT・Gemini）に、同じプロンプトと同じ入力の文を渡す。違うのはモデルだけ。
// 入力の文は、runner が記録から集めた値（investorInputOf。src/runner/llm-input.ts）だけから決定論的に作る（同じ値なら同じ文）。
// 送る本文は2万バイトまで（#179 の lead の決定）。収まらなければ、古い投稿から、次に古い値段の日から削り、削った数を文に書く。
import type { LlmPrompt } from "../contracts";
import { canonicalize } from "../events/canonical";
import { sha256Hex } from "../events/hash";
import { PRICE_BAND_PERCENT, priceBand } from "../ledger/auction";
import type { Account, Deciyen } from "../ledger/types";
import { BATCH_MAX_INPUT_TOKENS } from "./batch-port";

export const INVESTOR_PROMPT_ID = "llm-investor";
/** プロンプトの版。指示の文や入力の文の形を変えたら上げる（llm.batch.submitted と agent.run に残る） */
export const INVESTOR_PROMPT_VERSION = "1";
/** 銘柄によらない掲示板の名前 */
export const GENERAL_BOARD = "全体";
/** 投稿の本文の上限（文字数。#179） */
export const POST_MAX_CHARS = 400;
/** 1つの注文票の注文の上限（#179） */
export const MAX_ORDERS = 10;

export const INVESTOR_SYSTEM_PROMPT = [
  "あなたは架空の株式市場で模擬売買をするAI投資家です。実在の企業・実際のお金・投資助言とは関係ありません。",
  "毎営業日1回、注文票（注文の並び）と、掲示板への投稿を最大1件決めます。ほかに3体のAI（別の会社のモデル）と、規則で動くAIが参加しています。",
  "規則：",
  "- 注文は取引日の寄り付きの板寄せ（1日1回、1つの価格で売り買いを突き合わせる）で約定します。注文票は締め（8:30）の前に1回だけ確定し、取り消せません。",
  "- 株数は100株単位。売りは持っている株数まで。空売り・信用取引・手数料はありません。",
  `- 指値（limit。円の整数）か成行（limit を書かない）。指値は値幅（基準価格の±${PRICE_BAND_PERCENT}%と±1円の広いほう）の内側だけです。`,
  "- 買いの代金が現金を超えると、確定の時刻の順に株数を減らされます。成行の買いは値幅の上限の値段で現金を確かめます。",
  `- 1つの注文票の注文は${MAX_ORDERS}件まで。売買しない日は空の並びにします。`,
  `- 投稿は1日1件まで、本文は${POST_MAX_CHARS}文字まで。掲示板は銘柄コードか「${GENERAL_BOARD}」。投稿しないなら null。`,
  "- 入力は締めの前日の引けのあとまでに記録されたものだけです。書かれていない事実（実在の企業・ニュース）を作らないでください。",
  "出力は、次の形のJSONだけにしてください（前後に説明を書かない）：",
  `{"post":{"board":"銘柄コードか${GENERAL_BOARD}","text":"本文"}または null,"orders":[{"symbol":"銘柄コード","side":"buy または sell","qty":100の倍数,"limit":円の整数（成行なら書かない）}],"note":"判断の理由の短い要約"}`,
].join("\n");

/** プロンプト（ID・版・指示の文のハッシュ）。agent.run と依頼に残す */
export async function investorPrompt(): Promise<LlmPrompt> {
  const hash = await sha256Hex(new TextEncoder().encode(canonicalize({ id: INVESTOR_PROMPT_ID, version: INVESTOR_PROMPT_VERSION, system: INVESTOR_SYSTEM_PROMPT })));
  return { id: INVESTOR_PROMPT_ID, version: INVESTOR_PROMPT_VERSION, hash };
}

/** JSON の文字列の中に書いたときの UTF-8 のバイト数（各社の本文は、文を JSON の文字列として1回だけ入れる） */
export const jsonBytes = (s: string): number => new TextEncoder().encode(JSON.stringify(s)).length - 2;

/**
 * 入力の文に使えるバイト数。送る本文の上限（2万バイト）から、指示の文と、各社の本文の決まった部分（モデル名・設定・1件のIDなど）の
 * 分を引いた残り。決まった部分の見込み（1,000バイト）で足りることは、試験で3社の本文を作って確かめる（tests/llm/investor-prompt.test.ts）
 */
export const USER_TEXT_MAX_BYTES = BATCH_MAX_INPUT_TOKENS - jsonBytes(INVESTOR_SYSTEM_PROMPT) - 1000;

/** 入力の値。seq は、その値の元の記録（agent.run の inputSeqs に入れる） */
export interface InvestorSymbol {
  symbol: string;
  name: string;
  sector: string;
  sharesOutstanding: number;
  listing: { seq: number; price: Deciyen };
  /** 値幅の基準の価格（取引日より前で、価格のついた直近の板寄せ。なければ上場の価格） */
  refPrice: { seq: number; price: Deciyen };
  /** 板寄せの結果（古い順） */
  auctions: readonly { seq: number; date: string; price: Deciyen | null; volume: number }[];
  /** 決算の発表（古い順） */
  disclosures: readonly { seq: number; period: string; revenue: number; netIncome: number; eps: Deciyen; dividendPerShare: Deciyen }[];
}

export interface InvestorPost {
  seq: number;
  agentId: string;
  board: string;
  /** 記録した時刻（UNIXミリ秒） */
  at: number;
  text: string;
}

export interface InvestorInput {
  agentId: string;
  tradingDate: string;
  /** 口座と、その根拠の記録（最後の引け後の処理、まだなければ登録）の seq */
  account: Account;
  accountSeq: number;
  /** 取引対象のうち上場した銘柄（銘柄コードの順） */
  symbols: readonly InvestorSymbol[];
  /** 掲示板の投稿（古い順。取り下げたものは入れない） */
  posts: readonly InvestorPost[];
}

export interface InvestorText {
  text: string;
  /** 文に入れた値の元の記録の seq（昇順） */
  inputSeqs: number[];
  /** 削った古い投稿の数と、削った古い値段の日数（銘柄ごとの板寄せの結果を、古い日から何日分削ったか） */
  omitted: { posts: number; auctionDays: number };
}

const yen = (d: Deciyen) => (d % 10 === 0 ? String(d / 10) : (d / 10).toFixed(1));
const JST = 9 * 3_600_000;
const jstTime = (ms: number) => new Date(ms + JST).toISOString().slice(5, 16).replace("T", " ");
const md = (date: string) => date.slice(5).replace("-", "/");
const millions = (v: number) => String(Math.round(v / 1_000_000));

function render(input: InvestorInput, posts: readonly InvestorPost[], days: number, omitted: InvestorText["omitted"]): string {
  const a = input.account;
  const lines = [`取引日：${input.tradingDate}（この日の寄り付きの板寄せで約定。締めは8:30）`, `あなた：${input.agentId}`, `現金：${yen(a.cash)}円`];
  const held = Object.entries(a.holdings).filter(([, h]) => h.qty > 0).sort(([x], [y]) => (x < y ? -1 : 1));
  lines.push(held.length === 0 ? "保有：なし" : `保有：${held.map(([s, h]) => `${s} ${h.qty}株（取得原価の合計 ${yen(h.cost)}円）`).join("、")}`);
  lines.push("", "銘柄（値段は円、出来高は株。値段が空の日は、板寄せで値段がつかなかった日）");
  for (const s of input.symbols) {
    const band = priceBand(s.refPrice.price);
    lines.push(`## ${s.symbol} ${s.name}（${s.sector}）発行済 ${s.sharesOutstanding}株 上場時 ${yen(s.listing.price)} 基準 ${yen(s.refPrice.price)} 値幅 ${yen(band.lower)}〜${yen(band.upper)}`);
    const au = s.auctions.slice(-days);
    if (au.length > 0) lines.push("日付,値段,出来高", ...au.map((x) => `${md(x.date)},${x.price === null ? "" : yen(x.price)},${x.volume}`));
    if (s.disclosures.length > 0) lines.push("決算 期間,売上(百万円),純利益(百万円),1株利益,1株配当", ...s.disclosures.map((q) => `${q.period},${millions(q.revenue)},${millions(q.netIncome)},${yen(q.eps)},${yen(q.dividendPerShare)}`));
  }
  const skipped = [omitted.posts > 0 ? `古い投稿${omitted.posts}件` : "", omitted.auctionDays > 0 ? `古い値段${omitted.auctionDays}日分` : ""].filter((x) => x !== "");
  lines.push("", `掲示板（古い順）${skipped.length > 0 ? `。長さの上限のため省略：${skipped.join("、")}` : ""}`);
  if (posts.length === 0) lines.push("（投稿なし）");
  for (const p of posts) lines.push(`[${jstTime(p.at)} ${p.agentId} ${p.board}] ${p.text.replace(/\s+/g, " ")}`);
  return lines.join("\n");
}

/**
 * 入力の文を作る。maxBytes（JSON の文字列に入れたときのバイト数）に収まるまで、古い投稿を1件ずつ、
 * それでも収まらなければ古い値段の日を1日ずつ削る。値段が1日分でも収まらなければ RangeError
 */
export function investorUserText(input: InvestorInput, maxBytes: number = USER_TEXT_MAX_BYTES): InvestorText {
  const allDays = Math.max(0, ...input.symbols.map((s) => s.auctions.length));
  const fits = (posts: number, days: number) => {
    const omitted = { posts: input.posts.length - posts, auctionDays: allDays - days };
    const kept = input.posts.slice(input.posts.length - posts);
    const text = render(input, kept, days, omitted);
    return jsonBytes(text) <= maxBytes ? { text, kept, days, omitted } : null;
  };
  let r: ReturnType<typeof fits> = null;
  for (let posts = input.posts.length; posts >= 0 && r === null; posts--) r = fits(posts, allDays);
  for (let days = allDays - 1; days >= Math.min(1, allDays) && r === null; days--) r = fits(0, days);
  if (r === null) throw new RangeError("the investor input does not fit in the body limit");
  const { text, kept, days, omitted } = r;
  const seqs = [input.accountSeq, ...kept.map((p) => p.seq)];
  for (const s of input.symbols) seqs.push(s.listing.seq, s.refPrice.seq, ...s.auctions.slice(-days).map((x) => x.seq), ...s.disclosures.map((q) => q.seq));
  return { text, inputSeqs: [...new Set(seqs)].sort((x, y) => x - y), omitted };
}
