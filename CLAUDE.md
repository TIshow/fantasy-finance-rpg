@AGENTS.md

# Claude Code notes

- `AGENTS.md` is the canonical shared instruction file for Codex, Claude Code, and human contributors.
- Read `docs/STATUS.md` before planning or changing files.
- Do not rely on Claude auto-memory as project truth; commit durable facts to the appropriate document.
- Keep this file small. Put shared rules in `AGENTS.md` and detailed context in `docs/`.
- At the end of substantive work, make `docs/STATUS.md` accurate enough for a fresh session to continue without chat history.

## 役別セッション（デスクトップアプリ）

役別のセッション（lead以外）は、新規セッションでWorktreeをオンにして始め、leadはmainのフォルダで始める。最初に「`.claude/roles/<役名>.md` と `CLAUDE.md` を読んで、その役で作業して。」と送る。役がないまま作業を始めない。役の指示は`.claude/roles/<役>.md`、担当パスの正本は`.claude/roles/paths.json`。

| 役 | 書いてよいパス | 推奨モデル |
| --- | --- | --- |
| lead（司令塔、mainのフォルダ） | `docs/`、`README.md` | Opus |
| core | `apps/web/src/{ledger,events,holidays}/`とそのテスト、契約`apps/web/src/contracts/`とそのテスト、固定データ`apps/web/tests/fixtures/` | Opus |
| platform | `apps/web/src/{store,ingest,runner,llm}/`とそのテスト、`apps/web/db/`、`apps/web/scripts/` | Opus |
| web | `apps/web/src/{app,components,view}/`とそのテスト | Sonnet |
| verifier | `apps/web/tests/adversarial/` | Opus |

- 担当外のパスは読むだけ。直したい点と判断待ちは、直さずにissueのコメントに書く（宛先の役・内容・根拠）。取り消せないもの・費用・権利・安全に関わる判断は止まってownerに聞く（`docs/WORKFLOW.md` §5）。`docs/STATUS.md`はleadだけが更新する
- どの役も、`.claude/`・`.github/`・`scripts/`・`AGENTS.md`・`CLAUDE.md`・`.tool-versions`・`apps/web/{package.json,package-lock.json,next.config.ts,tsconfig.json,vitest.config.ts,postcss.config.mjs}`・`apps/web/public/`・`apps/web/scripts/check-purity.ts`・`apps/web/tests/scripts/`を変えない（ownerだけ）
- 新しいWorktreeでは先に`cd apps/web && npm ci`。完了前に、リポジトリのルートで`git fetch origin && scripts/check-boundaries.sh <役名>`を実行し、0で終わらせる（積み重ねたPRは基準に前のブランチを指定。verifierは検証対象のブランチ）
- 完了前に`code-reviewer`サブエージェントを呼ぶ。mainへ直接pushしない。マージはownerが手動で行う
- 仕事が終わったらセッションを閉じる。引き継ぎは、タスク票・issue・`docs/STATUS.md`に書く

- **限界：** この運用の役別セッションは`--agent`で起動しないので、書き込み前のフック（`agent_type`で役を見分ける）による役ごとの制限は**働かない**。守るのは、この表と役ファイルの約束、完了前の`check-boundaries.sh`、CODEOWNERSとownerの手動マージ。mainへのpush・`.env`・`gh pr merge`などの役を問わない禁止は、フックが働く（デスクトップアプリの新規セッション・Worktreeオンで`git push origin main`が止まることを確認済み。`docs/WORKFLOW.md` §4.7）
