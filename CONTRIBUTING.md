# Contributing

このリポジトリは、Codex、Claude Code、人間の開発者が同じ正本を参照して進めます。

## 作業開始

1. `AGENTS.md`を読む
2. `docs/STATUS.md`で現在のフェーズと次の作業を確認する
3. 関連する仕様書と`docs/DECISIONS.md`を読む
4. `git status`で既存変更を確認する

## 現在のフェーズ

2026-10-29に、GUILD MARKETを人工市場・一斉約定のゲームとして作り直す方針を決め、旧単一HTMLデモを廃止しました（D-024）。提案会議MVPと銀行イベントMVPは、同じアプリとゲームエンジンで作ります。

D-025〜D-027は2026-10-29に承認済みです。`apps/web`にゲームエンジンとシミュレータ（P1）があります。クラウドの作成と有料プランの契約は、別途承認を得てから行います。CIは追加しません。

## ブランチと変更単位

- 初期ドキュメントのブートストラップ後は、短命な作業ブランチを使う
- 1つの変更目的を1つのPull Requestにまとめる
- 大きな実装は、縦に動く小さな単位へ分割する
- 無関係な整形やリファクタリングを混ぜない
- 共有履歴を書き換えない

推奨ブランチ名：

- `docs/<topic>`
- `feat/<topic>`
- `fix/<topic>`
- `chore/<topic>`

## 意思決定

後から覆すコストが高い判断は、実装だけで確定させません。`docs/DECISIONS.md`に、背景、決定、理由、影響を残します。

対象例：

- 技術スタック
- 市場価格の計算方式
- 認証・匿名参加方式
- イベント状態遷移
- データ保持期間
- 外部サービスの採用
- 学校版と個人版の共通化方針

## 完了条件

変更は、次が揃ったときに完了です。

- 要求を満たしている
- 関連するテストまたは検証結果がある
- 振る舞いとドキュメントが一致している
- 重要な判断が`docs/DECISIONS.md`に残っている
- `docs/STATUS.md`が次の担当者にとって正確である
- 秘密情報や不要な個人情報を含んでいない

## コマンド

Nodeはasdf（`.tool-versions`）、Pythonはuv（`uv run`）で動かします。

`apps/web`で実行します（最初に`.env.example`を`.env`へコピーします）。

```sh
npm install
npm run db:up
npm run db:migrate
npm test
npm run test:db
npm run typecheck
npm run build
npm run simulate
```

ローカルで遊ぶときは`npm run dev`を起動し、`npm run match:create -- --fast`で試合を作ります。表示された参加者・会場・運営のURLを開きます。`npm run smoke`は、6商会がHTTP経由で5ラウンドを完走するかを確かめます。`npm run test:e2e`（Playwright）は、本番用のビルドで参加者6・運営・会場の8画面が5ラウンドを完走するかを確かめます（約2分）。LAN上の実機で試すときは`npm run start:lan`を使います（`docs/MEETING_MVP_SPEC.md` §12）。

文書のリンクと「§」の参照は、リポジトリのルートで`uv run scripts/check_docs.py`を実行して確かめます。新しいコマンドを足したら、ここと`AGENTS.md`へ追記します。
