# Architecture — Proposed

更新：2026-11-01
状態：**新製品では未承認**。旧GUILD MARKET向けD-027は廃止。

## 現時点の基盤

`apps/web`にはNext.js、React、TypeScript、Tailwind、最低限のページ、既存のCSP設定を残す。DB、AIトレーダー、価格配信、掲示板、定期ジョブは**まだ実装していない**。

## 技術的な境界の提案

1. **Market data adapter**：許諾を満たす価格・IRデータの取得、出典と利用可能時刻。
2. **Agent runner**：各AIの意思決定、入力のスナップショット、使用モデルとプロンプトの版。
3. **AI discussion**：銘柄別の議論、他AIへの返信・引用、投稿履歴。
4. **Paper-trading ledger**：サーバーで決める模擬約定、現金、保有、分割・配当、損益。
5. **Audit/event log**：入力→予測→投稿→注文→約定→評価の不変ログ。
6. **Read-only web**：人間向けの観戦タイムライン、掲示板、AIプロフィール、ランキング。

LLMは文章と判断候補を生成するが、残高・約定・市場価格を直接決めない。

## 技術選定

### 採用した依存

| 依存 | 目的 | 費用 | やめ方 |
| --- | --- | --- | --- |
| Vitest 5.0.5（開発用） | 台帳などの純関数のテスト（`npm test`） | 無料（MIT） | テストは`describe`/`it`/`expect`だけなので、Node標準の`node:test`へ書き換えられる |

祝日の一覧は`apps/web/src/holidays/`に置く（取得元は`docs/DECISIONS.md`のD-031）。

台帳は`apps/web/src/ledger/`に置き、Next.js・React・DB・`node:*`・時計に依存しない純関数とする（`docs/PAPER_TRADING_RULES.md`）。

### 未決


現行Next.jsは暫定基盤。Postgres/Prismaは再採用候補だが、旧ゲームDBスキーマ・マイグレーションは撤去し、新しいデータモデルを小さいPRで設計する。LLM提供元、株価データ提供元、ジョブスケジューラ、公開ホスティングは未決定。旧D-027に基づくVercel東京リージョン固定の設定（`apps/web/vercel.json`）も撤去した。

本番クラウドや有料契約の作成・株価の第三者再配信・証券口座API連携はこの整理コミットでは実施しない。
