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

### 2026-10-31 — マージ前レビューとローカル検証

- `origin/main...pivot/ai-investor-spectator-cleanup`の削除・残存ファイル・文書を確認。旧ゲームの撤去はD-029と一致し、誤削除は見つからなかった。
- 保存ブランチと`origin/main`は、どちらも上記の保存コミットと一致することを確認。元の作業フォルダにある`feat/v2-market`の未コミット変更を保全するため、専用worktreeで検証した。保存ブランチに未コミットのv2変更は含まれない。
- 修正：`npm ci`がロックファイル不整合で失敗したため、`npm install --package-lock-only --ignore-scripts`でTailwindが要求するlightningcss 1.32.0・PostCSS 8.5.32とプラットフォーム別の推移依存を補正した。`package.json`と直接依存の固定バージョンは変更していない。
- 修正：ホスティング未決定という方針に合わせて旧Vercel東京リージョン設定を削除。削除済みPrisma生成先のgitignore設定と、旧運営画面を前提とするCSPコメントも整理した。
- 検証環境：asdf管理のNode.js 24.16.0 / npm 11.13.0（子プロセスも同じNodeを使用）。DB・環境変数ファイルなし。
- 成功：修復後の`npm ci`、`npm run typecheck`、`npm run build`、`npm ls --depth=0`、`git diff --check`。文書10ファイルの22文書参照も確認した。
- 起動確認：`npm run start -- --hostname 127.0.0.1 --port 3217`と`npm run dev -- --hostname 127.0.0.1 --port 3218`でトップページがHTTP 200。ブラウザで本番ビルドの見出し・説明・スタイルを確認した。
- 本番HTTP確認：JS/CSSアセット7件が200。CSP（`unsafe-eval`なし）、X-Frame-Options、X-Content-Type-Optionsを確認。旧API・参加者・運営・会場の代表ルート6件は404。
- 残るリスク：`npm audit`はNext.js 16.2.7（Critical）、PostCSS 8.4.31（High）、sharp 0.34.5（High）の3パッケージを報告した。いずれも`main`から引き継いだ版であり、整理による新規導入ではない。npm提示の修正先はNext.js 16.4.3で、基盤のバージョン更新は今回の整理修正に混ぜず、公開前に別PRで更新・再検証する必要がある。
- 未検証：macOS以外でのインストール・実行、本番デプロイ、新製品の機能（未実装）。新機能、依存追加、クラウド作成、`main`へのマージは行っていない。

## 厳守

新たなクラウド資源・有料契約、無許諾データ配信、実資金売買、旧ゲーム要件の復活を無断で行わない。
