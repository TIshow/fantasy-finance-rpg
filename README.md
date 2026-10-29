# F-Sports #01「GUILD MARKET」

変化するニュースと市場価格を読み、相談しながら未来の予測を更新する、金融・情報リテラシーゲームです。

最初は小学4〜6年生と保護者30〜50組を対象に、銀行主催の90分イベントとして実施します。イベント後には一人で遊べる追加シナリオを配信し、実際の継続利用を検証します。反応が良ければ、学校への無償提供、毎週配信、既存サービス「ゲスっち」との連携へ進みます。

> 操作は一つ、判断は深く。
>
> 情報を読む → 予測する → 売買する → 結果を見て修正する

## 現在地

- フェーズ：提案会議MVP（人工市場のライブ対戦）の実装中
- 基準日：2026-10-29
- 実装：`apps/web`にゲームエンジン、第1シナリオ、NPCの注文表、シミュレータ（P1）。画面はまだありません（旧単一HTMLデモは2026-10-29に廃止）
- 開発環境：Nodeはasdf（24.16.0）、Pythonはuv
- 次の成果物：サーバーとDB（P2）

最新状態と次の作業は、必ず [`docs/STATUS.md`](docs/STATUS.md) を確認してください。

## 人工市場と一斉約定

GUILD MARKETの市場には、プレイヤーのほかに約100のNPC商会（王国の商会100）が参加します。各ラウンドでは注文を予約し、締切ごとに全員の注文が一斉に約定して、新しい価格が全端末に同時に公開されます。ニュースを読むだけでなく、ほかの商会の動きを読むことがゲームの中心です。

最初の目標は、銀行への提案会議で5〜6人が各自のスマートフォンからQRで参加し、約5分の対戦を体験できる提案会議MVPです（[`docs/MEETING_MVP_SPEC.md`](docs/MEETING_MVP_SPEC.md)）。

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
| [`docs/MARKET_SPEC.md`](docs/MARKET_SPEC.md) | 人工市場と一斉約定の規則、NPC、不変条件 |
| [`docs/SCENARIO_01.md`](docs/SCENARIO_01.md) | 第1シナリオの本文と値 |
| [`docs/MEETING_MVP_SPEC.md`](docs/MEETING_MVP_SPEC.md) | 提案会議MVPの範囲、画面、受け入れ条件、計画 |
| [`docs/EVENT_MVP_PRD.md`](docs/EVENT_MVP_PRD.md) | 90分イベントMVPのプロダクト要件 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | エンジン、状態機械、同期、技術構成、データ、API |
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
