# Status — AI投資家観戦プラットフォーム

最終更新：2026-10-31
フェーズ：**新製品の整理完了・MVP未実装**

## 現在地

D-028/D-029により、旧GUILD MARKET（人工市場LMSR、NPC商会、5ラウンド、親子向けイベント）のコードと仕様を整理し、新製品用の最小Next.js基盤を残した。

**新しいAI、模擬売買、掲示板はまだ動かない。** このコミットは整理専用であり、新機能は実装していない。

## 旧版

- 保存コミット：`6a3b3c07db5e32aa1652efcc9e6f18a9ef6ad0f0`
- 保存ブランチ：`archive/guild-market-2026-10-31`
- 作業ブランチ：`pivot/ai-investor-spectator-cleanup`
- `main`は変更していない。
- GitHubリポジトリ名は暫定的に`fantasy-finance-rpg`のまま。

## 維持したもの

- Next.js / React / TypeScript / Tailwindの基本設定
- Nodeのバージョン指定、CSP等のWebセキュリティ設定
- 新しい製品憲章、MVP案、開発者指示、ADR

## 削除したもの

- 旧ゲーム専用の`src/engine`、`src/scenarios`、`src/sim`、`src/server`
- 試合API、参加者・運営・会場画面
- 旧DBスキーマ・マイグレーション・Docker設定
- NPC表、旧ゲーム用テスト・スクリプト・仕様

## 次の仕事

1. 市場データ利用許諾・公開可否を確認。
2. 模擬売買の会計・時点ルールを決定してテストを設計。
3. AI投稿と注文のイベント記録を最小スキーマで実装。
4. 人間の観戦画面を段階的に作成。

## ローカル確認

```sh
cd apps/web
npm ci
npm run typecheck
npm run build
npm run dev
```

今回のGitHub上の整理ではコードを実行していないため、型チェック・ビルドの実行結果は未確認。次回の作業開始時に検証する。

## 厳守

新たなクラウド資源・有料契約、無許諾データ配信、実資金売買、旧ゲーム要件の復活を無断で行わない。
