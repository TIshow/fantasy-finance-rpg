# 開発体制（エージェントの分担と運用）

更新：2026-11-04
状態：**Accepted**（D-033）

人間のオーナー1名と、Claude Code上の少数のエージェントで開発を進めるための決まり。製品の規則は`AGENTS.md`と`docs/`の各文書が先で、この文書は「誰が・どこまで・どう進めるか」だけを決める。

## 1. 原則

- **少人数。** 同時に動かすのは通常3体まで（main＋実装1〜2。verifierは必要なときだけ）。増やす前に、増やす理由（独立して進められる仕事がある、など）を示す
- **書く役は分離する。** 役ごとに別のセッションとworktree（issueごとのブランチ）を持ち、担当外のパスは編集しない
- **セッションは使い捨てる。** 仕事が終わったらセッションを閉じ、次は新しいセッションで始める。残すべきものは、セッションの記憶でなくリポジトリの文書（タスク票・issue・`docs/STATUS.md`）に書く
- **規則は仕組みで守らせる。** 文章の約束はCI・CODEOWNERS・フックに移す（CI・pr-size・CODEOWNERS・純関数の検査・Claude Codeのフック（`.claude/hooks/guard.ts`。§4.7）は追加済み。残りは文書の約束とレビューで守る）。守れていない約束を見つけたら、文書でなく仕組みを足す
- **作る人と確かめる人を分ける。** 実装した役は自分のPRの最終レビューをしない
- **文書が正本。** 引き継ぎはチャット履歴でなくリポジトリの文書で行う（`CLAUDE.md`）

## 2. 役割

| 役 | 担当パス | 書かないもの |
| --- | --- | --- |
| **owner**（人間） | すべての最終判断 | — |
| **cto**（claude.aiのチャット） | 戦略・仕様・判断材料・タスク票と指示ファイルの案 | 日々の実装 |
| **main（`lead`）** | `docs/STATUS.md`、`docs/HISTORY.md`、`docs/DECISIONS.md`（案のみ。承認はowner）、タスク票、マージの順序 | `apps/`の機能コード |
| **core** | `apps/web/src/{ledger,events,holidays}/`とそのテスト | DB・ネットワーク・UI |
| **platform** | `apps/web/src/{store,ingest,runner,llm}/`、`apps/web/db/`、`apps/web/scripts/` | `ledger/`・`events/`の中身 |
| **web** | `apps/web/src/{app,components,view}/` | 台帳の計算、DBへの書き込み |
| **verifier** | `apps/web/tests/adversarial/`だけ書ける。`src/`は読むだけ | `src/`の変更 |

- 役ごとの指示は`.claude/agents/<役>.md`。`.claude/agents/code-reviewer.md`は、PRを出す前の差分レビュー用。verifierは、その上で不変条件を壊す入力を探す
- Agent Teams（実験機能）は常用しない。設計の比較、原因が分からない不具合の調査など、書き込みを伴わない場面に限る

## 3. 運用の形

### 3.1 基本：役別のセッションを並べる（手動の並列）

- ownerが、mainと役別のセッションを並べて動かす。各セッションは自分のworktreeで`claude --agent <役>`（lead・core・platform・web・verifier）として起動し、`.claude/agents/<役>.md`を指示として読み、担当パスの中だけで作業する。役はフックが`agent_type`で判別して書き込み先を制限するので、`--agent`なしの素のセッションは制限されない（ownerが直接動かす場合だけ使う）
- mainにはownerが基本の指示を出し、必要なら各役にも直接指示してよい。mainが作るタスク票（§4）は、役別のセッションにそのまま渡せる形にする
- 役別のセッションは、仕事が終わったら閉じる。mainの文脈が長くなったら、`docs/STATUS.md`を現在地として更新してから閉じ、新しいmainで続ける

### 3.2 任意：mainが委任する

- mainが、役を`isolation: worktree`のsubagentとして呼ぶこともできる。人間が中継しなくてよいが、途中の様子が見えにくく、mainの文脈を使う。小さく独立した仕事に向く
- subagentは別のsubagentを起動できないので、委任はmainのセッションだけが行う
- 手元の環境で動くか、最初の委任のときに確かめる（未確認）

## 4. 仕事の流れ

1. **issue → タスク票。** mainが、次を書いた票を作る（GitHubのissue本文かコメントに書く）：目的、受け入れ条件、担当パス、触ってはいけないパス、テスト計画、依存するissue、PRの行数の見込み、**ownerに聞かずに決めてよいことの既定値**
2. **実装。** 担当の役が自分のworktreeで`agent/<役>/<issue番号>-<slug>`のブランチを切って実装する。テストは機能と一緒に書く。mainブランチへ直接pushしない
3. **自己点検。** `cd apps/web && npm run lint:purity && npm test && npm run typecheck && npm run build`
4. **レビュー。** code-reviewer（差分）→ 台帳・イベントログを変える場合はverifier。高・中は直すか、残す理由をPRに書く（`AGENTS.md`）
5. **PR。** mainが出す。1 PR = 1目的、300行程度（`AGENTS.md`）。大きい仕事は積み重ねたPR（前のPRの上に次のPR）に分ける
6. **マージ。** ownerの承認が必須なのは、台帳・イベントログ・祝日とそのテスト、規則の正本（`docs/DECISIONS.md`・`PAPER_TRADING_RULES.md`・`EVENT_LOG.md`・`WORKFLOW.md`）、ガードレール（`AGENTS.md`・`CLAUDE.md`・`.claude/`・`.github/`・純関数の検査とそのテスト・`package.json`・`next.config.ts`など）。対象の一覧は`.github/CODEOWNERS`。ほかはCIが通り、レビューの高・中が片づいていればmainの判断で進めてよい（ownerが後から確認できるよう、STATUSに書く）

   **承認の扱い（ownerの決定、2026-11-04、D-033の追記）：** 別の認証は使わず、ブランチ保護はCIの成功（`check`・`size`）とPRを必須にするだけにする。承認の必須は設けない（CODEOWNERSは通知とレビューの目印）。**マージはownerが手動で行い、エージェントはマージしない**（上の「mainの判断で進めてよい」は、この方式をやめるまで停止する）。
   **限界：** エージェントはownerのGitHub認証で動くので、技術的にはmainへ直接pushもマージもできてしまう。守るのは、この規律と、Claude Codeの設定・フックでのmainへのpush・force push・マージの禁止（§4.7）。フックは意図した迂回を完全には止められない。改めて固い守りが要るときは、権限を絞った別の認証（fine-grained PATやGitHub App）を使い、ブランチ保護を管理者にも適用する方式へ移る。
7. **記録。** mainが`docs/STATUS.md`を更新する。履歴は`docs/HISTORY.md`（STATUSの分割と一緒に別のPRで作る。それまでは`docs/STATUS.md`の履歴に書く）、レビューで残した指摘は`review-debt`ラベルのissueにする

### 4.7 フック（`.claude/settings.json`・`.claude/hooks/guard.ts`）

どの役のセッションでも、ツールを呼ぶ前に`guard.ts`が走り、次を止める（終了コード2。理由はClaudeに返る）。フックが失敗したときも止める（`onFailure: "block"`）。

- mainへのpush、強制push・削除・全ブランチのpush（`--force`・`+`・`--delete`・`--all`・`--mirror`・`--prune`、省略形とワイルドカードを含む）。現在のブランチがmainのときの引数なしpushと`HEAD`のpush
- PRのマージ（`gh pr merge`、`gh api`のmerge）。`gh api`の書き込みは、PR・issueの作成と更新、コメント、レビューだけ許す。`gh repo`の変更、`gh secret`、`gh auth`のトークン表示も止める
- `.env`など秘密のファイル（`.env.example`などは除く）の読み書き（Bash・Read・Grep・Glob・編集ツール）。`.env*`のようなワイルドカードや、`curl -d @.env`の形も止める
- ownerだけが付けるラベル`large-pr-approved`（pr-sizeの失敗を自分で解く道を塞ぐ）
- **役ごとの書き込み先**（`agent_type`で役を判別。担当パス・読み取り専用の役・守りの設定・生成物の正本は`.claude/roles/paths.json`。読めない・形が違うときは止める）。編集ツール（Edit・Write・MultiEdit・NotebookEdit）と、Bashの書き込み（リダイレクト、`tee`・`sed -i`・`cp`・`mv`・`install`・`ln`・`rm`・`unlink`・`rmdir`・`touch`・`mkdir`・`truncate`・`chmod`・`chown`・`dd of=`・`git mv`・`git rm`）に効く。パスは実体（`..`・シンボリックリンクを解いた後）で判定し、書き込み先が属するworktreeのルートからの相対で見る（別のworktreeやgitの外のパスも、そのルートで判定する）。Bashの`cd`は文字どおりの引数だけ追い、行き先が読めない`cd`のあとの相対パスへの書き込みは止める

| 役 | 書いてよい |
| --- | --- |
| core | `apps/web/src/{ledger,events,holidays}/`、`apps/web/tests/{ledger,events,holidays}/` |
| platform | `apps/web/src/{store,ingest,runner,llm}/`、`apps/web/tests/{store,ingest,runner,llm}/`、`apps/web/db/`、`apps/web/scripts/` |
| web | `apps/web/src/{app,components,view}/`、`apps/web/tests/{app,components,view}/` |
| verifier | `apps/web/tests/adversarial/` |
| lead | `docs/`、`README.md`（機能コードと`apps/`は書かない） |
| code-reviewer・Explore・Plan | 書かない（`/tmp`は可） |

どの役も書けない：`.claude/`・`.github/`・`AGENTS.md`・`CLAUDE.md`・`.tool-versions`・`apps/web/scripts/check-purity.ts`・`apps/web/tests/scripts/`・`apps/web/{package.json,package-lock.json,next.config.ts,tsconfig.json}`（`.github/CODEOWNERS`のownerの承認が要るもの）と、リポジトリの外（`/tmp`と`/dev`は可）。依存の追加などは、ownerが素のセッションで行う。ほかの`agent_type`（`general-purpose`など）は、守りの設定とリポジトリの外だけ制限する。生成物（`node_modules`・`.next`・`coverage`）は書ける。

`settings.json`の`permissions.deny`は補助で、本体はフック。`deny`のBashルールは`git -C . push`や`bash -c`の形を止めないため、フックがコマンド全文を解析する。**限界：** 想定する相手はうっかり。`python -c`の中のgit、別のGitHubクライアント、大文字小文字を区別しないファイルシステム、シンボリックリンク経由の`.env`、`grep -r`のようなディレクトリ全体の検索が`.env`を読むこと、`gh`以外のクライアントでの書き込み、Bashでは`git checkout`/`git apply`・スクリプトの中の書き込み、などは止められない。守りの本体はPRの境界（CODEOWNERS・CI・ownerの手動マージ）。

**実機の確認（ownerが一度行う）：** リポジトリの中で`claude`を起動し、「`git push origin main`を実行して」と頼む。フックが「ブロック：main…」と返せば有効。効かないときは`/status`の`Setting sources`に`Project settings`があるか、フォルダの信頼の確認が出ていれば承認したかを確かめる。

## 5. 役のあいだの連絡と、ownerへの質問

- **役のあいだの連絡はファイルに書く。** 「Cに伝えること」のような引き継ぎは、該当するissueのコメントに「宛先の役・内容・根拠」を書く。ownerが運ばなくても、新しいセッションが読める。セッション間のメッセージ機能が使えるか、手元の環境で確かめる（未確認）
- **ownerに聞かずに進める。** 設計上の小さな選択は、タスク票の既定値で決め、報告に「既定値で決めた点」として書く。タスク票にない選択は、元に戻せるなら推奨案で進めて報告する
- **ownerに聞く：** (1) 取り消せない決定、(2) `decision-needed`ラベルの判断、(3) 人間にしか確かめられない確認（耳・目で見る確認など）、(4) 費用・権利・安全に関わる変更。聞くときは、選択肢・費用・権利・やめ方をまとめる。待つあいだ、止まらない仕事を先に進める

## 6. 並列の作法

- worktreeごとに`npm ci`が要る。npmのキャッシュを共有する
- **同じマシンの資源は役ごとに分ける。** devサーバーのポートは役ごとに固定する（web＝3200、platform＝3100）。使えなかったら別のポートを探さず、ほかのセッションのプロセスに触れずに報告する
- DBは、worktreeごとに別のスキーマ（`ffr_<役>_<issue番号>`）を使う
- 同じファイルを2つの役が編集する計画は立てない。やむを得ないときは、先にmainが順番を決める
- 契約（`EventStore`、`MarketDataPort`、`LlmPort`、`Clock`と、固定シードで作る架空のゴールデンログ）を先に別PRで固め、各役はその型だけに依存して並列に進める
- 実装役には、タスク票・`AGENTS.md`・関係する`docs/`だけを渡す。チャットの経緯は渡さない

## 7. 効果の測り方（2週間ごとに見直す）

- PRあたりのレビュー指摘数（高・中）と、手戻りの回数
- マージ済みPRあたりのトークン費用
- マージの衝突の回数
- ownerが判断待ちで止まった日数、ownerへの質問の数

数字が悪ければ、役を減らす、タスクを大きくする、並列をやめる、のどれかを選ぶ。
