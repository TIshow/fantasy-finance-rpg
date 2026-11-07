# 公開の手順（owner 向け）

架空の市場の観戦サイトを公開するための手順です。owner が上から順に行います。

- 使うもの：Neon（データベース）、GitHub Actions（毎日の実行）、Vercel（画面の配信）。D-040
- **秘密の値（パスワードや、パスワードの入った接続の文字列）は、チャット・issue・コード・コミット・スクリーンショットに出さないでください。** 置いてよいのは、Neon の画面、GitHub の secrets、Vercel の環境変数、owner の Mac のターミナルの中だけです

## 0. 始める前に

次が main に入っていることを確かめます。
- PR #165（毎日の実行のワークフローと `npm run daily`）
- 大枠3（#166）のまとめの PR（画面用の読むだけの役割 `ffr_reader` を作る SQL）

## 1. Neon：接続の文字列を2種類知る

Neon のプロジェクト（AWS US East）は作成済みです。Neon の画面の「Connect」で、接続の文字列を見られます。

| 種類 | 見分け方 | 使う場所 |
| --- | --- | --- |
| 直接の接続 | ホスト名に `-pooler` が付かない | 表を作るとき（手順3）と、GitHub Actions（手順5） |
| pooler（接続をまとめる仕組み）を通る接続 | ホスト名に `-pooler` が付く | Vercel（手順7） |

- 毎日の実行は、同時に2つ動かないための鍵を、1つの接続の上で持ち続けます。pooler はこの鍵を正しく扱えないおそれがあるので、Actions には**直接の接続**を使います
- 最初に Neon の画面に出る役割（`neondb_owner` など）が、表の持ち主です。この接続は、手順2と3でだけ使います。アプリにも Actions にも渡しません

## 2. Neon：アプリ用の役割を2つ作る

Neon の画面の「SQL Editor」で、表の持ち主として流します。

1. パスワードを2つ作ります（例：Mac のターミナルで `openssl rand -base64 24` を2回）。どこにも保存せず、手順5と7で使うまでパスワード管理アプリなどに置きます
2. `apps/web/db/ops/create_app_role.sql` を開き、`<password>` を1つ目のパスワードに、`<db>` をデータベース名（ふつうは `neondb`）に置き換えて流します。追記だけができる役割 `ffr_app` ができます
3. 大枠3で入る、読むだけの役割を作る SQL を、2つ目のパスワードで同じように流します。読むことだけができる役割 `ffr_reader` ができます
4. SQL Editor に残った文は消しておきます（パスワードが入っているため）

役割は、Neon の画面の「Roles」から作らないでください。画面で作った役割には、書き換えや削除の権限が付くことがあります。

## 3. 手元から表を作る

owner の Mac で、リポジトリの最新の main を使います。

```sh
cd apps/web
npm ci
read -rs DATABASE_ADMIN_URL   # 表の持ち主の「直接の接続」を貼り付けて Enter（画面には出ません）
export DATABASE_ADMIN_URL
npm run daily -- migrate      # {"migrated":true} と出れば成功
unset DATABASE_ADMIN_URL
```

`read -rs` を使うのは、接続の文字列をターミナルの履歴に残さないためです。表は、足すことしかできない形で作られます（更新・削除・全消しは、表の持ち主でも断る）。

## 4. ffr_app の接続の文字列を作る

手順1の直接の接続の文字列の、ユーザー名とパスワードの部分を、`ffr_app` と1つ目のパスワードに置き換えます。

```
postgresql://ffr_app:<1つ目のパスワード>@<ホスト名（-pooler なし）>/neondb?sslmode=require
```

同じように、`ffr_reader` と2つ目のパスワード、**pooler を通る**ホスト名で、読むだけの接続の文字列を作ります。

## 5. GitHub：秘密の値と通知

1. リポジトリの Settings → Secrets and variables → Actions →「Secrets」→ New repository secret
   - 名前：`DATABASE_URL`、値：手順4の `ffr_app` の接続の文字列
2. 同じ画面の「Variables」は、まだ何も足しません（手順8で足します）
3. GitHub の右上のアイコン → Settings → Notifications →「Actions」で、メールを有効にし、「Only notify for failed workflows」（失敗だけ知らせる）を選びます

`DATABASE_ADMIN_URL`（表の持ち主の接続）は、GitHub に登録しません。

## 6. GitHub：手で1回試す

1. リポジトリの Actions → daily → Run workflow を押します。日付は空、照合（verify）はオンのままにします
2. 緑で終わり、実行のページの「Summary」に `exit 0` と照合の件数・最後のハッシュが出ることを確かめます。最初の実行で、参加者の登録と6社の上場が記録されます
3. 同じ時間帯のうちにもう一度動かし、照合の件数が増えないこと（同じ日を回しても二重に書かないこと）を確かめます。8:30 や 9:30 をまたぐと次の段が進むので、件数が増えるのは正常です
4. 日付に `2099-01-01` を入れて動かし、赤（終了コード2）になることと、失敗のメールが届くことを確かめます

赤になったら、Summary とログの全文ではなく、**どの手順で赤になったかと、Summary の1行目**を lead に知らせてください（ログに秘密の値は出ない作りですが、念のため）。

## 7. Vercel：画面を公開する

1. Vercel の「Add New…」→「Project」で、このリポジトリを選びます
2. **Root Directory** を `apps/web` にします。Framework は Next.js のままです
3. Environment Variables に、次を足します
   - 名前：`DATABASE_URL`、値：手順4の `ffr_reader` の接続の文字列（pooler を通るもの）、Environment：**Production** だけ
4. Settings → Environment Variables の「Automatically expose System Environment Variables」がオンのままであることを確かめます（`VERCEL_ENV` を使うため）
5. Deploy を押します。ビルドのときにもデータベースを読むので、手順6の実行が済んでいないとページが空になります
6. 出てきた URL で、トップ・AI のページ・銘柄のページ・上部の帯（架空の市場であることの表示）を確かめます

- Preview（PR ごとの試しの画面）には `DATABASE_URL` を渡しません。Preview では、固定のテスト用データが表示されます
- 画面は1時間ごとに作り直されます。毎日の実行のあと、最大1時間で新しい数字が出ます

## 8. 毎日の自動実行を始める

手順6と7で問題がなければ、GitHub の Settings → Secrets and variables → Actions →「Variables」→ New repository variable で、次を足します。

- 名前：`DAILY_ENABLED`、値：`true`

次の営業日から、日本時間の 06:50・07:20・09:35・16:35 に動きます。最初の営業日は、各回の Summary を見てください。

## 止め方

| 止めたいもの | 方法 |
| --- | --- |
| 毎日の実行 | GitHub の変数 `DAILY_ENABLED` を消すか `false` にする |
| 画面の公開 | Vercel のプロジェクトの Settings で、公開を止める（Pause） |
| データベース | Neon の画面で、プロジェクトを止める。記録は残る |

## 投稿を取り下げるとき

大枠3で入るコマンド（`daily withdraw`）と、本文を消す手順（`apps/web/db/ops/erase_body.sql`）を使います。手順はコマンドが入ったときに、ここに足します。表の持ち主の接続は、取り下げと本文を消すときだけ、手順3と同じやり方で手元から使います。

## 費用

- Neon：無料のプランから始める。足りなくなったら lead と相談する
- GitHub Actions：非公開のリポジトリなので、無料枠（月2,000分）から引かれる。毎日の実行は月170分ほどの見込み。Settings → Billing で確かめる
- Vercel：owner の既存の有料プラン（追加の費用なし。D-040）
