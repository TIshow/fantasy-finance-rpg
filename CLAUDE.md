@AGENTS.md

# Claude Code notes

- `AGENTS.md` is the canonical shared instruction file for Codex, Claude Code, and human contributors.
- Read `docs/STATUS.md` before planning or changing files.
- Do not rely on Claude auto-memory as project truth; commit durable facts to the appropriate document.
- Keep this file small. Put shared rules in `AGENTS.md` and detailed context in `docs/`.
- At the end of substantive work, make `docs/STATUS.md` accurate enough for a fresh session to continue without chat history.

## 進め方（オーケストレーター。D-044）

- **owner と lead：** 大枠（いくつかの issue をまとめた、ひと区切りの目標）を決めて、大枠の issue に書く。大枠が終わったら、報告・コード・仕様を確かめ、owner が main にマージして次の大枠を指示する。**lead はブラウザのチャット**（CTO。Claude Code ではない）
- **オーケストレーター：** owner がデスクトップアプリで新しいセッションを立て（Worktree オン）、「`.claude/roles/orchestrator.md` と `CLAUDE.md` を読んで、オーケストレーターとして、issue #<大枠の番号> を進めて。」と送る。大枠の中で、各役をサブエージェントとして呼び、code-reviewer のレビュー、verifier の検証、大枠のブランチ（`milestone/...`）へのマージ、次の割り振りまでを行う。進み具合は大枠の issue に書くので、日をまたいでも新しいセッションで続けられる
- **役（サブエージェント）：** `.claude/agents/<役>.md` の定義で、オーケストレーターが呼ぶ。役の指示は `.claude/roles/<役>.md`、担当パスの正本は `.claude/roles/paths.json`。サブエージェントには役が付くので、書き込み前のフックが担当外への書き込みを止める

| 役 | 書いてよいパス | モデル |
| --- | --- | --- |
| lead（CTO・ブラウザチャット） | `docs/`、`README.md` | ブラウザのチャットで選ぶ |
| orchestrator | ファイルは書かない（issue のコメントと、大枠のブランチへのマージだけ） | Opus |
| core | `apps/web/src/{ledger,events,holidays}/`とそのテスト、契約`apps/web/src/contracts/`とそのテスト、固定データ`apps/web/tests/fixtures/` | Opus |
| platform | `apps/web/src/{store,ingest,runner,llm}/`とそのテスト、`apps/web/db/`、`apps/web/scripts/` | Opus |
| web | `apps/web/src/{app,components,view}/`とそのテスト | Sonnet |
| verifier | `apps/web/tests/adversarial/` | Opus |

- 担当外のパスは読むだけ。直したい点と判断待ちは、直さずにissueのコメントに書く（宛先の役・内容・根拠）。取り消せないもの・費用・権利・安全に関わる判断は止まってownerに聞く（`docs/WORKFLOW.md` §5）。`docs/STATUS.md`はleadだけが更新する（leadが自分のブランチからPRで出し、ownerがマージする）
- どの役も、`.claude/`・`.github/`・`scripts/`・`AGENTS.md`・`CLAUDE.md`・`.tool-versions`・`apps/web/{package.json,package-lock.json,next.config.ts,tsconfig.json,vitest.config.ts,postcss.config.mjs}`・`apps/web/public/`・`apps/web/scripts/check-purity.ts`・`apps/web/tests/scripts/`を変えない（ownerだけ）
- 役は、新しいWorktreeでは先に`cd apps/web && npm ci`。完了前に、リポジトリのルートで`git fetch origin && scripts/check-boundaries.sh <役名> <宛先のブランチ>`を実行し、0で終わらせる
- どのセッションもmainへ直接pushしない。**mainへのマージはownerが手動で行う。** 大枠のブランチへのマージはオーケストレーターが行う
- 報告はissueのコメント（先頭に`core:`・`orchestrator:`など役名）に書く。leadの判断は`lead:`コメント

- **限界：** オーケストレーター自身には役が付かないので、フックの役ごとの制限は働かない（自分ではファイルを編集しない約束で守る）。mainへのpush・`.env`・`gh pr merge`などの役を問わない禁止は、フックが働く（`docs/WORKFLOW.md` §4.7）
- 役を、デスクトップアプリの別のセッションとして直接動かすこともできる（以前の運用）。そのときは「`.claude/roles/<役名>.md` と `CLAUDE.md` を読んで、その役で作業して。」と送り、完了前に`code-reviewer`を呼ぶ。この場合はフックの役の制限が働かない
