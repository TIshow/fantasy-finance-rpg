# Architecture

最終更新：2026-10-29
状態：**Accepted**（D-027。2026-10-29にオーナー承認。クラウドの作成と費用はP4の前に別途承認）

## 1. 目的

提案会議MVPから、銀行イベント、一人用の追加シナリオ、学校版まで、同じアプリとゲームエンジンで広げるための境界と構成を定めます（D-024）。市場の規則は`MARKET_SPEC.md`、提案会議MVPの範囲は`MEETING_MVP_SPEC.md`にあります。

## 2. アーキテクチャ原則

1. ゲームルールとシナリオコンテンツを分離する
2. ライブ進行（自動・手動）と一人用の自動進行を、同じ状態機械で扱う
3. 市場参加人数が1人でも成立させる
4. 注文、残高、価格、状態、精算はサーバー側で確定する
5. 重要操作を冪等にし、再送と再接続へ耐える
6. 全市場イベントを時系列で再生できるようにする
7. 実行時生成AIをイベントの事実生成に使わない
8. 個人情報を最小化し、計測用IDと本人情報を分離する
9. 運営者の手動制御と緊急停止を第一級機能にする
10. 外部サービスは交換可能な境界の後ろに置く
11. 清算の結果を、注文の到着順やブラウザの時計に依存させない

## 3. 論理構成

```mermaid
flowchart TD
    Scenario["シナリオ<br/>本文・値・NPC注文表"]
    Engine["ゲームエンジン（純関数）<br/>市場・NPC方針・状態機械・決算・予測"]
    Server["サーバー<br/>トランザクション・advanceIfDue・トークン検証"]
    DB[("Postgres<br/>状態・注文・約定・ログ")]
    Participant["参加者の画面"]
    Host["運営の画面"]
    Venue["会場画面"]

    Scenario --> Engine
    Server --> Engine
    Server <--> DB
    Participant <-->|"ポーリング・注文"| Server
    Host <-->|"ポーリング・運営操作"| Server
    Venue <-->|"ポーリング"| Server
```

## 4. 共通ゲームエンジン

### 4.1 エンジンの関数

DB、HTTP、時刻、乱数の取得に依存しない純関数です。時刻と乱数のシードは引数で受け取ります。

```ts
// apps/web/src/engine（index.tsから読み込む）
// 市場と台帳（match.ts、clearing.ts、ledger.ts）
createMatch(scenario, npcSheet, teamIds): MatchState
placeOrder(match, scenario, teamId, intent): { ok, match, order } | { ok: false, reason }   // 1ギルド1枠、置き換え
cancelOrder(match, teamId, guildId): MatchState
clearCurrentRound(match, npcPolicy): { match, record }      // clearRound＋台帳＋予測（D-021）
clearRound({ market, orders }): ClearingResult              // 価格、約定、統計、入力・出力ハッシュ
investigate(match, scenario, teamId, source)                // 調査券（D-020）
settleMatch(match, scenario): MatchState                    // 1口100G。2回目は何もしない
ranking(match)、checkInvariants(match)
// 進行（phase.ts）
phaseAfter(progress, trigger, timing): Transition           // 遷移と、一緒に行う処理（clearRound、settle）
acceptsOrders(progress, now, timing): boolean               // 締切＋猶予まで
// NPC（npc.ts）
fixedSheetPolicy(npcSheet): NpcPolicy                       // 差し替え可能な方針。最初は固定の注文表だけ
generateNpcSheet(scenario, { k, seed }): NpcSheet           // 開発時だけ使う
```

NPCの方針は差し替え可能な部品にします。最初の実装は、固定の注文表を読むだけです（D-026）。

### 4.2 シナリオ

型は`apps/web/src/engine/scenario.ts`の`Scenario`、第1シナリオの値は`apps/web/src/scenarios/s01/`にあります。

保持するもの：

- タイトル、世界観、ギルド、表示順
- 初期価格（初期のq）
- ラウンド、ニュース、補足情報、各フェーズの時間
- 調査券の窓、調査先と調査結果
- NPC商会の定義と、生成・レビュー済みの注文表とそのハッシュ
- 最終結果

保持しないもの：

- プレイヤーの残高と保有
- 注文処理と清算のロジック
- 認証・権限
- UIだけの一時状態

### 4.3 遊び方ごとの使い方

- **ライブ（提案会議、銀行イベント）：** サーバーがDBから状態を読み、エンジンを呼び、結果を1つのトランザクションで書きます。
- **一人版（オンライン）：** 同じエンジンを、参加者1商会・自動進行の試合として動かします。
- **一人版（オフライン）：** エンジンとシナリオはブラウザだけで動くため、将来は静的ページにまとめられます（別のADRで判断）。
- **長時間の一人版（毎時更新など）：** 期限を1時間にして、定期実行が`advanceIfDue`を呼ぶだけです。新しい進行の仕組みは要りません。
- **各自が独立した市場で競うランキング：** 試合をプレイヤーごとに作れば成り立ちます（将来）。

## 5. 状態機械と進行

```mermaid
stateDiagram-v2
  [*] --> LOBBY
  LOBBY --> NEWS: 運営が開始
  NEWS --> ORDER_OPEN: 時間経過
  ORDER_OPEN --> PUBLISHED: 締切＋猶予後の締切処理／運営の早期締切（同じトランザクションで清算）
  PUBLISHED --> NEWS: 時間経過（次ラウンド）
  PUBLISHED --> RESULT: 最終ラウンド（同じトランザクションで決算）
  NEWS --> PAUSED: 運営が一時停止
  ORDER_OPEN --> PAUSED: 運営が一時停止
  PUBLISHED --> PAUSED: 運営が一時停止
  PAUSED --> NEWS: 再開（残り時間を復元）
  PAUSED --> ORDER_OPEN: 再開（残り時間を復元）
  PAUSED --> PUBLISHED: 再開（残り時間を復元）
  RESULT --> [*]
  ABORTED --> [*]
```

- 運営はRESULT以外のどの段階からも試合を中止できます（`ABORTED`。図では省略）。
- 注文は`ORDER_OPEN`のときだけ受け付けます。
- 実装は`apps/web/src/engine/phase.ts`の`phaseAfter`です。遷移と一緒に行う処理（清算、決算）を返し、サーバーが同じトランザクションで実行します。
- 清算は締切処理のトランザクションの中で完結します（計算は数ミリ秒）。「締切済み」「清算中」を永続状態にしないので、失敗すればロールバックされ、次の締切処理で再試行するだけです。50組規模やNPCの計算が重くなった段階で、2段階に分けます。
- 締切の判定には、ロック取得後のDBの`clock_timestamp()`を使います。ブラウザのタイマーは表示専用です。
- 猶予は1秒です。締切＋1秒までに届いた注文は受け付け、締切処理は締切＋1秒以降にだけ清算します。
- 一時停止中は予約の新規・変更を受け付けません。既存の予約は保持し、再開時に残り時間から続けます。確定した清算は巻き戻しません。補正が必要なら、補正の取引として記録します。
- 手動モードでは期限で自動進行せず、運営の「次へ」だけで進みます（銀行イベントの司会進行向け）。提案会議MVPの既定は自動進行です。
- 練習、ブリーフィング、デブリーフなどイベント版の段階は、この状態機械の上に表示の段階として載せます。詳細はイベントMVPの着手時に決めます。
- すべての遷移と運営操作を`match_events`に記録します（誰が、いつ、何を）。

## 6. 同期

- 正はDBです。状態が変わるたびに`matches.version`を1増やします。
- クライアントは`GET /state?since=v`を、注文受付中と締切の前後は1秒ごと、それ以外は3秒ごとに呼びます。非表示のタブでは止め、表示に戻った瞬間に取得します。変化がなければ空の応答を返します。
- **公開の同時性：** 清算時に`reveal_at = 清算時刻＋2秒`を保存します。各端末は応答に含まれる`serverNow`で時計のずれを補正し、`reveal_at`の瞬間に一斉に新価格を表示します。ポーリング間隔（1秒）が待ち時間（2秒）より短いので、全端末が間に合います。
- **締切処理を起動する役：** 運営画面と会場画面は、締切に達したら締切処理を送ります（進むまで2秒ごとに再送）。参加端末も、締切を過ぎた状態を受け取ったら送ります。誰が送っても1回しか処理されません。
- WebSocketはiOS Safariの画面ロックやバックグラウンドで切れるため、どのみち復帰時の再取得が必要です。そのため、最初はポーリングだけで作ります。
- 6〜8端末が1秒に1回取得しても、VercelとPostgresには軽い負荷です。50組でも、索引つきの1行読みが毎秒50回です。必要になれば、Supabase Realtime Broadcastを「起床通知」としてあとから足せます。

## 7. 構成と依存

```text
apps/web/                         # 独立したnpmプロジェクト。リポジトリのルートには依存を置かない
  package.json                    # Node 24、npm（kabu-leagueに合わせる）
  vercel.json                     # regions: ["hnd1"]
  compose.yaml                    # ローカルのPostgres 17（ホストの5433番。テスト用DBも作る）
  prisma/schema.prisma, migrations/
  src/engine/                     # 純関数。同じディレクトリ以外の読み込みをテストで禁止（tests/engine/purity.test.ts）
  src/scenarios/s01/              # 第1シナリオの定義（scenario.ts）とNPCの注文表（npc-sheet.k2.json）
  src/sim/                        # 試合を最後まで回す補助と設計ルールの判定（テストとシミュレータで共有）
  src/server/                     # トランザクション（service.ts）、画面に返す状態（state.ts）、DBとエンジンの変換（repo.ts）
  src/app/m/[code]/               # 参加者
  src/app/host/[id]/              # 運営
  src/app/screen/[id]/            # 会場画面
  src/app/api/                    # Route Handlers
  scripts/                        # simulate.ts、generate-npc-sheet.ts、create-match.ts、smoke.ts
  tests/                          # engine、db（実際のPostgresを使う）、e2e（P3）
.tool-versions                    # nodejs 24.16.0（asdf）
.python-version                   # 3.12（uv）
scripts/check_docs.py             # 文書の参照チェック（uv run）
```

| 依存 | 目的 | 費用 | 出口 |
| --- | --- | --- | --- |
| Next.js 16、React 19、TypeScript 5 | 画面とAPIを1つのアプリにする（kabu-leagueと同じ） | 0 | 通常のNodeサーバーとして動かせる |
| Prisma 7＋`@prisma/adapter-pg` | スキーマ、移行、トランザクション（kabu-leagueと同じ） | 0 | SQLの移行ファイルに置き換えられる |
| zod 4 | APIの入力検証 | 0 | 手書きの検証に置き換えられる |
| Tailwind CSS 4 | スマートフォン向けの画面（kabu-leagueと同じ。P3で導入） | 0 | 通常のCSSに置き換えられる |
| Vitest、tsx | エンジンとDBのテスト、スクリプトの実行 | 0 | — |
| asdf（Node 24.16.0） | Nodeのバージョンを揃える（kabu-leagueと同じ） | 0 | `.tool-versions`はほかのバージョン管理でも読める |
| uv（Python 3.12） | 文書チェックなどPythonのスクリプトを動かす。外部パッケージは使わない | 0 | 通常のPythonで動く |
| Playwright | 複数端末のE2E（P3で導入） | 0 | — |
| Docker（Postgres 17） | ローカル開発とDB統合テスト | 0 | — |
| Supabase（Postgresのみ、東京） | 本番DB | Freeは7日間アクセスがないと停止する。Proは月25ドル〜（契約前に確認。既存の組織を流用できる可能性あり） | `pg_dump`で他のPostgresへ移せる |
| Vercel（hnd1） | ホスティング | Hobbyは非商用に限られる。Proは1人月20ドル〜（契約前に確認。既存のチームを流用できる可能性あり） | Nodeが動く環境ならどこでも動く |

- SupabaseはPostgresとしてだけ使い、RealtimeやAuthに依存しません。そのため、ほかのPostgresへ移しやすい構成です。
- Vercelの既定リージョン（米国東部）では、Supabase東京との往復が1クエリ150ms前後かかり、注文1件のトランザクションが1秒を超えかねません。kabu-leagueと同じく`hnd1`に固定します。
- 定期実行（Cron）は使いません。進行は`advanceIfDue`という1つの関数に集め、誰が何回呼んでも冪等にします。Cronは長時間の一人版で、この関数を呼ぶ役として足すだけです。
- CIは追加しません（必要になれば別途判断します）。

## 8. データモデル

正本は`apps/web/prisma/schema.prisma`とマイグレーション（`apps/web/prisma/migrations/`）です。

```text
matches(id, join_code, scenario_id, scenario_hash, sheet_hash, algorithm_version, k_scale,
        phase, mode, round, total_rounds, phase_ends_at, paused_from, paused_remaining_ms, reveal_at,
        timing, q, capacity, version, host_token_hash, created_at, settled_at)
teams(id, match_id, nickname, token_hash, joined_at)                    UNIQUE(match_id, nickname)、UNIQUE(token_hash)
accounts(id, match_id, key, kind[player|npc|mm], team_id, cash)         UNIQUE(match_id, key)、CHECK(kind='mm' OR cash >= 0)
positions(account_id, guild_id, qty, cost_basis)                        PK(account_id, guild_id)、市場係以外は qty >= 0（トリガー）
orders(id, match_id, round, account_id, guild_id, side, qty, reserve_cash, revision, status[active|cancelled], updated_at)
                                                                        UNIQUE(match_id, round, account_id, guild_id)
round_clearings(match_id, round, algorithm_version, prices_before, prices, q_after, stats, forecasts,
                input_hash, output_hash, created_at)                    PK(match_id, round)
fills(id, match_id, round, account_key, kind, guild_id, side, requested, filled, price, cash_delta, reason)
investigations(match_id, team_id, round, source, used_at)              PK(match_id, team_id)
match_events(id, match_id, type, actor, public_payload, created_at)     -- 監査とリプレイ
```

- 金額と口数は整数だけです。小数は保存しません。
- `accounts.key`はエンジンの口座ID（`team:<teamId>`、`npc:<key>`、`mm`）です。
- `matches.q`は現在のLMSRの状態です。`matches.timing`は試合ごとの時間配分で、内部テストの短縮版に使います。
- CHECK制約とトリガーで、負の残高と負の保有を拒否します（市場係を除く）。
- NPCの注文はシナリオの注文表から読みます。作成時の注文表とシナリオのハッシュを`matches`に保存し、変わっていたら清算を止めます。NPCの約定は`fills`に保存します（100商会×5ラウンドで最大500行）。
- 予約は取り消しても行を残し（`status = cancelled`）、版番号を進めます。古い画面からの上書きと再送を見分けるためです。
- 取得原価（`cost_basis`）は現在保有分のコストです。売却時は売却口数に対応する平均原価を減らします（D-021）。
- 予測スナップショット（D-021）は、清算のたびに`round_clearings.forecasts`へ保存します。
- 全テーブルでRLSを有効にし、ポリシーは置きません（§10）。
- 個人情報は商会名だけです。トークンはハッシュだけを保存します。

## 9. APIとトランザクション

| メソッド | パス | 呼ぶ人 | 内容 |
| --- | --- | --- | --- |
| GET | `/api/code/:code` | 参加者 | 参加コードから試合IDを引く |
| POST | `/api/join` | 参加者 | `{code, nickname}`。httpOnly cookie（試合ごと）を発行 |
| GET | `/api/m/:id/state?since=` | 全員 | 公開状態と本人の資産・予約・約定。本人の情報がなく版番号も同じなら中身を省く |
| PUT | `/api/m/:id/r/:seq/orders/:guildId` | 参加者 | `{side, qty, baseRevision}`。枠単位で冪等 |
| DELETE | 同上 | 参加者 | `{baseRevision}`。予約の取消 |
| POST | `/api/m/:id/investigate` | 参加者 | `{source}`。1試合で1回 |
| POST | `/api/m/:id/tick` | 誰でも | `advanceIfDue`。期限前なら何もしない |
| POST | `/api/m/:id/host/:action` | 運営 | start、pause、resume、extend、close-now、next、abort。`x-host-token`ヘッダーが必要 |
| GET | `/api/m/:id/screen` | 会場画面・運営 | 公開情報だけ |

- 書き込み系は`x-gm-client: 1`ヘッダーとJSONを必須にします。入力はzodで確かめます。
- 公開時刻（`reveal_at`）の前は、公開状態にも本人の状態にも清算前の値を返します。全端末が公開時刻に取り直して、一斉に新価格を表示します。決算後は、価格の推移と本人の全約定を返します（リプレイ用の別APIは作らない）。
- 試合の作成は`scripts/create-match.ts`（CLI）で行い、管理画面は作りません。
- 実装は`apps/web/src/server/`（`service.ts`、`state.ts`、`repo.ts`、`http.ts`）と`apps/web/src/app/api/`です。

```text
注文（PUT）
BEGIN
  SELECT … FROM matches WHERE id = $1 FOR SHARE        -- 締切処理（FOR UPDATE）と直列化
  phase = ORDER_OPEN、round一致、clock_timestamp() < phase_ends_at + 猶予 を確認（手動モードは期限なし）
  SELECT … FROM accounts WHERE id = $2 FOR UPDATE      -- 同じ商会の同時注文を直列化
  baseRevision が今の版なら更新。1つ前で内容が同じなら再送として今の結果を返す。それ以外は409
  自由現金 = cash − 他の枠の予約合計、売れる口数 = 保有口数
  検証 → orders を upsert（revision + 1）
COMMIT

締切処理（tick）
BEGIN
  SELECT … FROM matches WHERE id = $1 FOR UPDATE
  phaseAfter() で遷移を決める。期限前、一時停止中、結果発表後なら何もせずCOMMIT
  ORDER_OPENなら：予約とNPC注文表で clearRound() → fills、positions、accounts、round_clearings を書き、
                   phase = PUBLISHED、reveal_at、version + 1
  最終ラウンドのPUBLISHEDなら：settle() → settled_at を記録
COMMIT
```

## 10. 認証・セキュリティ・プライバシー

- **参加：** 参加コード（6桁）と商会名で参加します。サーバーは32バイトの乱数トークンを発行し、試合ごとのhttpOnly・SameSite=Laxのcookieに入れます（本番ではSecureも付ける）。DBにはSHA-256のハッシュだけを保存します。開始後の参加は受け付けません（運営が許可する仕組みは、必要になったら足す）。提案会議MVPの定員は12商会です。
- **運営：** 試合の作成時に別の32バイトの乱数トークンを発行し、運営画面のURLの`#`以降に入れます（サーバーのログや参照元に残りません）。参加コードから運営権限には届きません。これは提案会議MVPだけの暫定措置です。イベントMVPでは、Supabase Authなどで改めて判断します（O-007）。
- 書き込み系のAPIでは独自ヘッダーとJSONを必須にします（CSRF対策）。注文の持ち主はトークンから決め、URLのIDを信用しません。
- すべての応答に、他サイトへの埋め込みを禁じるヘッダー（`frame-ancestors 'none'`、`X-Frame-Options`）と`nosniff`、`Referrer-Policy: same-origin`を付けます（`next.config.ts`）。トークンの照合は比較時間が一定の方法で行います。
- 他の商会の予約や保有は誰にも返しません。会場画面に出すのは、価格、人数の集計、順位（商会名と総資産）だけです。
- DBの接続情報はサーバーの環境変数にだけ置き、ブラウザにSupabaseのキーを渡しません。SupabaseのData APIはpublicスキーマを外部に公開するため、全テーブルでRLSを有効にし、ポリシーは置きません（全拒否）。
- アプリのログにトークンや商会名を出しません。提案会議の試合データは、会議の30日後にスクリプトで削除します。
- 提案会議MVPでは児童のデータを扱いません。イベントで使う前に、データ管理責任と保持期間を決めます（O-008）。

## 11. 監視と障害対応

- 監視はVercelのログと、運営画面の「接続中の端末数・最後に状態を取得した時刻」だけにします。外部の監視サービスは入れません。
- 当日の障害対応は`MEETING_MVP_SPEC.md` §9にあります。

## 12. 銀行イベント（30〜50組）へ広げるとき

- 50組相当の負荷試験を行い、ポーリングだけで足りるかを確かめます。足りなければRealtime Broadcastを起床通知として足します。
- 清算が重くなったら、「締切済み」「清算中」を永続状態に分けます。
- 運営者の認証（O-007）、手動進行、補正の取引、緊急停止を整えます。
- 参加組数に合わせてkを選びます（`MARKET_SPEC.md` §5）。
- 計測イベントは`DATA_AND_EVALUATION.md`に合わせて追加します。

## 13. 未決定の技術事項

- 50組規模でのRealtimeの要否
- 運営者の認証（O-007）
- データの保持期間と削除の責任（O-008）
- イベント版の計測・分析基盤、エラー追跡
- オフラインの一人版を静的ページにするか
- CI/CD
