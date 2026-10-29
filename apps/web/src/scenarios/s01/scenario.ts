import type { Scenario } from "@/engine/scenario";

/**
 * 第1シナリオ「王国一のギルドを見抜け」の提案会議用5ラウンド版。
 * 本文の正本は docs/SCENARIO_01.md。ここを変えたら文書とNPC注文表も更新する。
 */
export const scenarioS01: Scenario = {
  id: "s01-meeting-5r",
  version: 1,
  title: "王国一のギルドを見抜け",
  guilds: [
    { id: "airship", name: "飛空艇ギルド", seal: "空", project: "世界初の王国間飛行", color: "#62c8ff" },
    { id: "alchemy", name: "錬金術ギルド", seal: "錬", project: "万能薬の完成", color: "#bb91ff" },
    { id: "dragon", name: "ドラゴン輸送ギルド", seal: "竜", project: "大型輸送の実用化", color: "#ff934f" },
    { id: "academy", name: "魔法学校", seal: "学", project: "100人の魔法使い育成", color: "#70d49a" },
  ],
  initialPrices: { airship: 28, alchemy: 34, dragon: 23, academy: 15 },
  targetPrices: [
    { airship: 29, alchemy: 34, dragon: 22, academy: 15 },
    { airship: 27, alchemy: 31, dragon: 30, academy: 12 },
    { airship: 34, alchemy: 38, dragon: 11, academy: 17 },
    { airship: 35, alchemy: 38, dragon: 9, academy: 18 },
    { airship: 26, alchemy: 30, dragon: 28, academy: 16 },
  ],
  rounds: [
    {
      index: 1,
      act: "第1幕",
      title: "最初の見立て",
      news: "王国のグランドクエストが始まった。4つのギルドが大事業に挑み、最も大きな成果を上げたギルドが王国勲章を獲得する。",
    },
    {
      index: 2,
      act: "第2幕",
      title: "人気か採算か",
      news: "ドラゴン輸送の大型便、予約が1万件を突破。王都の商店では記念グッズも完売！",
      details: [
        { label: "スカウト面", text: "街では「ドラゴン便なら山を越えて翌日に届く」と大評判。商人たちは追加便を待っている。" },
        { label: "アナリスト面", text: "大型便1回の飼料費は当初計画の1.7倍。予約は多いが、黒字化には高い稼働率が必要。" },
      ],
    },
    {
      index: 3,
      act: "第3幕",
      title: "事故の噂",
      news: "【速報】ドラゴン輸送の車両で重大事故か。炎上する映像が王国SNSで拡散中。",
      investigationWindow: 1,
    },
    {
      index: 4,
      act: "第4幕",
      title: "AI速報",
      news: "賢者オラクルのAIレポート：事故の可能性76％。根拠はSNS投稿213件、目撃情報12件。未確認：製品番号、公式事故報告。",
      investigationWindow: 2,
    },
    {
      index: 5,
      act: "最終",
      title: "公式照合",
      news: "映像の製品番号OT-04は競合ギルドの旧型車両と一致。ドラゴン輸送ギルドの現行型DT-12ではない。",
    },
  ],
  investigations: {
    1: [
      { id: "newspaper", name: "王国新聞", topic: "目撃者への聞き取り", result: "映像は夜間に撮影され、目撃者はギルドの紋章を確認できていない。" },
      { id: "official", name: "ギルド公式資料", topic: "現行車両の外観資料", result: "現行のドラゴン車両には金色の三本帯がある。映像の車両は黒い一本帯に見える。" },
      { id: "ai", name: "賢者オラクルのAI分析", topic: "SNSと目撃情報の速報分析", result: "事故の可能性76％。SNS投稿213件、目撃情報12件。製品番号と公式事故報告は未確認。" },
    ],
    2: [
      { id: "newspaper", name: "王国新聞", topic: "投稿者と撮影場所の追跡", result: "最初の投稿者は作成翌日の新規アカウント。撮影場所は確認できていない。" },
      { id: "official", name: "ギルド公式資料", topic: "製品番号の照合", result: "映像の製品番号OT-04は競合ギルドの旧型。現行型はDT-12。" },
      { id: "ai", name: "賢者オラクルのAI分析", topic: "追加資料を含む再分析", result: "追加資料を含めると事故の可能性41％。公式の製品一覧はまだ解析対象外。" },
    ],
  },
  winner: "dragon",
  initialCash: 1000,
  orderCap: 10,
  timing: { newsMs: 10_000, orderMs: 35_000, publishMs: 10_000, revealDelayMs: 2_000, graceMs: 1_000 },
  npcArchetypes: { trend: 25, news: 25, contrarian: 15, short: 15, long: 20 },
};
