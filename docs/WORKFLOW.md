# 開発体制（エージェントの分担と運用）

更新：2026-11-04（デスクトップアプリ中心の運用に改訂。ownerの決定）
状態：**Accepted**（D-033）

人間のオーナー1名と、Claude Code上の少数のエージェントで開発を進めるための決まり。製品の規則は`AGENTS.md`と`docs/`の各文書が先で、この文書は「誰が・どこまで・どう進めるか」だけを決める。

## 1. 原則

- **少人数。** 同時に動かすのは通常3体まで（lead＋実装1〜2。verifierは必要なときだけ）。増やす前に、増やす理由（独立して進められる仕事がある、など）を示す
- **書く役は分離する。** 役ごとに別のセッションとworktree（issueごとのブランチ）を持ち、担当外のパスは編集しない。担当パスの正本は`.claude/roles/paths.json`
- **セッションは使い捨てる**（leadだけは例外で、mainのフォルダ・Worktreeなしで、区切りごとにSTATUSを更新して閉じる）。 仕事が終わったらセッションを閉じ、次は新しいセッションで始める。残すべきものは、セッションの記憶でなくリポジトリの文書（タスク票・issue・`docs/STATUS.md`）に書く
- **規則は仕組みで守らせる。** 文章の約束はCI・CODEOWNERS・フック・検査に移す（CI・pr-size・CODEOWNERS・純関数の検査・Claude Codeのフック（`.claude/hooks/guard.ts`。§4.7）・完了前の境界検査（`scripts/check-boundaries.sh`。§4.8）は追加済み）。**役別セッションの境界は、役ファイルの約束と完了前の境界検査で守り、フックは役を問わない守り（mainへのpush・マージ・秘密のファイル）を担う**（§4.7の限界）。守れていない約束を見つけたら、文書でなく仕組みを足す
- **作る人と確かめる人を分ける。** 実装した役は自分のPRの最終レビューをしない
- **文書が正本。** 引き継ぎはチャット履歴でなくリポジトリの文書で行う（`CLAUDE.md`）

## 2. 役割

| 役 | 担当パス | 書かないもの |
| --- | --- | --- |
| **owner**（人間） | すべての最終判断 | — |
| **cto**（claude.aiのチャット） | 戦略・仕様・判断材料・タスク票と指示ファイルの案 | 日々の実装 |
| **main（`lead`）** | `docs/STATUS.md`、`docs/HISTORY.md`、`docs/DECISIONS.md`（案のみ。承認はowner）、タスク票、マージの順序 | `apps/`の機能コード |
| **core** | `apps/web/src/{ledger,events,holidays}/`とそのテスト、契約`apps/web/src/contracts/`とそのテスト、固定データ`apps/web/tests/fixtures/` | DB・ネットワーク・UI |
| **platform** | `apps/web/src/{store,ingest,runner,llm}/`、`apps/web/db/`、`apps/web/scripts/` | `ledger/`・`events/`の中身 |
| **web** | `apps/web/src/{app,components,view}/` | 台帳の計算、DBへの書き込み |
| **verifier** | `apps/web/tests/adversarial/`だけ書ける。`src/`は読むだけ | `src/`の変更 |

- 役ごとの指示は`.claude/roles/<役>.md`（担当パスの正本は`.claude/roles/paths.json`、一覧は`CLAUDE.md`）。`.claude/agents/code-reviewer.md`だけが、Claude Codeのサブエージェントとして残り、各役がPRを出す前の差分レビューに呼ぶ。verifierは独立したセッションで、不変条件を壊す入力を探す
- Agent Teams（実験機能）は常用しない。設計の比較、原因が分からない不具合の調査など、書き込みを伴わない場面に限る

## 3. 運用の形

### 3.1 基本：デスクトップアプリで、役別のセッションを並べる

- ownerが、Claude Codeのデスクトップアプリ（Codeタブ）で、leadと役別のセッションを並べて動かす。Codeタブには役を選ぶ項目がない（ownerが画面で確かめた範囲では、選べるのは実行環境・フォルダ・権限モード・モデル）ので、**役はファイルで与える**：新規セッションでWorktreeをオンにしてブランチとフォルダを分け、最初に「`.claude/roles/<役名>.md`と`CLAUDE.md`を読んで、その役で作業して。」と送る
- leadは、mainのフォルダ（Worktreeオフ）で動かし、タスク票の作成、PRの確認、統合順の連絡、STATUSの更新を担う。ownerはleadに基本の指示を出し、必要なら各役にも直接指示してよい。leadが作るタスク票には、各役の最初の指示文を添える
- 役別のセッションは、仕事が終わったら閉じる（§3.3）。leadの文脈が長くなったら、`docs/STATUS.md`を現在地として更新してから閉じ、新しいセッションで続ける
- ターミナルの`claude --agent <役>`は、権限を縛りたい役が出たとき（例：読むだけの監査役）にだけ使う。**そのためには、役の定義`.claude/agents/<役>.md`が要る。いまは`code-reviewer`しか置いていない**（旧lead・core・platform・web・verifierの定義は廃止。復元は`git log --diff-filter=D -- .claude/agents/`で見つけて`git show <コミット>^:.claude/agents/<役>.md`）。フックが`agent_type`で役を判別して書き込みを止められるのは、定義のある役を`--agent`で起動したときと、そのサブエージェントの中だけ（§4.7）

### 3.2 サブエージェント：差分レビューだけ

- 各役は、完了前に`code-reviewer`サブエージェントを呼ぶ。実装役をleadがサブエージェントとして呼ぶ使い方は、基本にしない（途中の様子が見えにくく、leadの文脈を使う。手元でWorktree内の動作は未確認）
- subagentは別のsubagentを起動できない

### 3.3 デスクトップアプリでの手順（セッションごと）

| セッション | モデル | 新規／既存 | 最初に送る文 | 終わったら |
| --- | --- | --- | --- | --- |
| lead | Opus | 既存を続ける。文脈が長くなったらSTATUSを更新して閉じ、新規で続ける。mainのフォルダ、Worktreeオフ | 「`.claude/roles/lead.md`と`CLAUDE.md`を読んで、その役で作業して。」 | 区切りごとにSTATUSが最新であれば閉じてよい。mainのフォルダがmainの先頭にあることを確かめてから、役のセッションを立てる |
| core | Opus | タスクごとに新規、Worktreeオン | 「`.claude/roles/core.md`と`CLAUDE.md`を読んで、その役で作業して。タスク票は <issueのURL>。」 | ブランチをpush済みで、報告をleadに渡したら消してよい。差し戻しは新規セッションで同じブランチを続ける |
| platform | Opus | 同上 | 同上（`platform.md`） | 同上 |
| web | Sonnet | 同上 | 同上（`web.md`） | 同上 |
| verifier | Opus | **実装した役とは別の**新規セッション、Worktreeオン | 「`.claude/roles/verifier.md`と`CLAUDE.md`を読んで、その役で作業して。タスク票は <issueのURL>、対象のブランチは <ブランチ名>。」 | 報告とテストをpush済みで、leadに渡したら消してよい |

- モデルは、セッションを始めるときに選ぶ（途中で替えると、新しいモデルでは会話全体が最初から読み直される（公式の設定ページ）ので、避ける）。台帳・イベントログ・基盤は間違いの費用が高いのでOpus、画面はSonnetを既定にする。画面の仕事に台帳の設計判断が出たら、leadに戻す
- 同時に動かす実装役は3体まで（§1）。ownerが貼る文は、leadが作るタスク票に入っているものをそのまま使う
- セッションを消す前に、未コミット・未pushの変更がないことを確かめる。確かめた結果と報告は、issueのコメントかPRに残す
- **差し戻しの続き：** 新規セッションのWorktreeはアプリが付けた別のブランチで始まる。同じブランチを続けるには、前のセッションを消してそのWorktreeが外れたこと（`git worktree list`）を確かめてから、`git fetch origin && git switch <agent/…のブランチ>`。外れていなければ、`git switch -c <新しい名前> <agent/…のブランチ>`で続け、PRにそう書く。セッションを消すとWorktreeとローカルのブランチも消えるかは未確認（§6）

## 4. 仕事の流れ

1. **issue → タスク票。** leadが、次を書いた票を作る（GitHubのissue本文かコメントに書く）：目的、受け入れ条件、担当パス、触ってはいけないパス、テスト計画、依存するissue、PRの行数の見込み、**ownerに聞かずに決めてよいことの既定値**
2. **実装。** 担当の役が自分のworktreeで`agent/<役>/<issue番号>-<slug>`のブランチ（デスクトップアプリが付けた名前なら`git branch -m`で変える）を切って実装する。テストは機能と一緒に書く。自分のブランチはpushしてよいが、mainブランチへ直接pushしない
3. **自己点検。** 新しいworktreeでは先に`cd apps/web && npm ci`。そのうえで`npm run lint:purity && npm test && npm run typecheck && npm run build`、続けて境界検査`cd "$(git rev-parse --show-toplevel)" && git fetch origin && scripts/check-boundaries.sh <役>`（リポジトリのルートで実行。§4.8）が0であること（verifierは自分のテストの検査と境界検査だけ、leadは境界検査だけでよい）
4. **レビュー。** 実装役（core・platform・web）が完了前にcode-reviewer（差分）を呼ぶ → 台帳・イベントログを変える場合は、別のセッションのverifier。高・中は直すか、残す理由をPRに書く（`AGENTS.md`）
5. **PR。** leadが、pushされた役のブランチから出す。1 PR = 1目的、300行程度（`AGENTS.md`）。大きい仕事は積み重ねたPR（前のPRの上に次のPR）に分ける
6. **マージ。** ownerの承認が必須なのは、台帳・イベントログ・祝日とそのテスト、規則の正本（`docs/DECISIONS.md`・`PAPER_TRADING_RULES.md`・`EVENT_LOG.md`・`WORKFLOW.md`）、ガードレール（`AGENTS.md`・`CLAUDE.md`・`.claude/`・`.github/`・純関数の検査とそのテスト・`package.json`・`next.config.ts`など）。対象の一覧は`.github/CODEOWNERS`。ほかはCIが通り、レビューの高・中が片づいていればleadの判断で進めてよい（ownerが後から確認できるよう、STATUSに書く）

   **承認の扱い（ownerの決定、2026-11-04、D-033の追記）：** 別の認証は使わず、ブランチ保護はCIの成功（`check`・`size`）とPRを必須にするだけにする。承認の必須は設けない（CODEOWNERSは通知とレビューの目印）。**マージはownerが手動で行い、エージェントはマージしない**（上の「leadの判断で進めてよい」は、この方式をやめるまで停止する）。
   **限界：** エージェントはownerのGitHub認証で動くので、技術的にはmainへ直接pushもマージもできてしまう。守るのは、この規律と、Claude Codeの設定・フックでのmainへのpush・force push・マージの禁止（§4.7）。フックは意図した迂回を完全には止められない。改めて固い守りが要るときは、権限を絞った別の認証（fine-grained PATやGitHub App）を使い、ブランチ保護を管理者にも適用する方式へ移る。
7. **記録。** leadが`docs/STATUS.md`を更新する。履歴は`docs/HISTORY.md`（STATUSの分割と一緒に別のPRで作る。それまでは`docs/STATUS.md`の履歴に書く）、レビューで残した指摘は`review-debt`ラベルのissueにする

### 4.7 フック（`.claude/settings.json`・`.claude/hooks/guard.ts`）

どのセッションでも（役の有無を問わず）、ツールを呼ぶ前に`guard.ts`が走り、次を止める（終了コード2。理由はClaudeに返る）。フックが失敗したときも止める（`onFailure: "block"`）。

- mainへのpush、強制push・削除・全ブランチのpush（`--force`・`+`・`--delete`・`--all`・`--mirror`・`--prune`、省略形とワイルドカードを含む）。現在のブランチがmainのときの引数なしpushと`HEAD`のpush
- PRのマージ（`gh pr merge`、`gh api`のmerge）。`gh api`の書き込みは、PR・issueの作成と更新、コメント、レビューだけ許す。`gh repo`の変更、`gh secret`、`gh auth`のトークン表示も止める
- `.env`など秘密のファイル（`.env.example`などは除く）の読み書き（Bash・Read・Grep・Glob・編集ツール）。`.env*`のようなワイルドカードや、`curl -d @.env`の形も止める
- ownerだけが付けるラベル`large-pr-approved`（pr-sizeの失敗を自分で解く道を塞ぐ）
- **役ごとの書き込み先**（**`agent_type`が付くときだけ働く**＝`claude --agent <役>`で起動したセッションと、役のサブエージェントの中。**デスクトップアプリの役別セッション（§3.1）には付かないので、働かない**。担当パス・読み取り専用の役・守りの設定・生成物の正本は`.claude/roles/paths.json`。読めない・形が違うときは止める）。編集ツール（Edit・Write・MultiEdit・NotebookEdit）と、Bashの書き込み（リダイレクト、`tee`・`sed -i`・`cp`・`mv`・`install`・`ln`・`rm`・`unlink`・`rmdir`・`touch`・`mkdir`・`truncate`・`chmod`・`chown`・`dd of=`・`git mv`・`git rm`）に効く。パスは実体（`..`・シンボリックリンクを解いた後）で判定し、書き込み先が属するworktreeのルートからの相対で見る（別のworktreeやgitの外のパスも、そのルートで判定する）。Bashの`cd`は文字どおりの引数だけ追い、行き先が読めない`cd`のあとの相対パスへの書き込みは止める

以下は、`agent_type`が付くときに適用される表（正本は`.claude/roles/paths.json`。デスクトップ運用では、完了前の境界検査§4.8が同じ表で判定する）：

| 役 | 書いてよい |
| --- | --- |
| core | `apps/web/src/{ledger,events,holidays,contracts}/`、`apps/web/tests/{ledger,events,holidays,contracts,fixtures}/` |
| platform | `apps/web/src/{store,ingest,runner,llm}/`、`apps/web/tests/{store,ingest,runner,llm}/`、`apps/web/db/`、`apps/web/scripts/` |
| web | `apps/web/src/{app,components,view}/`、`apps/web/tests/{app,components,view}/` |
| verifier | `apps/web/tests/adversarial/` |
| lead | `docs/`、`README.md`（機能コードと`apps/`は書かない） |
| code-reviewer・Explore・Plan | 書かない（`/tmp`は可） |

どの役も書けない：`.claude/`・`.github/`・`scripts/`・`AGENTS.md`・`CLAUDE.md`・`.tool-versions`・`apps/web/scripts/check-purity.ts`・`apps/web/tests/scripts/`・`apps/web/{package.json,package-lock.json,next.config.ts,tsconfig.json,vitest.config.ts,postcss.config.mjs}`・`apps/web/public/`（`.github/CODEOWNERS`のownerの承認が要るもの）と、リポジトリの外（`/tmp`と`/dev`は可）。依存の追加などは、ownerが役のないセッションで行う。ほかの`agent_type`（`general-purpose`など）は、守りの設定とリポジトリの外だけ制限する。生成物（`node_modules`・`.next`・`coverage`）は書ける。

`settings.json`の`permissions.deny`は補助で、本体はフック。`deny`のBashルールは`git -C . push`や`bash -c`の形を止めないため、フックがコマンド全文を解析する。**限界：** 想定する相手はうっかり。`python -c`の中のgit、別のGitHubクライアント、大文字小文字を区別しないファイルシステム、シンボリックリンク経由の`.env`、`grep -r`のようなディレクトリ全体の検索が`.env`を読むこと、`gh`以外のクライアントでの書き込み、Bashでは`git checkout`/`git apply`・スクリプトの中の書き込み、などは止められない。守りの本体はPRの境界（CODEOWNERS・CI・ownerの手動マージ）。

**実機の確認（2026-11-04、ownerが実施。環境の記録は次のとおり）：** (1) リポジトリ内のClaude Codeのセッション（デスクトップアプリかターミナルかは記録していない）で`git push origin main`を頼み、「ブロック：main…」で止まった（B3aが有効）。(2) ターミナルの`claude --agent web`（廃止した旧定義`web.md`があった時点）で、`apps/web/src/ledger/x.ts`をWriteしようとして「web の担当外のパス」で止まった（B3b。**いまは定義がないので再現しない**）。(3) `--agent`なしのセッションでは、同じファイルが作られた（仕様どおり、役がないと制限しない）。**未確認：** デスクトップアプリのWorktreeセッションでフックが発火するか（`${CLAUDE_PROJECT_DIR}`の解決を含む。確かめ方：Worktreeセッションで`git push origin main`を頼む）、Bashからの書き込みの実機、`isolation: worktree`のサブエージェントの中、サブエージェント`code-reviewer`の読み取り専用の制限。

### 4.8 完了前の境界検査（`scripts/check-boundaries.sh`）

`scripts/check-boundaries.sh <役> [基準]`は、基準ブランチ（既定`origin/main`）との分岐点からの変更（コミット済み・ステージ済み・作業ツリー・未追跡、削除・名前の変更の元と先）が、役の担当パス内かを確かめる。判定は書き込み前のフックと同じ関数と同じ`paths.json`で、**基準ブランチの版**のルール・コードを使う（検査される側が書き換えても変わらない）。終了コード：0=違反なし、1=担当外あり、2=誤り（知らない役・設定が読めない・基準が見つからない・gitの失敗）。積み重ねたPRは基準に前のブランチを、verifierは基準に検証対象のブランチを指定する。leadは、その役のworktreeで実行して確かめる。

**限界：** 実行を忘れる／結果を無視するのは、役が自分で検査する限り防げない。CIで同じ検査を、PRのブランチ名`agent/<役>/…`から役を決めて走らせる案は、別PRで決める（それまでは、leadがPRごとに確認する）。見ないもの：`.gitignore`されたファイル、`assume-unchanged`・`skip-worktree`の変更。

## 5. 役のあいだの連絡と、ownerへの質問

- **役のあいだの連絡はファイルに書く。** 「Cに伝えること」のような引き継ぎは、該当するissueのコメントに「宛先の役・内容・根拠」を書く。ownerが運ばなくても、新しいセッションが読める。セッション間のメッセージ機能が使えるか、手元の環境で確かめる（未確認）
- **ownerに聞かずに進める。** 設計上の小さな選択は、タスク票の既定値で決め、報告に「既定値で決めた点」として書く。タスク票にない選択は、元に戻せるなら推奨案で進めて報告する
- **ownerに聞く：** (1) 取り消せない決定、(2) `decision-needed`ラベルの判断、(3) 人間にしか確かめられない確認（耳・目で見る確認など）、(4) 費用・権利・安全に関わる変更。聞くときは、選択肢・費用・権利・やめ方をまとめる。待つあいだ、止まらない仕事を先に進める

## 6. 並列の作法

- worktreeごとに`npm ci`が要る。npmのキャッシュを共有する。デスクトップアプリのWorktreeの作り方（ブランチ名、土台、フォルダの場所）と、セッションを消したときにWorktreeとローカルのブランチも消えるかは未確認。最初の1回は、ownerが画面で確かめる
- **同じマシンの資源は役ごとに分ける。** devサーバーのポートは役ごとに固定する（web＝3200、platform＝3100）。使えなかったら別のポートを探さず、ほかのセッションのプロセスに触れずに報告する
- DBは、worktreeごとに別のスキーマ（`ffr_<役>_<issue番号>`）を使う
- 同じファイルを2つの役が編集する計画は立てない。やむを得ないときは、先にleadが順番を決める
- 契約（`EventStore`、`MarketDataPort`、`LlmPort`、`Clock`と、固定シードで作る架空のゴールデンログ）を先に別PRで固め、各役はその型だけに依存して並列に進める
- 実装役には、タスク票・`AGENTS.md`・関係する`docs/`だけを渡す。チャットの経緯は渡さない。担当外への依頼と判断待ちは、issueのコメントに書く（§5）

## 7. 効果の測り方（2週間ごとに見直す）

- PRあたりのレビュー指摘数（高・中）と、手戻りの回数
- マージ済みPRあたりのトークン費用
- マージの衝突の回数
- ownerが判断待ちで止まった日数、ownerへの質問の数

数字が悪ければ、役を減らす、タスクを大きくする、並列をやめる、のどれかを選ぶ。
