# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""文書の参照を確かめる。

- Markdownのリンク [text](path) が実在するファイルを指すこと
- `FILE.md` §N の形の参照が、その文書の見出し「## N.」を指すこと

使い方: uv run scripts/check_docs.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "node_modules", ".next"}
LINK = re.compile(r"\]\(([^)\s]+)\)")
SECTION_REF = re.compile(r"`(?:docs/)?([A-Z_0-9]+\.md)`\s*§(\d+)(?:〜§?(\d+))?")
HEADING = re.compile(r"^##+ (\d+)\.? ", re.M)


def markdown_files() -> list[Path]:
    return [p for p in ROOT.rglob("*.md") if not SKIP_DIRS.intersection(p.relative_to(ROOT).parts)]


def main() -> int:
    docs = ROOT / "docs"
    headings = {p.name: set(HEADING.findall(p.read_text(encoding="utf-8"))) for p in docs.glob("*.md")}
    errors: list[str] = []
    for path in markdown_files():
        rel = path.relative_to(ROOT)
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for target in LINK.findall(line):
                if target.startswith(("http://", "https://", "#", "mailto:")):
                    continue
                file_part = target.split("#", 1)[0]
                if file_part and not (path.parent / file_part).resolve().exists():
                    errors.append(f"{rel}:{n}: broken link {target}")
            for doc, first, last in SECTION_REF.findall(line):
                for section in filter(None, (first, last)):
                    if section not in headings.get(doc, set()):
                        errors.append(f"{rel}:{n}: {doc} has no section {section}")
    for e in errors:
        print(e)
    print(f"checked {len(markdown_files())} files: {'OK' if not errors else f'{len(errors)} problem(s)'}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
