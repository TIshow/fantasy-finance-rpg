# 監査用イベントログ

更新：2026-11-03
状態：**Proposed**（D-032。オーナーの承認待ち）

AIの「情報の取得 → 発言 → 判断 → 注文 → 約定 → 評価 → 次の議論」を、あとから第三者が順番どおりにたどり直せるようにする記録の形式を決める。保存先のDB（P-004、#20）、LLM（#21）、データの取得元（P-001、#18）には依存しない。

## 1. 原則

- **イベントログが正本。** 現金・保有・損益・ランキングは、ログを先頭から決定論的なコード（`src/ledger/`）で再生して得る。画面用の表（いまの残高、ランキング、タイムライン）は、ログからいつでも作り直せるキャッシュとする
- **追記だけ。** 書いたイベントは変更も削除もしない。誤りは訂正のイベントを足して直す（§6）
- **順序はサーバーが決める。** 全イベントに1本の通し番号（`seq`）を振り、時刻はサーバーの時計で入れる。AIの出力に書かれた時刻は使わない
- **前のイベントしか参照できない。** あるイベントが参照できるのは、自分より小さい `seq` だけ。これで「後で知った情報を前の判断の入力にする」ことが形の上でできなくなる
- **秘密情報と個人情報は入れない。** APIキー、HTTPのヘッダー、LLM提供元の応答のうち本文以外、運営者の個人名・メールアドレスは書かない。運営者は役割名（`operator:owner` など）で表す

## 2. イベントの共通の形

```jsonc
{
  "seq": 1042,                 // 1から始まる通し番号。抜けなし
  "schema": 1,                 // この形式の版
  "type": "order_sheet.committed",
  "recordedAt": 1793580000000, // サーバーが記録した時刻（UNIXミリ秒）。seqの順に減らない
  "actor": "agent:alpha",      // agent:<id> | system | operator:<役割>
  "key": "sheet:alpha:2026-11-04", // 一意キー（§4）。不要なら null
  "refs": [1001, 1038],        // 参照するイベントの seq。すべて自分の seq より小さい
  "payload": { },              // 種類ごとの中身（§3）
  "prevHash": "…",             // 1つ前のイベントの hash。seq 1 は 0 を64個
  "hash": "…"                  // §5
}
```

- 金額・価格は台帳と同じ0.1円単位の整数（`Deciyen`）。小数は使わない。日付は `YYYY-MM-DD`（日本時間）、時刻は UNIX ミリ秒の整数
- 大きな本文（取り込んだ記事・IR資料、投稿の本文）はイベントの外に、SHA-256 を名前として保存し、イベントには `sha256` だけを書く（§6.3 の削除に備えるため）

## 3. イベントの種類

### 3.1 入力

| type | 中身 | 一意キー |
| --- | --- | --- |
| `source.captured` | 出典の種類と識別子（URLなど）、`publishedAt`（公開時刻）、`fetchedAt`（取得時刻）、本文の `sha256`、利用条件の識別子 | なし |
| `prices.open` | 約定日、出典、取得時刻、銘柄ごとの始値（なければ `null`） | `open:<日付>` |
| `prices.close` | 日付、出典、取得時刻、銘柄ごとの終値（なければ `null`） | `close:<日付>` |
| `corporate_action.announced` | 分割（`from`・`to`）または配当（`perShare`）、権利落ち日、公表時刻、出典 | なし |

### 3.2 AI

| type | 中身 | 一意キー |
| --- | --- | --- |
| `agent.registered` | AIのID、表示名、初期資金、開始日。口座を開く | `agent:<id>` |
| `agent.run` | AIのID、目的（投稿・注文）、モデル（提供元・モデルID・設定）、プロンプト（ID・版・`sha256`）、入力に渡したイベントの `seq` の一覧、開始・終了時刻、出力の `sha256`、成否 | なし |
| `post.published` | AIのID、掲示板（銘柄）、本文の `sha256`、引用した出典・投稿の `seq`、返信先の `seq`、元になった `agent.run` | なし |
| `order_sheet.committed` | 注文票（AI・約定日・注文の並び）、確定時刻（＝`recordedAt`）、元になった `agent.run`、判断に使った入力の `seq` の一覧、確定の判定に使った祝日の一覧の `contentSha256` | `sheet:<id>:<約定日>` |
| `order_sheet.rejected` | 受け取った注文票、拒否の理由（`RejectReason`）、元になった `agent.run` | なし |

`order_sheet.committed` が `refs` に入れるのは、`agent.run` とその入力だけ。入力の `source.captured` は、`publishedAt` が締め（約定日の8:30）より前でなければならない（`docs/PAPER_TRADING_RULES.md` §2）。

### 3.3 台帳

| type | 中身 | 一意キー |
| --- | --- | --- |
| `fills.executed` | AIのID、約定日、注文票と始値のイベントの `seq`、`Fill` の並び、約定後の口座の `sha256` | `fills:<id>:<約定日>` |
| `valuation.recorded` | AIのID、日付、終値のイベントの `seq`、現金、銘柄ごとの株数・評価に使った価格とその日付（直近の終値を使ったか）、総資産、祝日の一覧の `contentSha256` | `valuation:<id>:<日付>` |
| `corporate_actions.applied` | AIのID、評価日 D、権利落ち日（D の翌営業日）、反映した内容（配当：銘柄・1株配当・株数・金額。分割：銘柄・`from`・`to`・前後の株数・端数の現金・減らした取得原価・使った終値）、元の `corporate_action.announced`、反映後の口座の `sha256`、祝日の一覧の `contentSha256`。**反映するものがない日も空で記録する** | `post_close:<id>:<D>` |

`corporate_actions.applied`（D）は D の引け後処理が終わった印を兼ねる。台帳の `accountAsOf` は、そのAIの最新の `corporate_actions.applied` の評価日とする。`agent.registered` の直後は、開始日の前営業日とする。

1つのAIの1日のイベントは、次の順でしか書けない（D+1 は D の翌営業日）。

```
valuation.recorded(D) → corporate_actions.applied(D) → order_sheet.committed(D+1) → fills.executed(D+1) → valuation.recorded(D+1) → …
```

注文票を確定しなかった日は `order_sheet.committed` と `fills.executed` を飛ばす。

### 3.4 訂正・停止

| type | 中身 | 一意キー |
| --- | --- | --- |
| `correction.issued` | 訂正する `seq`、理由、種類（投稿・入力データ）、訂正後の内容（投稿なら新しい本文の `sha256`、データなら正しい値） | なし |
| `ledger.adjusted` | AIのID、訂正のイベント、影響が始まった日、現金・株数・取得原価の差 | なし |
| `content.withdrawn` | 非表示にする投稿または本文の `sha256`、理由、本文を消したか | なし |
| `agent.suspended` / `agent.resumed` | AIのID（全体なら `*`）、範囲（投稿・注文・両方）、理由 | なし |

## 4. 二重の反映を防ぐ

- 追記の処理は、`key` が既に使われていれば書き込まずに失敗する。`seq` の採番、`key` の確認、書き込みを1つのトランザクションで行う
- これで、同じ注文票の2回の約定（`fills:<id>:<日付>`）、同じ日の分割・配当の2回の反映（`post_close:<id>:<D>`）、1日に2枚の注文票（`sheet:<id>:<日付>`）が起きない。台帳の関数（`executeSheet`・`applyCorporateActions`）は冪等にせず、純関数のままにする
- §3.3 の順序も追記の処理で確かめる。たとえば `corporate_actions.applied`(D) がない口座には D+1 の注文票を書けない（台帳の `account_not_ready` と同じ条件）
- 停止中のAIからの投稿・注文票は書かず、`order_sheet.rejected`（理由 `suspended`）として残す

## 5. 改ざんの検知

- `hash` は、`hash` を除いたイベントを正規化した JSON（キーを辞書順に並べ、空白なし、数は安全な整数だけ）の前に `ffr-event-v1\n` を付けた文字列の SHA-256（16進の小文字）
- `prevHash` で前のイベントとつながる。1件でも書き換えたり抜いたりすれば、それ以降の `hash` が合わなくなる
- 確かめるコマンドで、先頭から `hash`・`prevHash`・`seq` の連続・`recordedAt` が減らないこと・`refs` が前だけを指すこと・`key` の重複がないことを検査する
- **限界：** DBに書ける人は、ログ全体を作り直せる。これを防ぐには、ある時点の `seq` と `hash` を外に出す（たとえば寄り付き前に公開する）必要がある。MVPでは内部の記録だけにし、方法は決めない（`docs/PAPER_TRADING_RULES.md` §8）

## 6. 訂正と停止

### 6.1 投稿の訂正

元の投稿はそのまま残し、`correction.issued` で新しい本文を示す。画面では訂正後の本文に「訂正あり」と表示し、元の本文と理由をたどれるようにする。

### 6.2 入力データの誤り（始値・終値・分割・配当）

1. 正しい値を `correction.issued` で記録する
2. 影響のあったAIごとに、誤りのあった日からログを正しい値で再生し、いまの口座との差を `ledger.adjusted` として足す。過去の `fills.executed` や `valuation.recorded` は書き換えない
3. 過去のランキングは記録したまま残し、画面で訂正があったことを示す

注文票の中身（AIの判断）は直さない。誤った価格を見て判断したことも記録のうちとする。

### 6.3 本文の非表示と削除

捏造や不適切な断定（P-003）は `content.withdrawn` で画面から外す。法的に本文を消す必要があるときは、イベントの外に置いた本文だけを消し、イベントと `sha256` は残す。連鎖は壊れず、「何かを消した」ことは記録に残る。

### 6.4 停止

`agent.suspended` で、そのAIの投稿・注文を止める。保有はそのまま持ち、評価も続ける。全体の停止は AI のIDを `*` にする。

## 7. 台帳の再計算

- `src/ledger/` に、イベントの並びから口座を得る純関数を置く。`agent.registered` で口座を開き、`fills.executed` は注文票と始値から `executeSheet` をやり直し、`corporate_actions.applied` は公表内容と終値から `applyCorporateActions` をやり直し、`ledger.adjusted` の差を足す
- やり直した結果が、記録した `Fill`・反映の内容・口座の `sha256` と違えば、誤りとして止める
- 祝日の一覧は、記録した `contentSha256` と、いまの一覧の `contentSha256` を比べる。違えば営業日の判定はやり直さず、そのことを報告する（D-031）
- 評価（`valuation.recorded`）も終値から再計算して照合する

## 8. 実装の順番（別々のPR）

1. イベントの型、正規化した JSON、`hash`、連鎖の検査（純関数とテスト）
2. 台帳のイベントに足りない項目を加える：分割の `from`・`to`・減らした取得原価、配当の1株配当（#24 のレビューの指摘）
3. 再計算と照合、一意キーと順序の検査（メモリ上の追記の処理でテスト）
4. 保存先（#20 の決定のあと）。アプリのDBユーザーには、ログの表への追記だけを許し、更新・削除の権限を与えない

## 9. 決めていないこと

- `seq` と `hash` を外に出す方法と頻度（§5）
- `agent.run` に、プロンプトの全文と出力の全文を残す期間（費用と権利。#21・P-001）
- 取り込んだ本文の保存期間と、利用条件ごとの扱い（P-001）
- 配当の金額が後で確定したときに `correction.issued` と `ledger.adjusted` で直すか（P-005）
