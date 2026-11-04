#!/usr/bin/env bash
# 完了前の境界検査。役の担当パス（.claude/roles/paths.json）の外を変更していないかを確かめる。
# 使い方：scripts/check-boundaries.sh <役> [基準ブランチ]   （基準の既定は origin/main。事前に git fetch しておく）
# 比べるもの：基準ブランチとの分岐点からの変更すべて＝コミット済み・ステージ済み・作業ツリー・新規の未追跡ファイル。
# 見ないもの：.gitignore されたファイル、assume-unchanged / skip-worktree を付けたファイルの変更。
# 判定のルール（paths.json）と検査のコードは、基準ブランチの版を使う。検査される側が書き換えても、判定は変わらない。
# 基準にまだ検査のコードがない場合（この検査を導入するPRだけ）は、作業ツリーの版を使い、そう表示する。
# 終了コード：0=違反なし / 1=担当外あり / 2=使い方や設定の誤り（git の失敗を含む）
set -euo pipefail

role="${1:-}"
base="${2:-origin/main}"
if [ -z "$role" ]; then
  echo "使い方：scripts/check-boundaries.sh <役> [基準ブランチ]" >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)" || exit 2
cd "$root"
if ! mb="$(git merge-base "$base" HEAD 2>/dev/null)"; then
  echo "基準ブランチ（$base）が見つからない。git fetch してから、もう一度実行する" >&2
  exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 変更の一覧：途中で git が失敗したら、検査せずに 2 で終わる。--no-renames は、名前の変更の元と先の両方を見るため
{
  git diff --name-only --no-renames -z "$mb"
  git diff --cached --name-only --no-renames -z "$mb"
  git ls-files --others --exclude-standard -z
} > "$tmp/list" || { echo "変更の一覧を取れない（git の失敗）" >&2; exit 2; }

# 検査のコードとルールは、基準ブランチの版を使う
files=(.claude/hooks/check-boundaries.ts .claude/hooks/guard.ts .claude/roles/paths.json)
mkdir -p "$tmp/code/.claude/hooks" "$tmp/code/.claude/roles"
use_base=1
for f in "${files[@]}"; do
  git show "$base:$f" > "$tmp/code/$f" 2>/dev/null || use_base=0
done
if [ "$use_base" = 1 ]; then
  codedir="$tmp/code"
else
  echo "注意：基準ブランチ（$base）に検査のコードがないので、作業ツリーの版を使う（導入のPRだけの例外）" >&2
  codedir="$root"
fi

node "$codedir/.claude/hooks/check-boundaries.ts" "$role" < "$tmp/list"
