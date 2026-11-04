import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const paths = JSON.parse(read(".claude/roles/paths.json")) as { roles: Record<string, string[]>; protected: string[] };
const claude = read("CLAUDE.md");

/** `a/{b,c}/d` を展開する（入れ子なし） */
const expand = (s: string): string[] => {
  const m = /\{([^{}]*)\}/.exec(s);
  return m === null ? [s] : m[1]!.split(",").flatMap((x) => expand(s.slice(0, m.index) + x + s.slice(m.index + m[0].length)));
};
/** 行の中のバッククォートで囲んだ語を、展開して、末尾の / を除いた集合にする */
const spans = (line: string): Set<string> =>
  new Set([...line.matchAll(/`([^`]+)`/g)].flatMap((m) => expand(m[1]!)).map((x) => x.replace(/\/$/, "")));
const trim = (p: string) => p.replace(/\/$/, "");
const tableRow = (role: string) => claude.split("\n").find((l) => new RegExp(`^\\| ${role}[ （(]`).test(l));

describe("役ファイル・CLAUDE.md の担当表が、paths.json と食い違わない", () => {
  it("役の集合が、paths.json の roles、.claude/roles/*.md、CLAUDE.md の表の行で一致する", () => {
    const fromPaths = Object.keys(paths.roles).sort();
    const fromFiles = readdirSync(join(root, ".claude/roles")).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
    const fromTable = claude.split("\n").flatMap((l) => /^\| (\w+)[ （(]/.exec(l)?.[1] ?? []).filter((r) => r !== "役").sort();
    expect(fromFiles).toEqual(fromPaths);
    expect(fromTable).toEqual(fromPaths);
  });

  for (const [role, ps] of Object.entries(paths.roles)) {
    const md = read(`.claude/roles/${role}.md`);
    const section = md.slice(md.indexOf("## 担当するディレクトリ"), md.indexOf("## 触らないもの"));

    it(`${role}: 役ファイルの名前・見出し・完了の条件`, () => {
      expect(md).toMatch(new RegExp(`^---\\nname: ${role}\\n`));
      expect(md).toContain(`scripts/check-boundaries.sh ${role}`);
      for (const h of ["## 最初に読むもの", "## 担当するディレクトリ", "## 触らないもの", "## 完了の条件", "## 報告の形"]) expect(md).toContain(h);
      expect(md).toContain(`agent/${role}/`);
      if (role !== "verifier" && role !== "lead") expect(md).toContain("code-reviewer");
    });

    it(`${role}: paths.json の担当パスが、CLAUDE.md の表と役ファイルに、パス全体で出てくる`, () => {
      const row = tableRow(role);
      expect(row, `CLAUDE.md の表に ${role} の行がない`).toBeDefined();
      const inRow = spans(row!);
      const inMd = spans(section);
      for (const p of ps.map(trim)) {
        const isTest = /^apps\/web\/tests\/(?!adversarial|fixtures)/.test(p);
        // 表では tests/ 側を「とそのテスト」で略すので、対応する src/ 側のパスで照合する
        const rowKey = isTest ? p.replace("/tests/", "/src/") : p;
        expect(inRow.has(rowKey), `CLAUDE.md の ${role} の行に ${rowKey} がない`).toBe(true);
        if (isTest) expect(row, `${role} の行に「テスト」がない`).toContain("テスト");
        expect(inMd.has(p), `${role}.md の担当するディレクトリに ${p} がない`).toBe(true);
      }
      // 逆向き：表と役ファイルにある apps/ docs/ README のパスが、paths.json にない余りがない
      const known = new Set(ps.map(trim));
      for (const x of inMd) if (/^(apps|docs|README)/.test(x)) expect(known.has(x) || x === "apps/web/scripts/check-purity.ts", `${role}.md に paths.json にないパス ${x}`).toBe(true);
    });
  }

  it("CLAUDE.md の「変えない」一覧が、paths.json の protected と一致する", () => {
    const line = claude.split("\n").find((l) => l.includes("ownerだけ") && l.includes(".claude/"));
    expect(line).toBeDefined();
    expect([...spans(line!)].sort()).toEqual(paths.protected.map(trim).sort());
  });
});
