// Claude Code の PreToolUse フック。どの役のセッションでも守る規則を、コマンドの全文を調べて止める（docs/WORKFLOW.md §4.7）。
//   止めるもの：mainへのpush・強制push・ブランチ削除、PRのマージ（ownerが手動で行う）、リポジトリ設定の変更、`.env`など秘密のファイルの読み書き（Bash・Read・編集ツール）
// 止めるときは終了コード2と理由（stderr）。入力が読めない・内部エラーのときも止める（settings.json の onFailure: "block" と二重）。
// 想定する相手は「うっかり」。シェルの書き方は無限にあるので、`python -c` や別のスクリプトの中での実行、別のGitHubクライアント、
// 大文字小文字を区別しないファイルシステムやシンボリックリンク経由の `.env`、`push.default=upstream` で上流がmainの引数なしpush、
// 別のディレクトリへの `git -C` / `cd` 越しのpush（現在のブランチは hook の cwd で見る）、case 文の `)` を含む入れ子、`grep -r` のようなディレクトリ全体の検索が `.env` を読むことなど、意図した回避や網羅できないものは止められない。
// 守りの本体はPRの境界（CODEOWNERS・CI・ownerの手動マージ）で、このフックはその手前の安全網。
// Node単体で動かす（依存なし）。テスト：apps/web/tests/scripts/guard.test.ts
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type HookInput = { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };
/** 実行環境への依存（テストで差し替える） */
export type Env = { branch: () => string };

const MAIN = new Set(["main", "master"]);

// ---- シェルの解析 ----

/** シェルの文字列を、単純なコマンドの語の列に分ける。引用符を外し、$(...)・`...`・bash -c・eval の中身も別のコマンドとして加える。ヒアドキュメントの本文は読み飛ばす */
export function parseCommands(text: string, depth = 0): string[][] {
  if (depth > 8) throw new Error("コマンドの入れ子が深く、解析できない");
  const out: string[][] = [];
  parseSeq(text, 0, depth, out, false);
  for (const cmd of [...out]) {
    const k = cmd.findIndex((w) => /^(?:ba|z|da|k)?sh$/.test(base(w)));
    const c = k < 0 ? -1 : cmd.findIndex((w, j) => j > k && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
    if (c >= 0 && cmd[c + 1] !== undefined) out.push(...parseCommands(cmd[c + 1]!, depth + 1));
    const first = cmd.findIndex((w) => !/^\w+=/.test(w));
    if (first >= 0 && cmd[first] === "eval") out.push(...parseCommands(cmd.slice(first + 1).join(" "), depth + 1));
  }
  return out;
}

/** text[start] から読む。inParen なら、対応する ")" の次の位置を返す */
function parseSeq(text: string, start: number, depth: number, out: string[][], inParen: boolean): number {
  if (depth > 8) throw new Error("コマンドの入れ子が深く、解析できない");
  let cur: string[] = [];
  let tok = "";
  let has = false;
  let redir = false;
  const pending: string[] = [];
  const flushTok = () => {
    if (has) cur.push(tok);
    tok = "";
    has = false;
    redir = false;
  };
  const flushCmd = () => {
    flushTok();
    if (cur.length > 0) out.push(cur);
    cur = [];
  };
  let i = start;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      const end = j < 0 ? text.length : j;
      tok += text.slice(i + 1, end);
      has = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        const d = text[j]!;
        if (d === "\\") tok += text[++j] ?? "";
        else if (d === "$" && text[j + 1] === "(") {
          tok += "$()";
          j = parseSeq(text, j + 2, depth + 1, out, true) - 1;
        } else if (d === "`") {
          const e = text.indexOf("`", j + 1);
          const end = e < 0 ? text.length : e;
          out.push(...parseCommands(text.slice(j + 1, end), depth + 1));
          tok += "$()";
          j = end;
        } else tok += d;
      }
      has = true;
      i = j;
    } else if (c === "\\") {
      if (text[i + 1] !== "\n") {
        tok += text[i + 1] ?? "";
        has = true;
      }
      i++;
    } else if (c === "$" && text[i + 1] === "(") {
      tok += "$()";
      has = true;
      i = parseSeq(text, i + 2, depth + 1, out, true) - 1;
    } else if (c === "`") {
      const e = text.indexOf("`", i + 1);
      const end = e < 0 ? text.length : e;
      out.push(...parseCommands(text.slice(i + 1, end), depth + 1));
      tok += "$()";
      has = true;
      i = end;
    } else if (c === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      flushTok();
      let j = i + 2;
      if (text[j] === "-") j++;
      while (text[j] === " " || text[j] === "\t") j++;
      let delim = "";
      for (; j < text.length && !/[\s;|&<>()]/.test(text[j]!); j++) if (!/['"\\]/.test(text[j]!)) delim += text[j];
      pending.push(delim);
      i = j - 1;
    } else if (c === "<" || c === ">") {
      // リダイレクト：語は "<" または ">" で始まる語として残す（対象のファイル名を語から切り離す）。直前の数字はファイル記述子。>&・<&・>| も1つの演算子
      if (/^\d+$/.test(tok)) {
        tok = "";
        has = false;
      }
      flushTok();
      while (text[i + 1] === c) i++;
      tok = c;
      if (text[i + 1] === "&" || (c === ">" && text[i + 1] === "|")) tok += text[++i];
      has = true;
      redir = true;
    } else if (c === "\n") {
      flushCmd();
      for (const delim of pending.splice(0)) {
        let j = i + 1;
        while (j < text.length) {
          const e = text.indexOf("\n", j);
          const line = text.slice(j, e < 0 ? text.length : e);
          j = e < 0 ? text.length : e + 1;
          if (line.trim() === delim) break;
        }
        i = j - 1;
      }
    } else if (c === ")") {
      flushCmd();
      if (inParen) return i + 1;
    } else if (c === "(" || c === ";" || c === "|") flushCmd();
    else if (c === "&") {
      if (text[i + 1] === ">") continue;
      if (text[i - 1] === ">") {
        tok += c;
        has = true;
      } else flushCmd();
    } else if (c === " " || c === "\t") {
      if (!(redir && /^[<>][&|]?$/.test(tok))) flushTok();
    }
    else if (c === "#" && !has) {
      const e = text.indexOf("\n", i);
      i = e < 0 ? text.length : e - 1;
    } else {
      tok += c;
      has = true;
    }
  }
  flushCmd();
  return i;
}

const base = (w: string) => w.slice(w.lastIndexOf("/") + 1);

// ---- 秘密のファイル ----

const SECRET_FILE = /(?:^|\/)\.env(?:\.[^/\s]+)?$/i;
const SAMPLE_FILE = /\.(?:example|sample|template)$/i;
/** `.env`・`.env.local` など（`.env.example` は除く）。`--env-file=.env`・`>.env`・`@.env`（curl・gh api の -F）の形も見る */
export const isSecretPath = (w: string): boolean =>
  [w, ...w.split("=")].some((p) => {
    const q = p.replace(/^[<>@&|]+/, "");
    return SECRET_FILE.test(q) && !SAMPLE_FILE.test(q);
  });
/** `.env*`・`.en?` のように、`.` で始まるワイルドカードが秘密のファイルに当たりうるか（シェルの `*` は先頭の `.` に当たらないので、`.` で始まる語だけ見る） */
export const globHitsSecret = (w: string): boolean => {
  const name = w.replace(/^[<>@&|]+/, "").split("/").pop() ?? "";
  if (!/[*?[{]/.test(name) || !name.startsWith(".")) return false;
  if (name.includes("{")) return true;
  try {
    const re = new RegExp(`^${name.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\[!/g, "[^").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    return [".env", ".env.local", ".env.production"].some((n) => re.test(n));
  } catch {
    return true;
  }
};
const touchesSecret = (w: string) => isSecretPath(w) || globHitsSecret(w);

// ---- git・gh ----

/** `--opt=値`・`-Xvalue`・`-X=値`・`-iXvalue` を「名前, 値」に分ける（オプションの書き方の揺れをそろえる）。shortWithValue は値を取る短いオプションの文字 */
function splitOpts(args: string[], shortWithValue: string): string[] {
  return args.flatMap((a) => {
    if (a.startsWith("--")) {
      const k = a.indexOf("=");
      return k < 0 ? [a] : [a.slice(0, k), a.slice(k + 1)];
    }
    if (!/^-[^-]/.test(a)) return [a];
    const out: string[] = [];
    for (let k = 1; k < a.length; k++) {
      out.push(`-${a[k]}`);
      if (shortWithValue.includes(a[k]!)) {
        const rest = a.slice(k + 1).replace(/^=/, "");
        if (rest !== "") out.push(rest);
        break;
      }
    }
    return out;
  });
}

/** git の全体オプションを飛ばして、サブコマンドと残りの引数を返す */
function gitSub(args: string[]): [string, string[]] | undefined {
  const withValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (withValue.has(a)) i++;
    else if (!a.startsWith("-") && !/^[<>]/.test(a)) return [a, args.slice(i + 1)];
  }
  return undefined;
}

/** gitは長いオプションを一意に決まる前方一致で受け付ける（--force-w、--delet など）ので、危ない名前の前方一致をすべて止める */
const DANGEROUS_PUSH = ["force", "force-with-lease", "force-if-includes", "mirror", "delete", "all", "prune"];

function checkPush(rest: string[], env: Env): string | null {
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") {
      positional.push(...rest.slice(i + 1).filter((w) => !/^[<>]/.test(w)));
      break;
    }
    if (["--push-option", "--repo", "--receive-pack", "--exec"].includes(a)) i++;
    else if (a.startsWith("--")) {
      const name = a.slice(2).split("=")[0]!;
      if (name !== "" && DANGEROUS_PUSH.some((d) => d.startsWith(name))) return `git push ${a} は使えない（履歴の書き換え・削除・全ブランチのpushになる）`;
    } else if (a.startsWith("-") && a.length > 1) {
      for (const [k, ch] of [...a.slice(1)].entries()) {
        if (ch === "o") {
          if (k === a.length - 2) i++;
          break;
        }
        if (ch === "f" || ch === "d") return `git push ${a} は使えない（強制push・削除）`;
      }
    } else if (!/^[<>]/.test(a)) positional.push(a);
  }
  const specs = positional.slice(1);
  const onMain = () => MAIN.has(env.branch()) || env.branch() === "";
  const isHead = (w: string) => w === "HEAD" || w === "@";
  if (specs.length === 0) return onMain() ? "mainブランチ（または現在のブランチが不明）からのpushは使えない。作業ブランチを切ってpushする" : null;
  for (const spec of specs) {
    if (/[$`*]/.test(spec)) return `pushの対象に展開される値・ワイルドカード（${spec}）は使えない。ブランチ名を直接書く`;
    if (spec.startsWith("+")) return "git push の + は強制pushなので使えない";
    const colon = spec.indexOf(":");
    const src = colon < 0 ? spec : spec.slice(0, colon);
    const dst = (colon < 0 ? spec : spec.slice(colon + 1)).replace(/^refs\/heads\//, "");
    if (src === "") return "git push でのブランチの削除は使えない";
    if (MAIN.has(dst)) return `main（${dst}）へのpushは使えない。PRを出して、ownerが手動でマージする`;
    if ((isHead(dst) || isHead(src)) && onMain()) return "mainブランチ（または現在のブランチが不明）からのpushは使えない";
  }
  return null;
}

/** gh api で書き込みを許すパス（PR・issueの作成と更新、コメント、レビュー）。それ以外への書き込みは、マージ・ref・ファイル・保護設定・秘密など、すべて止める */
const REPO = "repos/[^/]+/[^/]+";
const API_WRITE_OK = [
  `${REPO}/pulls`, `${REPO}/pulls/\\d+`, `${REPO}/pulls/\\d+/(?:comments|reviews|requested_reviewers|ccr/ready_for_review|ccr/convert_to_draft)`, `${REPO}/pulls/\\d+/comments/\\d+/replies`, `${REPO}/pulls/\\d+/reviews/\\d+/events`,
  `${REPO}/pulls/\\d+/ccr/comments/\\d+/(?:resolve|unresolve)`, `${REPO}/pulls/comments/\\d+`,
  `${REPO}/issues`, `${REPO}/issues/\\d+`, `${REPO}/issues/\\d+/(?:comments|labels|assignees)`, `${REPO}/issues/comments/\\d+`,
].map((p) => new RegExp(`^${p}$`));

function checkGh(args: string[]): string | null {
  const opts = splitOpts(args, "RXfFHqtp");
  const words: string[] = [];
  for (let i = 0; i < opts.length; i++) {
    if (["-R", "--repo", "--hostname"].includes(opts[i]!)) i++;
    else if (!/^[-<>]/.test(opts[i]!)) words.push(opts[i]!);
  }
  if (opts.some((w) => w.includes("large-pr-approved"))) return "ラベル large-pr-approved はownerだけが付ける（.github/workflows/pr-size.yml）";
  const [group, action] = words;
  if (group === "pr" && action === "merge") return "PRのマージはownerが手動で行う（docs/WORKFLOW.md §4.6）";
  if (group === "repo" && !["view", "list", "clone"].includes(action ?? "")) return `gh repo ${action ?? ""} は使えない（リポジトリ設定の変更はownerが行う）`;
  if (group === "ruleset" || group === "secret" || group === "variable") return `gh ${group} は使えない（設定の変更はownerが行う）`;
  if (group === "auth" && (action !== "status" || opts.includes("--show-token") || opts.includes("-t"))) return "gh auth のトークンの表示・認証の変更は使えない（秘密情報をログに出さない）";
  if (group !== "api") return null;
  let method: string | undefined;
  let input = false;
  const fields: string[] = [];
  let path: string | undefined;
  for (let i = opts.indexOf("api") + 1; i < opts.length; i++) {
    const a = opts[i]!;
    if (a === "-X" || a === "--method") method = opts[++i]?.toUpperCase();
    else if (["-f", "-F", "--field", "--raw-field"].includes(a)) fields.push(opts[++i] ?? "");
    else if (a === "--input") {
      input = true;
      i++;
    } else if (["-H", "--header", "-q", "--jq", "-t", "--template", "--hostname", "--cache", "-p", "--preview"].includes(a)) i++;
    else if (!a.startsWith("-") && path === undefined) path = a;
  }
  const effective = method ?? (fields.length > 0 || input ? "POST" : "GET");
  if (effective === "DELETE") return "gh api の DELETE は使えない";
  if (path === undefined) return null;
  const p = path.replace(/^https?:\/\/[^/]+\//, "").replace(/^\//, "").split("?")[0]!;
  if (p === "graphql") return input || fields.some((f) => /(?:^|=)@/.test(f) || /mutation/i.test(f)) ? "gh api graphql の mutation・ファイルや --input での指定は使えない（中身を確かめられない）" : null;
  if (effective === "GET" || effective === "HEAD" || API_WRITE_OK.some((re) => re.test(p))) return null;
  return `gh api ${p} への書き込みは使えない（許すのは、PR・issueの作成と更新、コメント、レビューだけ。マージ・ref・ファイル・設定は ownerが行う）`;
}

// ---- 入口 ----

export function checkBash(command: string, env: Env): string | null {
  for (const cmd of parseCommands(command)) {
    const secret = cmd.find(touchesSecret);
    if (secret !== undefined) return `秘密のファイル（${secret}）には触れない。必要な値は、ownerが環境変数で渡す`;
    const g = cmd.findIndex((w) => base(w) === "git");
    if (g >= 0) {
      const sub = gitSub(cmd.slice(g + 1));
      if (sub?.[0] === "push") {
        const why = checkPush(sub[1], env);
        if (why) return why;
      }
    }
    const h = cmd.findIndex((w) => base(w) === "gh");
    if (h >= 0) {
      const why = checkGh(cmd.slice(h + 1));
      if (why) return why;
    }
  }
  return null;
}

/** 止める理由を返す。通すなら null */
export function decide(input: HookInput, env: Env): string | null {
  const ti = input.tool_name === undefined ? {} : (input.tool_input ?? {});
  let targets: unknown[];
  switch (input.tool_name) {
    case "Bash":
      return typeof ti.command === "string" ? checkBash(ti.command, env) : null;
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      targets = [ti.file_path, ti.notebook_path];
      break;
    case "Grep":
      targets = [ti.path, ti.glob];
      break;
    case "Glob":
      targets = [ti.pattern, ti.path];
      break;
    default:
      return null;
  }
  const hit = targets.find((t): t is string => typeof t === "string" && touchesSecret(t));
  return hit === undefined ? null : `秘密のファイル（${hit}）は読み書きしない。必要な値は、ownerが環境変数で渡す`;
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(here)) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    const branch = () => {
      try {
        return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: input.cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return "";
      }
    };
    const why = decide(input, { branch });
    if (why) {
      console.error(`ブロック：${why}`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`ブロック：フックの内部エラーで安全を確かめられない（${e instanceof Error ? e.message : String(e)}）`);
    process.exit(2);
  }
}
