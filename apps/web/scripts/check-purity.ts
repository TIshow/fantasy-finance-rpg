// src/ledger・src/events・src/contracts・src/view（と src/holidays/table.ts）が純関数の決まり（AGENTS.md）を守っているか確かめる。
//   node scripts/check-purity.ts   違反があれば一覧を出して終了コード1
// 守る決まり：Next.js・React・DB・node:*・時計・乱数・通信・実行環境に依存しない。importは相対パスで、許した層の中だけ。
// TypeScript の構文木で調べる（コメント・文字列・正規表現リテラルに惑わされない）。解析できないファイルは違反とする。
// グローバルかどうかは、1ファイルだけの Program（lib なし・import は解決しない）で名前を解決して決める。スコープ・型だけの宣言・実体のない namespace も TypeScript が扱う。
// 想定する相手：うっかりの誤用。計算したキーで `.constructor` を取るなど、意図して回避する書き方は構文だけでは止められない。
// 限界：型の情報は使わない。Date の関数は名前で拒み（UTC版を使う。自前のクラスの getDay も拒む）、new Date の引数は文字列に見えるものだけ拒む。
//   `d.toString()`・`${d}`・`String(d)` や、`new Date(n.toString())` のような、型が分からないとローカル時刻になるかを決められない書き方は通る。
//   許したグローバルのメンバーは見ない（`new Error().stack`・`RegExp.$1`・`Math.floor = …` のような環境依存・大域状態・組み込みの書き換え、`crypto.subtle.generateKey` の乱数）。
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type Violation = { file: string; line: number; rule: string };

/** 検査する層と、import してよい場所（apps/web からの相対）。末尾が / ならディレクトリ、なければ拡張子なしのファイルと完全に一致するものだけ */
export const LAYERS: { root: string; allow: string[] }[] = [
  { root: "src/ledger", allow: ["src/ledger/"] },
  { root: "src/events", allow: ["src/events/", "src/ledger/", "src/holidays/table"] },
  { root: "src/holidays/table.ts", allow: [] },
  // 契約の型（D-034）：型だけの層。外側の口の形を定め、実装は置かない
  { root: "src/contracts", allow: ["src/contracts/", "src/events/", "src/ledger/"] },
  // 表示用のデータ：記録を写して整形するだけ。「今」の時刻は画面の側（src/app）で読んで引数で渡す
  { root: "src/view", allow: ["src/view/", "src/events/", "src/ledger/"] },
];

/** 宣言を許さない名前（宣言すると、組み込みの Date などを隠せてしまう） */
const PROTECTED = new Set(["Date", "Math", "crypto", "Function", "eval", "globalThis", "require"]);
/** 宣言なしに使ってよいグローバル。ここにないもの（console・navigator・indexedDB・Reflect・Intl・WeakRef など）は違反。Date・Math・crypto は別に使い方を限る */
const ALLOWED = new Set([
  ...["undefined", "NaN", "Infinity", "arguments", "isFinite", "isNaN", "parseFloat", "parseInt", "structuredClone", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI"],
  ...["Array", "ArrayBuffer", "BigInt", "Boolean", "DataView", "JSON", "Map", "Number", "Object", "Promise", "RegExp", "Set", "String", "Symbol", "WeakMap", "WeakSet"],
  ...["Error", "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "TextDecoder", "TextEncoder"],
  ...["Int8Array", "Int16Array", "Int32Array", "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"],
]);
/** 実行環境の時刻設定・ロケールに依存する関数（UTC版・ロケールに依存しない比較を使う） */
const ENV_MEMBER =
  /^(?:(?:get|set)(?:FullYear|Year|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds)|getTimezoneOffset|toDateString|toTimeString|localeCompare|toLocale\w*)$/;
/** 任意のコードの実行（Function コンストラクタ）に届く道 */
const ESCAPE_MEMBER = /^(?:constructor|__proto__|__lookupGetter__|__lookupSetter__|__defineGetter__|__defineSetter__)$/;

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)
    ? unwrap(e.expression)
    : e;
/** 文字列に見える式。オフセットのない日時文字列はローカル時刻として読まれる */
const looksString = (e: ts.Expression): boolean => {
  const x = unwrap(e);
  if (ts.isStringLiteralLike(x) || ts.isTemplateExpression(x) || ts.isTaggedTemplateExpression(x)) return true;
  if (ts.isBinaryExpression(x)) {
    switch (x.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
      case ts.SyntaxKind.PlusEqualsToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
        return looksString(x.left) || looksString(x.right);
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.CommaToken:
      case ts.SyntaxKind.EqualsToken:
        return looksString(x.right);
    }
    return false;
  }
  if (ts.isConditionalExpression(x)) return looksString(x.whenTrue) || looksString(x.whenFalse);
  return ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "String";
};
/** Date は Date.UTC(...) と new Date(文字列に見えない1つの引数) だけ許す */
function dateUseOk(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.expression === id) return p.name.text === "UTC" && ts.isCallExpression(p.parent) && p.parent.expression === p;
  if (ts.isNewExpression(p) && p.expression === id) return p.arguments?.length === 1 && !ts.isSpreadElement(p.arguments[0]!) && !looksString(p.arguments[0]!);
  return false;
}

/** 型の位置（実行されない）。class の extends とインスタンス化式（Date<never>）は値なので含めない */
function inTypePosition(id: ts.Node): boolean {
  for (let n = id.parent; n; n = n.parent) {
    if (ts.isExpressionWithTypeArguments(n)) return ts.isHeritageClause(n.parent) && (n.parent.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(n.parent.parent));
    if (ts.isTypeNode(n)) return true;
  }
  return false;
}

/** 値としての参照でない識別子（メンバー名、ラベル、再エクスポートの名前など） */
function notReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p)) return p.name === id;
  if (ts.isQualifiedName(p)) return p.right === id;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p) || ts.isMetaProperty(p) || ts.isNamespaceExport(p) || (ts.isImportAttribute(p) && p.name === id)) return true;
  if (ts.isImportSpecifier(p) || ts.isBindingElement(p)) return p.propertyName === id;
  if (ts.isExportSpecifier(p)) return !!p.parent.parent.moduleSpecifier || p.isTypeOnly || p.parent.parent.isTypeOnly || (p.propertyName ? p.name === id : false);
  return (
    (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) ||
      ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) &&
    p.name === id
  );
}

/** 型専用の import の宣言（値としては存在しない。値の位置で使うと、実行時は同名のグローバルに届く） */
function typeOnlyImport(d: ts.Declaration): boolean {
  if (ts.isImportSpecifier(d)) return d.isTypeOnly || d.parent.parent.isTypeOnly;
  if (ts.isImportClause(d)) return d.isTypeOnly;
  if (ts.isNamespaceImport(d)) return d.parent.isTypeOnly;
  if (ts.isImportEqualsDeclaration(d)) return d.isTypeOnly;
  return false;
}
/** import が作る名前そのもの（import { x }・import x・import * as x・import x = ...） */
const isImportBinding = (id: ts.Identifier): boolean => {
  const p = id.parent;
  return (ts.isImportSpecifier(p) && p.name === id) || (ts.isImportClause(p) && p.name === id) || (ts.isNamespaceImport(p) && p.name === id) || (ts.isImportEqualsDeclaration(p) && p.name === id);
};
/** オブジェクト・配列リテラルが分割代入の代入先か（({ a: x } = y)・for ({ a: x } of ys)・入れ子） */
function isAssignmentTarget(n: ts.Node): boolean {
  const p = n.parent;
  if (ts.isParenthesizedExpression(p) || ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p)) return isAssignmentTarget(p);
  if (ts.isPropertyAssignment(p) && p.initializer === n) return isAssignmentTarget(p.parent);
  if (ts.isShorthandPropertyAssignment(p) && p.objectAssignmentInitializer === n) return false;
  if (ts.isBinaryExpression(p)) return p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === n;
  return (ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === n;
}
/** プロパティ名・キーが文字列として分かるなら、その文字列 */
const keyOf = (k: ts.Node): string | undefined =>
  ts.isIdentifier(k) || ts.isStringLiteralLike(k) ? k.text : ts.isComputedPropertyName(k) && ts.isStringLiteralLike(k.expression) ? k.expression.text : undefined;

/** 1ファイルの違反を返す。file は apps/web からの相対（例：src/ledger/ledger.ts） */
export function checkSource(file: string, text: string): Violation[] {
  const layer = LAYERS.find((l) => file === l.root || file.startsWith(`${l.root}/`));
  if (!layer) return [];
  if (!file.endsWith(".ts") || file.endsWith(".d.ts")) return [{ file, line: 1, rule: "対象の層に置けるのは .ts だけ（.tsx・.d.ts・.js などは置けない）" }];
  const fileName = `/${file}`;
  let program: ts.Program;
  let sf: ts.SourceFile;
  let syntax: readonly ts.Diagnostic[];
  try {
    // 1ファイルだけの Program。lib は無く、import も解決しない（名前がこのファイル内で宣言されているかだけを TypeScript に決めさせる）
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const host: ts.CompilerHost = {
      getSourceFile: (n) => (n === fileName ? source : undefined),
      fileExists: (n) => n === fileName,
      readFile: (n) => (n === fileName ? text : undefined),
      getDefaultLibFileName: () => "/lib.d.ts",
      writeFile: () => {},
      getCurrentDirectory: () => "/",
      getDirectories: () => [],
      getCanonicalFileName: (n) => n,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
    };
    program = ts.createProgram({ rootNames: [fileName], options: { noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.ES2022 }, host });
    sf = program.getSourceFile(fileName)!;
    syntax = program.getSyntacticDiagnostics(sf);
  } catch (e) {
    return [{ file, line: 1, rule: `解析できない（${e instanceof Error ? e.message : String(e)}）` }];
  }
  if (syntax.length > 0)
    return syntax.map((d) => ({
      file,
      line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 1,
      rule: `構文エラーで解析できない（${ts.flattenDiagnosticMessageText(d.messageText, " ")}）`,
    }));

  const checker = program.getTypeChecker();
  const found: Violation[] = [];
  const lineAt = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const add = (node: ts.Node, rule: string) => found.push({ file, line: lineAt(node.getStart(sf)), rule });
  for (const r of [...sf.referencedFiles, ...sf.typeReferenceDirectives, ...sf.libReferenceDirectives]) found.push({ file, line: lineAt(r.pos), rule: "/// <reference> は使えない" });

  /** この識別子が、このファイルの中で宣言された名前を指すか（スコープは TypeScript が解決する。lib の名前や undefined・globalThis は宣言なし。型専用の import は値ではないので宣言と見ない） */
  const isLocal = (id: ts.Identifier): boolean => {
    const p = id.parent;
    const sym = ts.isShorthandPropertyAssignment(p) && p.name === id ? checker.getShorthandAssignmentValueSymbol(p) : ts.isExportSpecifier(p) ? checker.getExportSpecifierLocalTargetSymbol(p) : checker.getSymbolAtLocation(id);
    return !!sym?.declarations?.some((d) => d.getSourceFile() === sf && !typeOnlyImport(d));
  };
  /** 実行環境依存・Function への道になるメンバー名か */
  const checkKey = (node: ts.Node, key: string) => {
    if (ENV_MEMBER.test(key)) add(node, `実行環境の時刻設定・ロケールに依存する関数（${key}）`);
    else if (ESCAPE_MEMBER.test(key)) add(node, `${key} は使えない（Function コンストラクタに届く）`);
  };

  const checkSpec = (node: ts.Node, spec: string) => {
    if (!spec.startsWith(".")) return add(node, `相対パス以外の import（${spec}）`);
    const target = posix.join(posix.dirname(file), spec).replace(/\.ts$/, "");
    if (!layer.allow.some((a) => (a.endsWith("/") ? target.startsWith(a) : target === a))) add(node, `許していない層・ファイルの import（${target}）`);
  };

  const visit = (node: ts.Node): void => {
    if (!ts.isPropertyDeclaration(node) && ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) add(node, "declare は使えない（宣言なしに名前を作れてしまう）");
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) checkSpec(node, node.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) checkSpec(node, node.moduleReference.expression.text);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) checkSpec(node, node.argument.literal.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, "動的 import");
    else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) add(node, "import.meta は使えない");
    else if (ts.isPropertyAccessExpression(node)) checkKey(node, node.name.text);
    else if (ts.isElementAccessExpression(node)) {
      if (ts.isStringLiteralLike(node.argumentExpression)) checkKey(node, node.argumentExpression.text);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = keyOf(node.propertyName ?? node.name);
      if (key !== undefined) checkKey(node, key);
    } else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && isAssignmentTarget(node.parent)) {
      const key = keyOf(node.name);
      if (key !== undefined) checkKey(node, key);
    } else if (ts.isIdentifier(node) && !notReference(node) && !inTypePosition(node)) {
      const name = node.text;
      const p = node.parent;
      const member = ts.isPropertyAccessExpression(p) && p.expression === node ? p.name.text : undefined;
      if (isImportBinding(node)) {
        if (PROTECTED.has(name)) add(node, `組み込みの名前は宣言できない（${name}）`);
      } else if (isLocal(node)) {
        if (PROTECTED.has(name)) add(node, `組み込みの名前は宣言できない（${name}）`);
      } else if (name === "Date") {
        if (!dateUseOk(node)) add(node, "時計・環境依存の Date の使い方（許すのは Date.UTC(...) と new Date(文字列に見えない1つの引数)）");
      } else if (name === "Math") {
        if (member === undefined || member === "random") add(node, "Math は Math.<関数> の形だけ（Math.random は乱数）");
      } else if (name === "crypto") {
        if (member !== "subtle") add(node, "crypto は crypto.subtle だけ（乱数は引数で受け取る）");
      } else if (!ALLOWED.has(name)) add(node, `許していないグローバル（${name}）。時計・乱数・通信・実行環境は引数で受け取る`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found.sort((a, b) => a.line - b.line);
}

function listFiles(abs: string): string[] {
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs).flatMap((name) => listFiles(join(abs, name)));
}

/** apps/web の下の対象ファイルをすべて検査する */
export function checkTree(webRoot: string): Violation[] {
  const files = LAYERS.flatMap((l) => listFiles(join(webRoot, l.root))).map((f) => relative(webRoot, f).split(sep).join("/"));
  return files.flatMap((f) => checkSource(f, readFileSync(join(webRoot, f), "utf8")));
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(here)) {
  const violations = checkTree(join(dirname(here), ".."));
  for (const v of violations) console.error(`${v.file}:${v.line}: ${v.rule}`);
  if (violations.length > 0) {
    console.error(`\n純関数の決まり（AGENTS.md）に反する箇所が${violations.length}件ある`);
    process.exit(1);
  }
  console.log("純関数の検査：違反なし");
}
