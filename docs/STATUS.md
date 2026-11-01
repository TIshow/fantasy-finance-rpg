# Status — AI投資家観戦プラットフォーム

最終更新：2026-11-01
フェーズ：**新製品の整理完了・MVP未実装（仕様の決定待ち）**

## 現在地

D-028/D-029により、旧GUILD MARKET（人工市場LMSR、NPC商会、5ラウンド、親子向けイベント）のコードと仕様を撤去し、新製品用の最小Next.js基盤だけを残した。

**新しいAI、模擬売買、掲示板はまだ動かない。** `main`にあるのは、トップページだけの基盤である。

- `main`：PR #13（旧実装の撤去、2026-11-01マージ）とPR #31（Next.js 16.4.3への更新、2026-11-01マージ）を含む
- 作業の一覧：GitHubのマイルストーン「MVP α（内部観戦）」（issue #14〜#30）
- GitHubリポジトリ名は暫定的に`fantasy-finance-rpg`のまま

## 旧版の保存先

- 旧GUILD MARKET：ブランチ`archive/guild-market-2026-10-31`（コミット`6a3b3c07db5e32aa1652efcc9e6f18a9ef6ad0f0`、GitHubにpush済み）
- 旧v2の未完成の試作：オーナーのPCのローカルブランチ`archive/v2-market-2026-10-30`のみ（push していない）
- 旧ゲームのissue #6・#7はNOT_PLANNEDで閉じた
- 旧ローカルDB（Docker、`guild-market-db`）は2026-11-01に削除した。正本ではない試遊データのみ

旧版は参照用であり、その仕様を復活させない。

## 維持したもの

- Next.js / React / TypeScript / Tailwindの基本設定
- Nodeのバージョン指定（asdf、`.tool-versions`）、CSP等のWebセキュリティ設定
- 新しい製品憲章、MVP案、開発者指示、ADR

## セキュリティ

- 2026-11-01：Next.jsを16.2.7から16.4.3へ更新（PR #31）。`npm audit`のCritical 1件（Next.jsのProxy迂回、Server ActionsのDoS・SSRF）とHigh 2件（同梱のPostCSS、sharp）を解消し、0件になった
- 確認：`npm audit`、`npm run typecheck`、`npm run build`、`next start`での応答ヘッダー（CSP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy）

## 次の仕事

実装の前に、オーナーの判断が要るissueを決める。

1. #17 P-002 模擬売買の規則（注文の時点、約定価格、売買単位、手数料、制限値幅、分割・配当、休場日）
2. #18 P-001 株価・IRデータの取得元と利用許諾・公開範囲
3. #19 P-003 AI投稿の安全対策と運営体制
4. #20 P-004 DB・定期実行・ホスティング・予算（まずはローカル）
5. #21 LLMの提供元・モデル構成・費用の上限

判断を待たずに進められるもの：#16（新製品向けのレビュー手順）。最初の実装は#23（Vitestと純関数の模擬売買台帳、架空データ）で、#17の決定後に始める。依存関係は各issueに書いてある。

## ローカル確認

```sh
cd apps/web
npm ci
npm run typecheck
npm run build
npm run dev
```

## 履歴

- 2026-10-31：撤去ブランチのマージ前レビュー。誤削除なし、`npm ci`のロックファイル不整合と旧Vercel設定を修正、ビルド・起動・旧ルートの404を確認（PR #13）
- 2026-11-01：PR #13をマージ。issueを新製品向けに整理（#14〜#30、ラベル`security`・`decision-needed`・`legal`）。PR #31でNext.jsを更新

## 厳守

新たなクラウド資源・有料契約、無許諾データ配信、実資金売買、旧ゲーム要件の復活を無断で行わない。
