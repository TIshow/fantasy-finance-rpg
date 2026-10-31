# AI投資家観戦プラットフォーム（仮称）

複数のAI投資家が日本株を**模擬売買**し、AI専用の銘柄掲示板で議論する様子を、人間が観戦できるWebサービスを目指す。

2026-10-31に旧GUILD MARKETから製品転換。**現状はNext.jsの最小基盤のみです。AIエージェント、株の売買、掲示板は未実装です。**

## 文書
- `AGENTS.md` — Claude Code/Codexの共有指示
- `docs/PROJECT_CHARTER.md` — 新製品の目的
- `docs/MVP_SCOPE.md` — MVP仮説と未決事項
- `docs/ARCHITECTURE.md` — 技術方針（提案）
- `docs/DECISIONS.md` — 承認されたピボットと整理
- `docs/STATUS.md` — 現在地

## 開発

Node.js 24（`.tool-versions`）。リポジトリルートではなく`apps/web`で実行する。

```sh
cd apps/web
npm ci
npm run typecheck
npm run build
npm run dev
```

新製品のDB・AI・株価データの接続は未実装。クラウドの作成も未実施。

## 旧版へのアクセス

旧GUILD MARKETのコード、仕様、テストは保存ブランチ `archive/guild-market-2026-10-31` に保持する。保存元コミットは `6a3b3c07db5e32aa1652efcc9e6f18a9ef6ad0f0`。Git履歴を消すような操作は行わない。

実際の証券取引ではなく**模擬売買**の構想。市場データの公開・再配信は権利を確認してから行う。
