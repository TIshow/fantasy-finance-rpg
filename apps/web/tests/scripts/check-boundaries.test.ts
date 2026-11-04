import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFiles } from "../../../../.claude/hooks/check-boundaries";
import { isKnownRole } from "../../../../.claude/hooks/guard";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("checkFiles（担当内かどうか）", () => {
  it("担当内は空、担当外は理由つきで返す", () => {
    expect(checkFiles("web", ["apps/web/src/app/page.tsx", "apps/web/tests/view/t.test.ts"])).toEqual([]);
    const bad = checkFiles("web", ["apps/web/src/app/page.tsx", "apps/web/src/ledger/a.ts", "docs/STATUS.md"]);
    expect(bad).toHaveLength(2);
    expect(bad[0]).toContain("apps/web/src/ledger/a.ts");
    expect(bad[0]).toContain("web の担当外");
  });

  it("守りの設定は、担当パスの中にあっても違反。生成物は無視", () => {
    expect(checkFiles("platform", ["apps/web/scripts/check-purity.ts"])[0]).toContain("守りの設定");
    expect(checkFiles("lead", ["AGENTS.md", ".claude/roles/paths.json"])).toHaveLength(2);
    expect(checkFiles("core", ["apps/web/.next/x.js", "apps/web/tsconfig.tsbuildinfo"])).toEqual([]);
  });

  it("読み取り専用の役は、何を変えても違反", () => {
    expect(checkFiles("code-reviewer", ["docs/x.md"])[0]).toContain("読み取り専用");
    expect(checkFiles("code-reviewer", [])).toEqual([]);
  });

  it("./ 付きや空の要素を扱える。担当の外へ出る .. も違反", () => {
    expect(checkFiles("lead", ["./docs/a.md", ""])).toEqual([]);
    expect(checkFiles("lead", ["docs/../apps/web/src/ledger/a.ts"]).length).toBe(1);
  });

  it("リポジトリの外へ出るパスは違反", () => {
    expect(checkFiles("lead", ["../x", "/etc/hosts"])).toHaveLength(2);
  });

  it("未知の役では checkFiles は何も止めない。綴り違いは CLI が isKnownRole で止める", () => {
    expect(checkFiles("wbe", ["apps/web/src/ledger/a.ts"]).length).toBe(0);
    for (const r of ["lead", "core", "platform", "web", "verifier", "code-reviewer", "Explore", "Plan"]) expect(isKnownRole(r), r).toBe(true);
    for (const r of ["wbe", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) expect(isKnownRole(r), r).toBe(false);
  });
});

describe("scripts/check-boundaries.sh（実際の git で）", () => {
  const git = (cwd: string, ...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  };
  const put = (dir: string, rel: string, text = "x\n") => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  /** 一時リポジトリ：main に初期ファイルがあり、branch を切った状態。fn で変更を作って検査を走らせる */
  const inRepo = (fn: (dir: string, run: (role: string, base?: string) => { status: number | null; out: string }) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "boundaries-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      for (const f of [".claude/hooks/guard.ts", ".claude/hooks/check-boundaries.ts", ".claude/roles/paths.json", "scripts/check-boundaries.sh"]) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        copyFileSync(join(repoRoot, f), join(dir, f));
      }
      put(dir, "docs/STATUS.md");
      put(dir, "apps/web/src/app/page.tsx");
      put(dir, "apps/web/src/ledger/a.ts");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "init");
      git(dir, "switch", "-q", "-c", "agent/web/1-x");
      const run = (role: string, base = "main") => {
        const r = spawnSync("bash", [join(dir, "scripts/check-boundaries.sh"), role, base], { cwd: dir, encoding: "utf8" });
        return { status: r.status, out: r.stdout + r.stderr };
      };
      fn(dir, run);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("変更がなければ通る。担当内の変更（コミット済み・未コミット・新規）も通る", () =>
    inRepo((dir, run) => {
      expect(run("web").status).toBe(0);
      put(dir, "apps/web/src/app/page.tsx", "changed\n");
      put(dir, "apps/web/src/view/new.ts");
      expect(run("web").status).toBe(0);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "web");
      put(dir, "apps/web/src/components/c.tsx");
      expect(run("web").out).toContain("違反なし");
    }));

  it("担当外は、未コミットの変更・新規の未追跡ファイル・コミット済みのどれでも止まる", () =>
    inRepo((dir, run) => {
      put(dir, "apps/web/src/ledger/a.ts", "edited\n");
      const r1 = run("web");
      expect(r1.status).toBe(1);
      expect(r1.out).toContain("apps/web/src/ledger/a.ts");
      git(dir, "checkout", "-q", "--", "apps/web/src/ledger/a.ts");
      put(dir, "docs/new.md");
      expect(run("web").status).toBe(1);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "docs");
      expect(run("web").status).toBe(1);
    }));

  it("削除と名前の変更は、元と先の両方を見る（担当外→担当内の移動で、元のパスが出る）", () =>
    inRepo((dir, run) => {
      git(dir, "rm", "-q", "apps/web/src/ledger/a.ts");
      expect(run("web").status).toBe(1);
      git(dir, "reset", "-q", "--hard");
      git(dir, "mv", "apps/web/src/ledger/a.ts", "apps/web/src/app/a.ts");
      const r = run("web");
      expect(r.status).toBe(1);
      expect(r.out).toContain("apps/web/src/ledger/a.ts");
      git(dir, "commit", "-q", "-m", "mv");
      expect(run("web").out).toContain("apps/web/src/ledger/a.ts");
      git(dir, "reset", "-q", "--hard", "main");
      git(dir, "mv", "apps/web/src/app/page.tsx", "docs/page.tsx");
      expect(run("web").out).toContain("docs/page.tsx");
    }));

  it("ステージ済みの変更は、作業ツリーを元に戻しても見逃さない", () =>
    inRepo((dir, run) => {
      put(dir, "apps/web/src/ledger/a.ts", "edited\n");
      git(dir, "add", "-A");
      git(dir, "checkout", "-q", "--", "apps/web/src/ledger/a.ts"); // 作業ツリーは元に戻る（status は MM）
      git(dir, "diff", "--quiet"); // 作業ツリーに差分はない
      expect(run("web").status).toBe(1);
      git(dir, "reset", "-q", "--hard");
      put(dir, "docs/new.md");
      git(dir, "add", "docs/new.md");
      rmSync(join(dir, "docs/new.md")); // 追加して消した（status は AD）
      expect(run("web").status).toBe(1);
    }));

  it("検査される側が paths.json や検査のコードを書き換えても、判定は基準の版で行う", () =>
    inRepo((dir, run) => {
      const pj = JSON.parse(readFileSync(join(dir, ".claude/roles/paths.json"), "utf8")) as { roles: Record<string, string[]>; protected: string[] };
      pj.roles.web = [".claude/", "docs/", "apps/"];
      pj.protected = ["unrelated/"];
      writeFileSync(join(dir, ".claude/roles/paths.json"), JSON.stringify(pj));
      put(dir, "apps/web/src/ledger/a.ts", "edited\n");
      const r = run("web");
      expect(r.status).toBe(1);
      expect(r.out).toContain(".claude/roles/paths.json");
      git(dir, "checkout", "-q", "--", ".claude/roles/paths.json");
      writeFileSync(join(dir, ".claude/hooks/check-boundaries.ts"), "process.exit(0);\n");
      expect(run("web").status).toBe(1);
    }));

  it("読み取り専用の役は、何を変えても 1 で終わる。変更がなければ 0", () =>
    inRepo((dir, run) => {
      expect(run("code-reviewer").status).toBe(0);
      put(dir, "docs/x.md");
      expect(run("code-reviewer").status).toBe(1);
    }));

  it("基準にまだ検査のコードがないとき（導入のPR）は、作業ツリーの版で動き、そう表示する", () =>
    inRepo((dir, run) => {
      git(dir, "rm", "-q", "-r", "--cached", ".claude/hooks/check-boundaries.ts");
      git(dir, "commit", "-q", "-m", "base without check");
      git(dir, "switch", "-q", "-c", "agent/web/2-y");
      git(dir, "branch", "-f", "main", "agent/web/1-x");
      const r = run("web");
      expect(r.out).toContain("導入のPRだけの例外");
    }));

  it("直接 node で、NUL 区切りでない入力を渡すと通さずに 2 で終わる", () => {
    const r = spawnSync(process.execPath, [join(repoRoot, ".claude/hooks/check-boundaries.ts"), "lead"], { input: "docs/x\n.claude/foo", encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(spawnSync(process.execPath, [join(repoRoot, ".claude/hooks/check-boundaries.ts"), "lead"], { input: "docs/x\0", encoding: "utf8" }).status).toBe(0);
  });

  it("名前に空白や日本語を含むパスも扱える", () =>
    inRepo((dir, run) => {
      put(dir, "apps/web/src/app/日本語 ファイル.tsx");
      expect(run("web").status).toBe(0);
      put(dir, "docs/日本語 ファイル.md");
      expect(run("web").status).toBe(1);
    }));

  it("知らない役・基準ブランチなし・引数なしは、通さずに 2 で終わる", () =>
    inRepo((dir, run) => {
      put(dir, "docs/STATUS.md", "changed\n");
      expect(run("wbe").status).toBe(2);
      expect(run("web", "no-such-branch").status).toBe(2);
      expect(run("").status).toBe(2);
    }));

  it("作業ツリーの paths.json を壊すと違反（1）。基準の paths.json が壊れていれば、通さずに 2 で終わる", () =>
    inRepo((dir, run) => {
      writeFileSync(join(dir, ".claude/roles/paths.json"), "{");
      expect(run("web").status).toBe(1);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "broken");
      git(dir, "branch", "-f", "main", "HEAD"); // 基準のほうが壊れている
      expect(run("web").status).toBe(2);
    }));
});
