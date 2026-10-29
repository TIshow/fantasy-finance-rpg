# Project Status and Handoff

最終更新：2026-10-29

この文書は、新しいCodex／Claude Codeセッションや新しい開発者が、チャット履歴なしで現在地を把握するための入口です。作業完了時に更新してください。

## 現在のフェーズ

**Phase 0：提案会議MVP — P3（画面とE2E）完了。残りは実機の内部テストとP4（本番環境）**

2026-10-29、オーナーの判断で、GUILD MARKETを人工市場・一斉約定のゲームとして作り直すことにしました（D-024）。プレイヤーと約100のNPC商会が同じ市場で売買し、注文はラウンドの締切ごとに一斉に約定します。

最初の目標は、銀行への提案会議で5〜6人が各自のスマートフォンから参加し、約5分の対戦を体験できる提案会議MVPです。これは、銀行イベントMVPへ広げる同じアプリとゲームエンジンの最初の版です。

旧単一HTMLデモ（提案先へ送る動画を撮るための簡易版）、その検証スクリプト、仕様書は削除しました。旧版はgit履歴（`5d9ac6c`）から参照できます。

2026-10-29、オーナーがD-025〜D-027（約定方式、NPCの作り方、技術構成）を承認しました。同日、P1としてゲームエンジン、第1シナリオ、NPCの注文表、シミュレータを実装しました。続けてP2として、サーバー・DB・APIと、動作確認用の最小限の画面を実装しました。画面の作り込みはまだです。クラウドの作成と費用は、P4の前に別途承認を得ます。

## 現在のゴール

1. 提案会議の日程と最大人数（O-011）を確認する
2. LAN上の実機5〜6台で内部テストする（P3の残り。`MEETING_MVP_SPEC.md` §12）
3. 本番環境で4G回線のリハーサルを2回完走し、提案会議に臨む（P4、P5）

段階の詳細は`docs/MEETING_MVP_SPEC.md` §11です。

## 確定していること

- 年内の銀行イベントを目指す
- 候補はみずほ銀行またはきらぼし銀行
- 日本証券新聞も別角度の候補
- 初期対象は小学4〜6年生と保護者30〜50組
- 市場は人工市場。プレイヤーと約100のNPC商会が売買し、注文は締切ごとに一斉に約定する（D-024）
- 提案会議では、5〜6人が各自のスマートフォンで参加する約5分の対戦を見せる（D-024）
- 提案会議、銀行イベント、学校、一人版のすべてで同じエンジンとアプリを使う（D-002、D-024）
- イベントの盛り上がりと継続利用を優先して検証する
- 教育効果のための行動データも取得する
- イベント後はまず一人用追加シナリオ1本を配信する
- 一人版は自動進行し、参加者数に依存しない市場にする（D-005）
- NPC注文とプレイヤー注文を同じ価格計算へ通す（D-019）
- 親子は1台を共有し、情報を隠さない（D-018）
- 調査券は第3幕または第4幕のどちらかで1回使う（D-020）
- 本命と資金配分率は現在保有分の取得原価と現金から導出する（D-021）
- 学校へ無償提供できる動線がある
- 反応が良ければ毎週配信を検討する
- ゲスっち／F-Sportsが発想の原点だが、接続方式は未決定

## 今回承認された設計

| ID | 内容 | 詳細 |
| --- | --- | --- |
| D-025 | 約定をバッチLMSR・新価格一律約定にする（予約、全員同時の1口減、倍率k） | `docs/MARKET_SPEC.md` |
| D-026 | NPC100商会の注文表を開発時に生成し、レビュー後に固定する | `docs/MARKET_SPEC.md` §9 |
| D-027 | 技術構成（`apps/web`の単一Next.jsアプリ、Prisma、Postgres、Supabase東京、Vercel hnd1、ポーリング同期） | `docs/ARCHITECTURE.md` |

## 文書

- `README.md`、`AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING.md`
- `docs/PROJECT_CHARTER.md`：目的と範囲
- `docs/PRODUCT_STRATEGY.md`：事業と展開の仮説
- `docs/GAME_DESIGN.md`：ルールと体験
- `docs/MARKET_SPEC.md`：人工市場と一斉約定の規則（新規）
- `docs/SCENARIO_01.md`：第1シナリオの本文と値（新規。旧デモの文面を引き継ぐ）
- `docs/MEETING_MVP_SPEC.md`：提案会議MVPの範囲、画面、受け入れ条件、手順、計画（新規）
- `docs/EVENT_MVP_PRD.md`：銀行イベントMVPの要件
- `docs/ARCHITECTURE.md`：エンジン、状態機械、同期、構成、データ、API
- `docs/DATA_AND_EVALUATION.md`：KPI、ログ、教育評価、プライバシー
- `docs/AI_WORKFLOW.md`：共同開発の手順
- `docs/ROADMAP.md`：フェーズとゲート
- `docs/DECISIONS.md`：意思決定の記録

## 実装済み成果物

- `apps/web/src/engine/`：純関数のゲームエンジン
  - 清算（バッチLMSR・新価格一律約定、全員同時の1口減）
  - 予約の検証、台帳、決算、予測の導出（D-021）
  - 状態機械、NPCの方針と注文表の生成器、ハッシュ
- `apps/web/src/scenarios/s01/`：第1シナリオ（会議用5ラウンド版）の定義と、k=2のNPC注文表（229件、ハッシュ`7d6d6bed70b818e2`）
- `apps/web/src/sim/`：試合を最後まで回す補助と、設計ルールA・Bの判定
- `apps/web/scripts/`：`simulate.ts`（1万試合、kの表）、`generate-npc-sheet.ts`
- `apps/web/tests/engine/`：40件のテスト
  - 不変条件、試算例、裁定の不可
  - ルールA・B、状態機械、調査券、決算
  - エンジンが外部を読み込まないこと
- `apps/web/prisma/`、`compose.yaml`：DBのスキーマとマイグレーション、ローカルのPostgres 17（5433番）
  - 9テーブル。負の残高・保有を拒否するCHECK制約とトリガー、全テーブルのRLS
- `apps/web/src/server/`：参加、予約（枠単位で冪等）、締切処理（`advance`。清算・決算を同じトランザクションで）、調査券、運営操作、画面に返す状態（公開時刻まで新価格を隠す）
- `apps/web/src/app/api/`：API 8本。入力はzodで確かめ、書き込みには独自ヘッダーとJSONを必須にする
- `apps/web/src/app/`：参加者（`/m/[code]`）、運営（`/host/[id]`）、会場（`/screen/[id]`）の最小限の画面
- `apps/web/tests/db/`：DB統合テスト13件
- 画面（P3）：参加者（スマートフォン優先、下から出る注文パネル）、運営（参加用QRコード、各商会の接続状況と予約数）、会場（TV向け）
  - 公開の演出、注文の内訳、順位、リプレイの折れ線（SVG）を含む。Tailwind 4で作った
- `apps/web/tests/e2e/`：Playwrightで、参加者6（うち3人は360px幅）・運営・会場の8画面が5ラウンドを完走するE2E
- `next.config.ts`：CSP（読み込み先は自分のサイトだけ）とセキュリティヘッダー
- `apps/web/scripts/`：`create-match.ts`（試合の作成）、`smoke.ts`（6商会がHTTP経由で完走するかの確認）
- `.tool-versions`（asdf、nodejs 24.16.0）、`.python-version`（uv、3.12）、`scripts/check_docs.py`（文書の参照チェック、`uv run`）

旧単一HTMLデモは2026-10-29に削除しました（D-024）。

## 次の作業

最優先：オーナーが実機5〜6台で内部テストを行う（`MEETING_MVP_SPEC.md` §12）。並行して、提案会議の日程と最大人数（O-011）と、クラウドの契約形態（O-012）を確認する。

次の順に進めます。

1. 内部テストの気づきを直す（文言、時間配分、分かりにくい操作）
2. P4：クラウドの契約形態（O-012）と費用の承認を得てから、本番環境（Supabase東京、Vercel hnd1）を作る。4G回線でリハーサルを2回行い、録画を残す

## 優先度の高い未決事項

1. 提案会議の日程と最大人数（O-011）
2. クラウドの契約形態：kabu-leagueのSupabase組織・Vercelチームを流用できるか、独自ドメインを使うか（O-012）
3. 開催銀行と開催日（O-005）
4. 将来案：参加者の注文に反応するNPC（AI）（O-013、issue #7）
5. 将来案：参加者が増えたときのライブ価格（連続約定）モード（O-014、issue #6）

完全な一覧は`docs/DECISIONS.md`のOpen decisionsを参照してください。

## 現時点でしてはいけないこと

- `docs/ARCHITECTURE.md`にない依存を、目的・費用・出口を書かずに追加する
- 承認前に、クラウド（Supabase、Vercel）や有料プランを作成・契約する
- CIを追加する
- 実行時生成AIをゲーム進行に入れる
- 毎週配信や課金を約束する
- 実在の児童・保護者データを保存する
- ゲスっちと深く統合する

## リスク

- 「注文時点の価格では買えず、締切後の新価格で約定する」ことを、子どもが理解できるか（提案会議と内部テストで確認し、イベント前に子ども向けのテストを行う）
- Supabase Freeは7日間アクセスがないと停止し、Vercel Hobbyは非商用に限られる。会議当日に止まらないよう、契約形態を先に決める必要がある
- 提案会議の日程が近い場合、P1〜P4の期間（実装8〜10日＋リハーサル）が足りない
- 年内開催には銀行側の意思決定期間を含む余裕が必要
- イベント満足度と実際の継続利用には差があり得る
- 単発イベントだけでは教育効果を断定できない
- 会場の回線と運営の復旧手順が、イベントの成否へ直接影響する

## 引き継ぎテンプレート

作業終了時は、この文書の該当箇所を更新し、必要なら以下を追記してください。

```md
### YYYY-MM-DD — 作業名

- 目的：
- 完了：
- 変更ファイル：
- 検証：
- 決定：
- 未解決：
- 次の一手：
```

## 作業履歴

### 2026-09-02 — プロジェクト文書の初期化

- 目的：セッションが切れても、Codex、Claude Code、人間が同じ前提から作業できる状態を作る
- 完了：企画、戦略、ゲーム設計、プロトタイプ、本番PRD、論理設計、データ、ロードマップ、意思決定、引き継ぎ文書を作成
- 検証：ローカル文書リンク、競合マーカー、空ファイル、Git差分エラーを確認済み
- 決定：`AGENTS.md`を共通指示の正本とし、`CLAUDE.md`から参照する
- 未解決：オーナーによる文書内容のレビュー
- 次の一手：オーナーが文書をレビューし、修正点を正本へ反映する

### 2026-09-02 — GitHubリポジトリ作成

- 目的：共同作業の正本となる履歴を作る
- 完了：`TIshow/fantasy-finance-rpg`を非公開で作成し、`origin`へ設定
- 検証：GitHub CLIで所有者`TIshow`、可視性`PRIVATE`、`origin`、既定ブランチ`main`を確認済み
- 決定：詳細は`docs/DECISIONS.md`のD-017
- 未解決：なし
- 次の一手：以後の実装は文書レビューと技術選定後、短命ブランチで開始する

### 2026-09-02 — セッション決定の文書反映

- 目的：Claude Codeとの企画整理セッションで出た判断を、チャット履歴ではなく正本へ移す
- 完了：D-018〜D-022を追加し、D-014をSupersededにした。ゲーム設計、イベントPRD、論理設計、プロトタイプ仕様の該当記述を更新
- 変更ファイル：`docs/DECISIONS.md`、`docs/GAME_DESIGN.md`、`docs/EVENT_MVP_PRD.md`、`docs/ARCHITECTURE.md`、`docs/PROTOTYPE_SPEC.md`、`docs/STATUS.md`
- 検証：文書間の相互参照を目視確認。アプリケーションコード、依存パッケージ、CIは追加していない
- 決定：D-018はAccepted（オーナー判断）。D-019〜D-022はProposedでレビュー待ち
- 未解決：D-019〜D-022のオーナー承認。O-002とO-005は未着手
- 次の一手：D-019を承認するか判断する。承認後、NPC注文列と流動性パラメータを決める市場シミュレータの仕様を書く

### 2026-09-02 — O-002 提案用プロトタイプ技術の決定

- 目的：1日で作り、銀行担当者の環境でも確実に動くプロトタイプの実装方式を決める
- 完了：D-023をAcceptedとして追加し、O-002をClosedにした
- 変更ファイル：`docs/DECISIONS.md`、`docs/PROTOTYPE_SPEC.md`、`docs/ARCHITECTURE.md`、`docs/STATUS.md`
- 検証：提案用プロトタイプとイベントMVPの技術判断が分離されていることを確認
- 決定：ビルド・外部依存不要、`file://`で起動できる単一HTML
- 未解決：D-019〜D-022はProposedのまま
- 次の一手：プロトタイプの画面・時間・価格変化を実装可能な粒度へ具体化する

### 2026-09-03 — D-019〜D-021の確定とプロトタイプ仕様具体化

- 目的：単一HTMLプロトタイプを、追加判断なしで実装できる状態にする
- 完了：D-019〜D-021をAcceptedへ変更。D-016をSupersededにした。約7分30秒の状態進行、NPC注文列、簡易市場計算、取得原価、調査コンテンツ、画面・ビジュアル・リプレイ・手動検証を具体化
- 変更ファイル：`docs/DECISIONS.md`、`docs/PROTOTYPE_SPEC.md`、`docs/GAME_DESIGN.md`、`docs/EVENT_MVP_PRD.md`、`docs/DATA_AND_EVALUATION.md`、`docs/ARCHITECTURE.md`、`docs/STATUS.md`
- 検証：予測専用入力を使わず、価格変化だけで予測変更と判定されないことを文書間で統一
- 決定：NPC注文列、調査券の2つの使用窓、取得原価ベースの本命導出
- 未解決：イベントMVPのD-015、D-022、O-003は本番着手時に判断する
- 次の一手：オーナーの仕様レビュー後、実装開始指示を得る

### 2026-09-03 — 銀行提案用プロトタイプ実装

- 目的：銀行担当者がGUILD MARKETの判断ループを5〜10分で体験できる状態を作る
- 完了：単一HTMLに4市場、売買、NPC注文、役割面、調査券、AI／一次情報、決算、リプレイ、ローカル復帰を実装。依存なしの検証スクリプトを追加
- 変更ファイル：`prototype/guild-market-demo.html`、`scripts/verify-prototype.mjs`、`README.md`、`AGENTS.md`、`CONTRIBUTING.md`、`docs/PROTOTYPE_SPEC.md`、`docs/STATUS.md`
- 検証：`node scripts/verify-prototype.mjs`と`tidy -errors -quiet -utf8 prototype/guild-market-demo.html`が成功。外部URL参照0件、NPC基準経路はドラゴン価格23→30→12→9→29G、各時点で表示価格合計100G
- 決定：新規の製品・技術決定なし。D-023の範囲内で実装
- 未解決：実ブラウザでの`file://`完走、360px／1280pxの最終目視、内部プレイテスト
- 次の一手：オーナーまたはClaude Codeが手動チェックリストを実施し、気づきをPRへ記録する

### 2026-10-29 — 人工市場・一斉約定への全面切替

- 目的：オーナー提供の「人工市場・定時一括注文 統合ハンドオフv0.2」を正本と照合し、提案会議で5〜6人が各自のスマートフォンから対戦できるMVPを設計する。オーナーの判断（全体を新方式に切り替え、旧デモは削除してよい）を正本に反映する
- 完了：
  - 設計レビューを行い、その内容を新しい仕様書に分けて書いた
    - 旧デモの価格計算では往復売買で利益が出ることを確認した
    - 6人の逆張りで山場が消える条件を試算し、倍率kの設計ルールを作った
    - 新価格一律約定の清算規則と、台帳を検算した試算例6件を書いた
    - NPC100商会の生成方針、状態機械、ポーリング同期、共通エンジン、データモデル、API、運用手順、受け入れ条件、実装計画を書いた
  - D-024をAcceptedで追加した。D-006・D-013・D-023をSuperseded、D-015をD-025へ、D-022をD-027へ統合した。D-025〜D-027はProposed。O-011〜O-013を追加した
  - ゲーム設計、イベントPRD、アーキテクチャ、ロードマップ、憲章、戦略、データ評価、AI共同開発の手順、README、AGENTS、CONTRIBUTINGを新方式に合わせた
  - 旧単一HTML、検証スクリプト、`PROTOTYPE_SPEC.md`を削除した。シナリオの文面と調査結果は`SCENARIO_01.md`へ、画面とビジュアルの知見は`MEETING_MVP_SPEC.md`へ移した
- 変更ファイル：
  - 新規：`docs/MARKET_SPEC.md`、`docs/SCENARIO_01.md`、`docs/MEETING_MVP_SPEC.md`
  - 更新：`docs/GAME_DESIGN.md`、`docs/ARCHITECTURE.md`、`docs/EVENT_MVP_PRD.md`、`docs/DECISIONS.md`、`docs/ROADMAP.md`、`docs/PROJECT_CHARTER.md`、`docs/PRODUCT_STRATEGY.md`、`docs/DATA_AND_EVALUATION.md`、`docs/AI_WORKFLOW.md`、`docs/STATUS.md`、`README.md`、`AGENTS.md`、`CONTRIBUTING.md`
  - 削除：`prototype/guild-market-demo.html`、`scripts/verify-prototype.mjs`、`docs/PROTOTYPE_SPEC.md`
- 検証：
  - 市場の試算は使い捨てのスクリプトで行い、リポジトリには入れていない（P1で正式なテストにする）
  - 文書内の相対リンクがすべて解決すること、削除したファイルへの参照が履歴以外に残っていないことを確認した
- 決定：D-024（Accepted、オーナー判断）。D-025〜D-027はProposed
- 未解決：D-025〜D-027の承認、提案会議の日程と人数（O-011）、クラウドの契約形態（O-012）
- 次の一手：オーナーがD-025〜D-027を承認したら、P1（エンジンとシミュレータ）に着手する

### 2026-10-29 — D-025〜D-027の承認と将来案の記録

- 目的：オーナーの承認を正本に反映し、将来案を追跡できる形で残す
- 完了：D-025〜D-027をAcceptedにした。オーナーの将来案を次の2件のissueにまとめた
  - [#6](https://github.com/TIshow/fantasy-finance-rpg/issues/6)：参加者が増えたときのライブ価格（連続約定）モード。O-014を追加
  - [#7](https://github.com/TIshow/fantasy-finance-rpg/issues/7)：参加者の注文に反応するNPC（AI）。O-013を更新
- 変更ファイル：`docs/DECISIONS.md`、`docs/MARKET_SPEC.md`、`docs/ARCHITECTURE.md`、`docs/MEETING_MVP_SPEC.md`、`docs/EVENT_MVP_PRD.md`、`docs/PROJECT_CHARTER.md`、`docs/ROADMAP.md`、`docs/STATUS.md`、`README.md`、`AGENTS.md`、`CONTRIBUTING.md`
- 検証：文書内のリンクと「§」での参照を確認
- 決定：D-025〜D-027（Accepted、オーナー承認）
- 未解決：提案会議の日程と人数（O-011）、クラウドの契約形態（O-012）
- 次の一手：P1（`apps/web`の雛形、`.tool-versions`、エンジン、シナリオ、NPC生成器、シミュレータ）に着手する

### 2026-10-29 — P1：ゲームエンジンとシミュレータ

- 目的：画面やDBから独立した共通ゲームエンジンを作り、約定方式（D-025）とNPC（D-026）が仕様どおりに動くことを数値で確かめる
- 完了：
  - `apps/web`の雛形（Next.js 16.2.7、React 19.2.4、TypeScript、Vitest、tsx。バージョンはkabu-leagueに合わせた）
  - エンジン、第1シナリオ、NPC注文表の生成器と、k=2の注文表
  - シミュレータとテスト37件
  - Nodeはasdf、Pythonはuvで動かす設定と、文書の参照チェック
- 変更ファイル：`apps/web/`（新規）、`.tool-versions`、`.python-version`、`scripts/check_docs.py`、`AGENTS.md`、`CONTRIBUTING.md`、`README.md`、`docs/MARKET_SPEC.md`、`docs/SCENARIO_01.md`、`docs/ARCHITECTURE.md`、`docs/MEETING_MVP_SPEC.md`、`docs/DECISIONS.md`、`docs/STATUS.md`
- 検証：
  - `npm test`（37件成功）、`npm run typecheck`、`npm run build`が成功
  - `npm run simulate`：1万試合で不変条件の違反0件、決算後の市場係の現金は最小27,332G
  - 参加者0人の価格は、k=1〜4のすべてで目標と一致
  - `uv run scripts/check_docs.py`が成功
- 決定：提案会議はk=2、上限10口（ルールA・Bを満たす。k≥3ではルールBを満たさない）
  - 試算例と会計の数値（市場係の開始資金56,286Gなど）は、エンジンの出力に合わせて`MARKET_SPEC.md`を更新した
  - エンジンの境界はESLintではなくテストで確かめる。ESLintは画面を作るP3で必要なら入れる
  - 状態機械に、運営による中止（`ABORTED`）を加えた
- 未解決：提案会議の日程と人数（O-011）、クラウドの契約形態（O-012）
- 次の一手：P2（Docker、Prisma、注文・締切・決算のトランザクション、API、DB統合テスト）

### 2026-10-29 — P1のレビュー修正（PR #9）

- 目的：リファクタリング、読みやすさ、構成、セキュリティの観点でP1のエンジンを見直す
- 完了：
  - 予約の検証：売買の向き（buy/sell）を確かめ、受け取った入力から必要な項目だけで注文を作る（口座IDや予約額を入力で上書きさせない）
  - 清算の入力検証：同じ口座・ギルドの重複注文と、負の予約額を拒否する（並び順への依存と、減らす処理が終わらないことを防ぐ）
  - 調査券の使用済み判定を`Object.hasOwn`にした（参加者IDが`__proto__`でも誤判定しない）。延長の時間は有限の正の数だけ受け付ける。注文表の生成でシードが整数か確かめる
  - 最大剰余法を`src/engine/rounding.ts`にまとめ、表示価格とNPCの口数配分で共用する。台帳の複製、状態機械の遷移、清算の集計を小さな関数に分けた
  - エンジンの境界テストが、副作用だけのimport、動的import、requireも拾うようにした
  - `simulate.ts`の口座IDの直書きをやめた
- 検証：`npm test`（40件成功）、`npm run typecheck`、`npm run build`、`uv run scripts/check_docs.py`が成功。`npm run simulate`の結果（注文表のハッシュ`7d6d6bed70b818e2`、違反0件、市場係の現金の最小27,332G）は修正前と同じ
- 次の一手：P2。APIの入力はzodで型と範囲を確かめてからエンジンに渡す

### 2026-10-29 — P2：サーバーとDB

- 目的：エンジンをDBのトランザクションに載せ、複数の端末が同じ試合を最後まで遊べるようにする
- 完了：
  - 依存：Prisma 7.10（adapter-pg）、zod 4、pg（テスト用）。ローカルDBはDockerのPostgres 17（ホストの5433番。kabu-leagueの5432番とぶつけない）
  - スキーマ：9テーブルとマイグレーション。CHECK制約、保有のトリガー、RLS
  - サービス：参加、予約・取消（版番号で冪等）、締切処理と運営操作、調査券、状態の取得
    - 締切処理と運営操作は`advance`に集めた。試合の行を FOR UPDATE でロックし、DBの時計で判定する
    - 公開時刻まで新価格と本人の約定を隠す
  - API 8本、最小限の3画面（状態の定期取得、締切処理の送信、公開時刻での取り直し）
  - スクリプト：`create-match.ts`、`smoke.ts`
- 変更ファイル：`apps/web/`（`prisma/`、`compose.yaml`、`docker/`、`.env.example`、`src/server/`、`src/app/`、`tests/db/`、`scripts/`、`package.json`、`vitest.config.ts`）、`apps/web/src/engine/phase.ts`、`apps/web/tests/engine/phase.test.ts`、`.gitignore`、`AGENTS.md`、`CONTRIBUTING.md`、`README.md`、`docs/ARCHITECTURE.md`、`docs/MARKET_SPEC.md`、`docs/MEETING_MVP_SPEC.md`、`docs/STATUS.md`
- 検証：
  - `npm run test:db`：13件成功
    - 6商会の完走でDBの結果がエンジンだけの結果と一致
    - 締切直前の同時注文、猶予の境界、再送と古い版番号、10回同時の締切処理で清算1回
    - 清算途中の失敗でロールバック、決算1回、公開時刻まで隠す、調査券の同時使用
  - `npm test`：41件成功。`npm run typecheck`、`npm run build`、`uv run scripts/check_docs.py`も成功
  - `npm run smoke`：開発サーバーで、6商会・運営・会場が5ラウンドを完走した（約45秒）。会場画面の応答に本人の情報は入らない
  - ブラウザで、参加 → 予約 → 新価格30Gで約定（予約の余りは返却）→ 決算（1,350G、本命の変化）まで操作して確認した。サーバーのエラーは0件
- 決定：設計の範囲内の実装。次の判断も含む
  - 状態機械で、tickが進めるのはニュース・受付・公開の段階だけにした（結果発表後に期限の時刻が残っていても進まない）
  - 開始後の参加は受け付けない
  - リプレイ用の別APIは作らず、決算後の状態に含める
- 未解決：提案会議の日程と人数（O-011）、クラウドの契約形態（O-012）
- 次の一手：P3（画面の作り込み、Tailwind、E2E、LANの内部テスト、セキュリティヘッダー）

### 2026-10-30 — P2のレビュー修正（PR #10）

- 目的：リファクタリング、読みやすさ、構成、セキュリティの観点でP2のサーバーを見直す
- 完了：
  - 状態の取得（`getState`）を、1つのスナップショット（REPEATABLE READ）で読むようにした。別々に読むと、途中で清算が入ったときに清算後の現金や約定が公開時刻より前に見えることがあった
  - 運営トークンの照合を、比較時間が一定の`timingSafeEqual`にした（`tokens.ts`の`tokenMatches`）
  - `next.config.ts`にセキュリティヘッダーを入れた（`frame-ancestors 'none'`、`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy: same-origin`、`X-Powered-By`なし）。運営画面を他サイトに埋め込んで操作させる攻撃を防ぐ
  - 「清算済みのラウンドか」の判定を`repo.ts`の`isRoundCleared`にまとめ、口座のロックを`lockAccount`にした。注文受付の確認でシナリオと注文表を一緒に返し、二重の取得をやめた。ログの口座IDは`teamAccountId`を使う
- 検証：`npm test`（41件）、`npm run test:db`（13件）、`npm run typecheck`、`npm run build`が成功。`npm run smoke`で6商会が5ラウンドを完走。応答ヘッダーと会場画面の表示をブラウザで確かめた
- 次の一手：P3

### 2026-10-30 — P3：画面とE2E

- 目的：会議で見せられる画面に仕上げ、8画面の通しを自動テストで確かめる
- 完了：
  - 依存：Tailwind 4.3、qrcode 1.5、Playwright 1.64（テスト用のChromium）
  - 画面：参加者・運営・会場（`MEETING_MVP_SPEC.md` §5〜§6）
    - スマートフォン優先の参加者画面（上部の残り時間バー、下から出る注文パネル）
    - 公開の瞬間に新価格を一度だけ光らせる演出、注文の内訳の棒、順位
    - 決算後のリプレイの折れ線（ニュースの位置、自分の売買、調査券、王国の商会の買い越し・売り越し）
  - 運営画面：参加用QRコードと、各商会の接続状況（最後に状態を取得してからの秒数）・予約数
    - そのために`teams.last_seen_at`を追加し（書き込みは5秒に1回まで）、運営専用のAPI（`/api/m/:id/teams`）を作った
  - CSP：読み込み先を自分のサイトだけに絞った
  - 試合の作成にE2E用の時間設定とJSON出力を足した。LAN用の起動（`npm run start:lan`）と内部テストの手順（§12）を書いた
- 変更ファイル：`apps/web/`（`src/app/`、`src/server/state.ts`、`prisma/`、`next.config.ts`、`postcss.config.mjs`、`playwright.config.ts`、`tests/e2e/`、`scripts/create-match.ts`、`package.json`、`.gitignore`）、`AGENTS.md`、`CONTRIBUTING.md`、`README.md`、`docs/ARCHITECTURE.md`、`docs/MEETING_MVP_SPEC.md`、`docs/STATUS.md`
- 検証：
  - `npm run test:e2e`：本番ビルドで8画面が5ラウンドを完走した（約1.4分）
    - 全画面の公開時刻の差は59ms（目標は1秒以内）
    - 再読み込みで商会と保有が戻り、360px幅でも注文ボタンが画面に収まる
  - `npm test`（41件）、`npm run test:db`（13件）、`npm run typecheck`、`npm run build`、`uv run scripts/check_docs.py`：成功
  - ブラウザで、360px幅の参加者画面（参加、予約、公開、約定）と会場画面を目で確かめた
- 決定：
  - 途中順位は、一度でも公開したあとは常に見せる（公開時刻の前は隠す）。これまでは公開フェーズの10秒間だけだった
  - CSPはnonceではなく`'unsafe-inline'`で始める。外部のスクリプトは使わない
  - E2Eは3210番で動かす（3100番はほかのプロジェクトが使っているため）
- 未解決：
  - 実機5〜6台での内部テスト（オーナー）
  - 提案会議の日程と人数（O-011）、クラウドの契約形態（O-012）
- 追記（LANでの確認）：`npm run start:lan`でスマートフォンから参加すると、操作できなかった
  - 原因：本番モードでは、参加者のcookieに常に`Secure`を付けていた。httpのLAN（`http://192.168.x.x`）ではブラウザがcookieを保存しないため、本人として認識されなかった
  - E2Eはlocalhostで動かしていたため見つからなかった
  - 修正：`Secure`は接続がHTTPSのときだけ付ける（本番のVercelはHTTPS）。オーナーが実機で参加・操作できることを確認した
- 次の一手：内部テストの気づきを直してから、P4（本番環境とリハーサル）
