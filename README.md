# F-Sports #01「GUILD MARKET」

変化するニュースと市場価格を読み、相談しながら未来の予測を更新する、金融・情報リテラシーゲームです。

最初は小学4〜6年生と保護者30〜50組を対象に、銀行主催の90分イベントとして実施します。イベント後には一人で遊べる追加シナリオを配信し、実際の継続利用を検証します。反応が良ければ、学校への無償提供、毎週配信、既存サービス「ゲスっち」との連携へ進みます。

> 操作は一つ、判断は深く。
>
> 情報を読む → 予測する → 売買する → 結果を見て修正する

## 現在地

- フェーズ：銀行提案用プロトタイプの実装・検証
- 基準日：2026-09-03
- 実装：5〜10分の単一HTMLプロトタイプを実装済み
- パッケージ／依存関係：未導入
- 次の成果物：内部プレイテスト結果と銀行提案用デモ台本

最新状態と次の作業は、必ず [`docs/STATUS.md`](docs/STATUS.md) を確認してください。

## プロトタイプを試す

[`prototype/guild-market-demo.html`](prototype/guild-market-demo.html)をローカルへ取得し、ブラウザで直接開きます。インストール、ビルド、サーバー、ネット接続は不要です。

```sh
node scripts/verify-prototype.mjs
```

上記コマンドで、価格合計、状態遷移、注文制約、調査券、決算、再読み込み復帰、外部依存がないことを検証できます。

## プロダクトの構造

- **F-Sports**：予測を競技として楽しむカテゴリー
- **GUILD MARKET**：教育向けゲームシリーズ／共通ゲームシステム
- **王国一のギルドを見抜け**：第1シナリオ
- **親子イベント**：最初のプレイ形式。別プロダクトではない

ライブイベント、一人プレイ、学校授業を同じゲームエンジンで支えます。変わるのは進行方法、チーム構成、シナリオであり、ゲームの中心は変えません。

## ドキュメント

| 文書 | 役割 |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Codexを含む開発エージェント共通の永続指示 |
| [`CLAUDE.md`](CLAUDE.md) | Claude Codeから共通指示を読み込む入口 |
| [`docs/PROJECT_CHARTER.md`](docs/PROJECT_CHARTER.md) | 目的、対象、原則、スコープ |
| [`docs/PRODUCT_STRATEGY.md`](docs/PRODUCT_STRATEGY.md) | 銀行イベントから学校・toCへ進む仮説 |
| [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md) | ゲームルール、世界観、体験設計 |
| [`docs/PROTOTYPE_SPEC.md`](docs/PROTOTYPE_SPEC.md) | 1日で作る提案用プロトタイプの仕様 |
| [`docs/EVENT_MVP_PRD.md`](docs/EVENT_MVP_PRD.md) | 90分イベントMVPのプロダクト要件 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 論理構成、状態、設計制約、未決事項 |
| [`docs/DATA_AND_EVALUATION.md`](docs/DATA_AND_EVALUATION.md) | KPI、イベントログ、教育効果、プライバシー |
| [`docs/AI_WORKFLOW.md`](docs/AI_WORKFLOW.md) | Codex／Claude Code／人間の共同開発手順 |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | フェーズ、ゲート、成果物 |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | 確定事項と未決事項の記録 |
| [`docs/STATUS.md`](docs/STATUS.md) | AI・人間向けの現在地と引き継ぎ |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 文書・コード変更の進め方 |

## 最初に読む順番

### 新しいAIセッション

1. `AGENTS.md`（Claude Codeは`CLAUDE.md`から自動的に参照）
2. `docs/STATUS.md`
3. `docs/PROJECT_CHARTER.md`
4. 作業に関係する仕様書
5. `docs/DECISIONS.md`
6. 共同作業の運用が必要なら`docs/AI_WORKFLOW.md`

### 新しいエンジニア／企画メンバー

1. このREADME
2. `docs/PROJECT_CHARTER.md`
3. `docs/GAME_DESIGN.md`
4. `docs/ROADMAP.md`
5. 担当領域の仕様書

## リポジトリ方針

企画初期のため非公開で運用します。現時点ではライセンスを付与していません。秘密情報、実データ、児童・保護者を特定できる情報はコミットしません。
