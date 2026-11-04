// Claude Code の PreToolUse フック。どの役のセッションでも守る規則を、コマンドの全文を調べて止める（docs/WORKFLOW.md §4.7）。
//   止めるもの：mainへのpush・強制push・ブランチ削除、PRのマージ（ownerが手動で行う）、リポジトリ設定の変更、`.env`など秘密のファイルの読み書き（Bash・Read・編集ツール）
// 止めるときは終了コード2と理由（stderr）。入力が読めない・内部エラーのときも止める（settings.json の onFailure: "block" と二重）。
// 想定する相手は「うっかり」。シェルの書き方は無限にあるので、`python -c` や別のスクリプトの中での実行、別のGitHubクライアント、
// 大文字小文字を区別しないファイルシステムやシンボリックリンク経由の `.env`、`push.default=upstream` で上流がmainの引数なしpush、
// 別のディレクトリへの `git -C` / `cd` 越しのpush（現在のブランチは hook の cwd で見る）、case 文の `)` を含む入れ子、`grep -r` のようなディレクトリ全体の検索が `.env` を読むことなど、意図した回避や網羅できないものは止められない。
// 守りの本体はPRの境界（CODEOWNERS・CI・ownerの手動マージ）で、このフックはその手前の安全網。
// Node単体で動かす（依存なし）。テスト：apps/web/tests/scripts/guard.test.ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type HookInput = { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string; agent_type?: string };
/** 実行環境への依存（テストで差し替える） */
export type Env = { branch: () => string; /** path が属する worktree のルート（その場所での git rev-parse --show-toplevel）。git の外なら null。役が決まっているときだけ呼ぶ */ root: (path: string) => string | null };

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
  let quoted = false;
  const pending: string[] = [];
  const flushTok = () => {
    // 引用符の中から来た "<" ">" で始まる語（"> 引用" や ">= 0"）は、リダイレクトではないので印を付けて区別する
    if (has) cur.push(quoted && !redir && /^[<>]/.test(tok) ? `\u0002${tok}` : tok);
    tok = "";
    has = false;
    redir = false;
    quoted = false;
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
      quoted = true;
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
      quoted = true;
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

// ---- 役ごとの書き込み先 ----

/** 役の担当パス・読み取り専用の役・守りの設定・生成物。正本は .claude/roles/paths.json。役があるときだけ読む。形が違うもの（空の一覧、配列でない役の表、空の担当など）は、制限が外れる方向に働くので、読み込みの時点で例外にして止める */
type RolePaths = { roles: Record<string, string[]>; readOnly: string[]; protected: string[]; generated: string[] };
const strings = (v: unknown, nonEmpty: boolean): v is string[] => Array.isArray(v) && (!nonEmpty || v.length > 0) && v.every((x) => typeof x === "string" && x !== "");
let pathsCache: RolePaths | undefined;
function rolePaths(): RolePaths {
  if (pathsCache === undefined) {
    const j = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../roles/paths.json"), "utf8")) as Record<string, unknown>;
    const roles = j.roles;
    const rolesOk = typeof roles === "object" && roles !== null && !Array.isArray(roles) && Object.keys(roles).length > 0 && Object.values(roles).every((v) => strings(v, true));
    if (!rolesOk || !strings(j.readOnly, true) || !strings(j.protected, true) || !strings(j.generated, false)) throw new Error("paths.json の形が違う");
    pathsCache = j as unknown as RolePaths;
  }
  return pathsCache;
}

/** list に入るか。末尾が / のものはその下。self なら、そのディレクトリ自身（mkdir -p・rm -rf .claude など）も含める */
const inList = (rel: string, list: string[], self = false) => list.some((p) => (p.endsWith("/") ? rel.startsWith(p) || (self && rel === p.slice(0, -1)) : rel === p));

/** realpath。存在しない末尾は、存在する親の実体のパスにつなぐ（シンボリックリンクや .. での抜け道を塞ぐ） */
export function realpathLoose(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const d = dirname(p);
    return d === p ? p : join(realpathLoose(d), basename(p));
  }
}

/** シェルのワイルドカード（* ? [..] {a,b}）を正規表現にする。先頭の . にも当たる（安全側） */
const globToRe = (g: string): RegExp =>
  new RegExp(`^${g.replace(/[.+^$()|\\]/g, "\\$&").replace(/\[!/g, "[^").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\{([^{}]*)\}/g, (_, x: string) => `(?:${x.split(",").join("|")})`)}$`);

/** role が target（絶対パス、または cwd からの相対）に書いてよいか。だめなら理由。role が undefined（ownerが直接動かすセッション）は制限しない。判定は target が属する worktree のルートからの相対パスで行う */
export function checkWrite(role: string | undefined, target: string, cwd: string, env: Env): string | null {
  if (role === undefined) return null;
  if (target.startsWith("~") && target !== "~" && !target.startsWith("~/")) return `${target} の形（~ユーザー名）は調べられない。パスを直接書く`;
  const expanded = target === "~" || target.startsWith("~/") ? join(homedir(), target.slice(1)) : target;
  const abs = realpathLoose(resolve(cwd, expanded));
  const root = env.root(abs);
  const rel = root === null ? ".." : relative(realpathLoose(root), abs).split(sep).join("/");
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return [realpathLoose("/tmp"), realpathLoose(tmpdir()), "/dev"].some((t) => abs.startsWith(t + sep)) ? null : `リポジトリの外（${target}）には書かない（/tmp は可）`;
  }
  return judgeRel(role, rel);
}

/** 役が知られているか（paths.json の roles か readOnly にある）。完了前の検査が、綴り違いの役を黙って通さないために使う */
export function isKnownRole(role: string): boolean {
  return Object.hasOwn(rolePaths().roles, role) || rolePaths().readOnly.includes(role);
}

/** リポジトリのルートからの相対パス rel に、role が書いてよいか。だめなら理由。書き込み前のフック（checkWrite）と、完了前の検査（check-boundaries）が共有する判定 */
export function judgeRel(role: string, rel: string): string | null {
  // constructor・__proto__ などは役の名前ではない（以前は内部エラーで止まっていた。止める向きを保つ）
  if (!Object.hasOwn(rolePaths().roles, role) && !rolePaths().readOnly.includes(role) && role in {}) return `不明な役名（${role}）`;
  if (rolePaths().readOnly.includes(role)) return `${role} は読み取り専用の役。ファイルは書かない（${rel}）`;
  if (inList(rel, rolePaths().generated, true)) return null;
  const guardedAncestor = rel === "" || rolePaths().protected.some((p) => p.startsWith(`${rel}/`));
  const globHit = /[*?[{]/.test(rel) && rolePaths().protected.some((p) => globToRe(rel).test(p.replace(/\/$/, "")));
  if (inList(rel, rolePaths().protected, true) || guardedAncestor || globHit)
    return `${rel || "."} は守りの設定（またはそれを含む場所）で、ownerだけが変更する。必要ならissueのコメントでleadに頼む（WORKFLOW §5）`;
  const allowed = Object.hasOwn(rolePaths().roles, role) ? rolePaths().roles[role] : undefined;
  if (allowed === undefined || inList(rel, allowed, true)) return null;
  return `${role} の担当外のパス（${rel}）。担当：${allowed.join("・")}。必要ならissueのコメントでleadに頼む（WORKFLOW §5）`;
}

/** 実行するプログラムの前に付く語と、値を取るオプションの正規表現・飛ばす位置引数の数 */
const WRAPPERS: Record<string, [RegExp, number]> = {
  sudo: [/^-[ugChprtUT]$/, 0], env: [/^-[uSC]$/, 0], nohup: [/^$/, 0], time: [/^$/, 0], command: [/^$/, 0], nice: [/^-n$/, 0], exec: [/^$/, 0], builtin: [/^$/, 0], timeout: [/^-[ks]$/, 1],
};
/** 値を取るオプション（その値を書き込み先と取り違えない）と、つなげて書ける短いオプションの値の文字 */
const VALUE_OPTS: Record<string, string[]> = {
  touch: ["-d", "-t", "-r", "--date", "--reference"], mkdir: ["-m", "--mode"], truncate: ["-s", "-r", "--size", "--reference"],
  install: ["-m", "-o", "-g", "--mode", "--owner", "--group"], chmod: ["--reference"], chown: ["--reference"],
};
const SHORT_VALUE: Record<string, string> = { cp: "t", mv: "t", install: "tmog", ln: "t", sed: "ef", touch: "dtr", mkdir: "m", truncate: "sr" };
const WRITERS = new Set(["tee", "sed", "cp", "mv", "install", "ln", "rm", "rmdir", "unlink", "touch", "mkdir", "truncate", "chmod", "chown", "dd", "git"]);

/** コマンドが書き込む先。うっかり検出の範囲：リダイレクト、tee、sed -i、cp・mv・install・ln、rm・rmdir・unlink、touch・mkdir・truncate、chmod・chown、dd of=、git mv・git rm。`$` を含む語は展開されるので調べない */
export function writeTargets(cmd: string[]): string[] {
  const out = cmd.filter((w) => w.startsWith(">") && !/^>+&\d*-?$/.test(w)).map((w) => w.replace(/^>+[|&]?/, "")).filter((w) => w !== "");
  const words = cmd.filter((w) => !/^[<>]/.test(w)).map((w) => w.replace(/^\u0002/, ""));
  let i = 0;
  for (;;) {
    const w = words[i];
    const wrap = w === undefined ? undefined : WRAPPERS[base(w)];
    if (w !== undefined && /^\w+=/.test(w)) i++;
    else if (wrap !== undefined) {
      i++;
      while (words[i]?.startsWith("-")) i += wrap[0].test(words[i]!) ? 2 : 1;
      i += wrap[1];
    } else break;
  }
  let prog = words[i] === undefined ? "" : base(words[i]!);
  let args = words.slice(i + 1);
  if (prog === "git") {
    const sub = gitSub(args);
    if (sub?.[0] !== "mv" && sub?.[0] !== "rm") return out.filter((w) => !w.includes("$"));
    prog = sub[0] === "mv" ? "mv" : "rm";
    args = sub[1];
  }
  if (!WRITERS.has(prog)) return out.filter((w) => !w.includes("$"));
  args = splitOpts(args, SHORT_VALUE[prog] ?? "");
  const valueOpts = VALUE_OPTS[prog] ?? [];
  const isOpt = (a: string) => (prog === "chmod" ? a.startsWith("--") || /^-[RfvcHLP]+$/.test(a) : a.startsWith("-"));
  const pos: string[] = [];
  let targetDir: string | undefined;
  let scriptOpt = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (prog === "dd") {
      if (a.startsWith("of=")) out.push(a.slice(3));
    } else if (prog === "sed" && ["-e", "-f", "--expression", "--file"].includes(a)) {
      scriptOpt = true;
      k++;
    } else if (a === "-t" && ["cp", "mv", "install", "ln"].includes(prog)) targetDir = args[++k];
    else if (a.startsWith("--target-directory")) targetDir = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++k];
    else if (valueOpts.includes(a)) k++;
    else if (!isOpt(a)) pos.push(a);
  }
  const has = (re: RegExp) => args.some((a) => re.test(a));
  switch (prog) {
    case "dd": break;
    case "sed": if (has(/^-[a-zA-Z]*i/) || has(/^--in-place/)) out.push(...(scriptOpt ? pos : pos.slice(1))); break;
    case "install": out.push(...(has(/^-[a-zA-Z]*d/) ? pos : targetDir !== undefined ? [targetDir] : pos.slice(-1))); break;
    case "cp": case "ln": out.push(...(targetDir !== undefined ? [targetDir] : pos.slice(-1))); break;
    case "mv": out.push(...pos, ...(targetDir !== undefined ? [targetDir] : [])); break;
    case "chmod": case "chown": out.push(...pos.slice(has(/^--reference/) ? 0 : 1)); break;
    default: out.push(...pos);
  }
  return out.filter((w) => !w.includes("$"));
}

// ---- 入口 ----

export function checkBash(command: string, env: Env, who: { role?: string; cwd?: string } = {}): string | null {
  // cd の行き先を文字どおりの引数だけ追う。分からなくなったら undefined（相対パスの書き込みは止める）
  let cwd: string | undefined = who.cwd ?? process.cwd();
  for (const cmd of parseCommands(command)) {
    const secret = cmd.find(touchesSecret);
    if (secret !== undefined) return `秘密のファイル（${secret}）には触れない。必要な値は、ownerが環境変数で渡す`;
    if (who.role !== undefined) {
      for (const t of writeTargets(cmd)) {
        if (cwd === undefined && !isAbsolute(t) && !t.startsWith("~")) return `cd の行き先を読み取れないので、相対パス（${t}）への書き込みは調べられない。絶対パスで書く`;
        const why = checkWrite(who.role, t, cwd ?? "/", env);
        if (why) return why;
      }
      const first = cmd.find((w) => !/^\w+=/.test(w) && !/^[<>]/.test(w));
      if (first !== undefined && ["cd", "pushd", "popd"].includes(base(first))) {
        const args = cmd.slice(cmd.indexOf(first) + 1).filter((w) => !/^[<>]/.test(w) && !(w.startsWith("-") && w !== "-"));
        const dest = args[0];
        if (base(first) !== "cd" || args.length > 1 || (dest !== undefined && (dest.includes("$") || dest === "-" || dest.startsWith("~") && !dest.startsWith("~/") && dest !== "~"))) cwd = undefined;
        else if (cwd !== undefined) cwd = dest === undefined || dest === "~" || dest.startsWith("~/") ? join(homedir(), (dest ?? "").slice(1)) : resolve(cwd, dest);
      }
    }
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
      return typeof ti.command === "string" ? checkBash(ti.command, env, { role: input.agent_type, cwd: input.cwd }) : null;
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
  if (hit !== undefined) return `秘密のファイル（${hit}）は読み書きしない。必要な値は、ownerが環境変数で渡す`;
  if (input.tool_name === "Read" || input.tool_name === "Grep" || input.tool_name === "Glob") return null;
  const file = ti.file_path ?? ti.notebook_path;
  return typeof file === "string" ? checkWrite(input.agent_type, file, input.cwd ?? process.cwd(), env) : null;
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
    // path が属する worktree。path がまだ無ければ、存在する一番近い親で聞く。git の外なら null
    const root = (path: string) => {
      let dir = path;
      while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
      try {
        return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: statSync(dir).isDirectory() ? dir : dirname(dir), encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return null;
      }
    };
    const why = decide(input, { branch, root });
    if (why) {
      console.error(`ブロック：${why}`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`ブロック：フックの内部エラーで安全を確かめられない（${e instanceof Error ? e.message : String(e)}）`);
    process.exit(2);
  }
}
