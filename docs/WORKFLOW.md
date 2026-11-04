# 開発体制（エージェントの分担と運用）

更新：2026-11-04
状態：**Accepted**（D-033）

人間のオーナー1名と、Claude Code上の少数のエージェントで開発を進めるための決まり。製品の規則は`AGENTS.md`と`docs/`の各文書が先で、この文書は「誰が・どこまで・どう進めるか」だけを決める。

## 1. 原則

- **少人数。** 同時に動かすのは通常3体まで（lead＋実装1〜2＋必要なときにverifier）。増やす前に、増やす理由（独立して進められる仕事がある、など）を示す
- **書く役は分離する。** ファイルを書く役は、issueごとにworktreeとブランチを分ける。担当外のパスは編集しない
- **規則は仕組みで守らせる。** 文章の約束はCI・CODEOWNERS・フックに移す（別のPRで追加する。それまでは文書の約束とレビューで守る）。守れていない約束を見つけたら、文書でなく仕組みを足す
- **作る人と確かめる人を分ける。** 実装した役は自分のPRの最終レビューをしない
- **文書が正本。** 引き継ぎはチャット履歴でなくリポジトリの文書で行う（`CLAUDE.md`）

## 2. 役割

| 役 | 起動 | 担当パス | 書かないもの |
| --- | --- | --- | --- |
| **owner**（人間） | — | すべての最終判断 | — |
| **cto**（claude.aiのチャット） | 人間が対話 | 戦略・仕様・判断材料・指示ファイルの案 | 日々の実装 |
| **lead** | `claude --agent lead`（メインセッション） | `docs/STATUS.md`、`docs/HISTORY.md`、`docs/DECISIONS.md`（案のみ。承認はowner）、タスク票 | `apps/`の機能コード |
| **core** | leadが委任（`isolation: worktree`） | `apps/web/src/{ledger,events,holidays}/`とそのテスト | DB・ネットワーク・UI |
| **platform** | leadが委任（`isolation: worktree`） | `apps/web/src/{store,ingest,runner,llm}/`、`apps/web/db/`、`apps/web/scripts/` | `ledger/`・`events/`の中身 |
| **web** | leadが委任（`isolation: worktree`） | `apps/web/src/{app,components,view}/` | 台帳の計算、DBへの書き込み |
| **verifier** | leadが委任 | `apps/web/tests/adversarial/`だけ書ける。`src/`は読むだけ | `src/`の変更 |

- `.claude/agents/code-reviewer.md`は、PRを出す前の差分レビュー用に残す。verifierは、その上で不変条件を壊す入力を探す
- subagentは別のsubagentを起動できないので、委任はleadのメインセッションだけが行う
- Agent Teams（実験機能）は常用しない。設計の比較、原因が分からない不具合の調査（仮説を分けて調べる）など、書き込みを伴わない場面に限る

## 3. 仕事の流れ

1. **issue → タスク票。** leadが、次を書いた票を作る：目的、受け入れ条件、担当パス、触ってはいけないパス、テスト計画、依存するissue、PRの行数の見込み
2. **実装。** 担当の役が自分のworktreeで`agent/<役>/<issue番号>-<slug>`のブランチを切って実装する。テストは機能と一緒に書く。mainへ直接pushしない
3. **自己点検。** `cd apps/web && npm test && npm run typecheck && npm run build`
4. **レビュー。** code-reviewer（差分）→ 台帳・イベントログを変える場合はverifier。高・中は直すか、残す理由をPRに書く（`AGENTS.md`）
5. **PR。** leadが出す。1 PR = 1目的、300行程度（`AGENTS.md`）。大きい仕事は積み重ねたPR（前のPRの上に次のPR）に分ける
6. **マージ。** `ledger/`・`events/`・`docs/DECISIONS.md`はownerの承認が必須。ほかはCIが通り、レビューの高・中が片づいていればleadの判断で進めてよい（ownerが後から確認できるよう、STATUSに書く）
7. **記録。** leadが`docs/STATUS.md`を更新する。履歴は`docs/HISTORY.md`（STATUSの分割と一緒に別のPRで作る。それまでは`docs/STATUS.md`の履歴に書く）、レビューで残した指摘は`review-debt`ラベルのissueにする

## 4. 並列の作法

- worktreeごとに`npm ci`が要る。npmのキャッシュを共有する
- DBは、worktreeごとに別のスキーマ（`ffr_<役>_<issue番号>`）を使う。devサーバーのポートも分ける
- 同じファイルを2つの役が編集する計画は立てない。やむを得ないときは、先にleadが順番を決める
- 契約（`EventStore`、`MarketDataPort`、`LlmPort`、`Clock`と、固定シードで作る架空のゴールデンログ）を先に別PRで固め、各役はその型だけに依存して並列に進める
- 実装役のコンテキストには、タスク票・`AGENTS.md`・関係する`docs/`だけを渡す。チャットの経緯は渡さない

## 5. オーナーを待たせないために

- leadは、ownerの判断が要る事項（`decision-needed`ラベル）を、選択肢・費用・権利・やめ方の形でまとめてから依頼する。口頭の相談だけで止めない
- 判断待ちで止まっている仕事と、止まらずに進められる仕事を分け、後者を先に進める

## 6. 効果の測り方（2週間ごとに見直す）

- PRあたりのレビュー指摘数（高・中）と、手戻りの回数
- マージ済みPRあたりのトークン費用
- マージの衝突の回数
- ownerが判断待ちで止まった日数

数字が悪ければ、役を減らす、タスクを大きくする、並列をやめる、のどれかを選ぶ。
