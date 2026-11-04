import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkSource, checkTree } from "../../scripts/check-purity";

const check = (code: string, file = "src/ledger/x.ts") => checkSource(file, code).map((v) => v.rule);
const clean = (code: string, file?: string) => expect(check(code, file)).toEqual([]);
/** 違反が1件以上あり、すべてが狙った規則（part を含む説明）によるもの。別の理由（未宣言の変数・構文エラー）でたまたま通るのを防ぐ */
const badBy = (code: string, part: string, file?: string) => {
  const rules = check(code, file);
  expect(rules.length).toBeGreaterThan(0);
  expect(rules.filter((r) => !r.includes(part))).toEqual([]);
  return rules;
};
/** 使う変数を宣言しておく前置き（宣言のない名前は別の違反になるため） */
const PRE = "const a: any = 0, b: any = 0, c: any = 0, d: any = 0, f: any = 0, s: any = 0, u: any = 0, xs: any = 0;\n";
/** 式を1つ書いた、自己完結した最小のファイル */
const expr = (e: string) => `${PRE}export const out = ${e};`;
const prog = (code: string) => PRE + code;

describe("時計・乱数・環境依存を拒む（書き方を変えても素通りさせない）", () => {
  it.each([
    "Date.now()", "new Date()", "new Date", "Date()", "Date?.now()", "Date['now']()", "new (Date)()", "new Date(...xs)", "new Date(2026, 0, 1)", "Date.parse(s)",
    "(() => { const D = Date; return D.now(); })()", "[Date].map((x) => x)", "({ Date })", "f(Date)", "Date<never>", "Date.UTC", "new Date(1, 2)",
  ])("Date の %s を拒む", (code) => {
    badBy(expr(code), "Date の使い方");
  });

  it.each([
    "new Date('2026-01-01T00:00')", "new Date(`2026-01-01`)", "new Date(('2026-01-01'))", "new Date('2026-01-01' + 'T00:00')",
    "new Date(c ? 'a' : 'b')", "new Date(String(1))", "new Date(String.raw`2026-01-01`)", "new Date('2026-01-01' as unknown as number)", "new Date(<any>'2026')",
    "new Date(s ?? '2026-01-01')", "new Date(c || '2026-01-01')", "new Date((0, '2026'))", "new Date(s += '2026')", "new Date(c && '2026')",
  ])("new Date に文字列に見える引数を渡す %s を拒む", (code) => {
    badBy(expr(code), "Date の使い方");
  });

  it.each(["Math.random()", "Math['random']()", "Object.assign({}, Math)", "(() => { const { random } = Math; return random(); })()", "f(Math)", "Math?.random()"])(
    "Math の %s を拒む",
    (code) => {
      badBy(expr(code), "Math は");
    },
  );

  it.each(["crypto.randomUUID()", "crypto.getRandomValues(xs)", "crypto['subtle']", "f(crypto)"])("crypto の %s を拒む", (code) => {
    badBy(expr(code), "crypto は");
  });

  it.each([
    "d.getFullYear()", "d['getHours']()", "d.toLocaleDateString()", "xs.sort((x, y) => x.localeCompare(y))", "d.getYear()", "d.getDay()", "d.getTimezoneOffset()",
    "(() => { const { getDay } = d; return getDay; })()", "(() => { const { 'getHours': g } = d; return g; })()", "(() => { const { ['getMonth']: g } = d; return g; })()",
    "(() => { let g: any; ({ getHours: g } = d); return g; })()",
  ])("実行環境に依存する関数 %s を拒む", (code) => {
    badBy(expr(code), "実行環境の時刻設定");
  });

  it.each([
    "performance.now()", "process.env.X", "globalThis.Date", "self.crypto", "new Intl.DateTimeFormat('ja-JP').format(xs)", "setTimeout(f, 1)", "setTimeout<[]>(f, 1)",
    "fetch(u)", "eval('1')", "new Function('return 1')", "Reflect.construct(f, [])",
  ])("許していないグローバル %s を拒む", (code) => {
    badBy(expr(code), "許していないグローバル");
  });

  it("import.meta は拒む", () => {
    badBy(expr("import.meta.url"), "import.meta");
  });

  it("許す形：new Date(数値)、Date.UTC、Math.floorなど、crypto.subtle、型としてのDate", () => {
    clean("const t = 1; const d: Date = new Date(t); const u = Date.UTC(2026, 0, 1); d.getUTCDay(); d.toISOString(); Math.floor(Math.max(1, 2));");
    clean("export const h = (b: Uint8Array) => crypto.subtle.digest('SHA-256', b);");
    clean("const o = { process: 1, fetch: 2 }; o.process; o.fetch;");
    clean("export const e = (s: string) => encodeURIComponent(s) + decodeURI(s);");
    clean("export function F() { return new.target; }");
  });

  it("違反の行番号を返す", () => {
    expect(checkSource("src/ledger/x.ts", "const a = 1;\nconst b = Date.now();\n")[0]?.line).toBe(2);
  });

  it("対象の層の外は検査しない", () => clean("const a = Date.now();", "src/app/page.tsx"));
});

describe("許したグローバルだけ使える（それ以外は違反）", () => {
  it.each([
    'navigator.sendBeacon("u", "d")', "new Image()", "indexedDB.open('x')", "caches.open('x')", "new Worker('x')", "new BroadcastChannel('x')",
    "navigator.language", "location.href", "console.log('x')", "new WeakRef({})", "new FinalizationRegistry(() => {})", "Atomics.wait(xs, 0, 0, 1)",
    "WebAssembly.instantiate(xs)", "Temporal.Now.instant()", "new Proxy({}, {})", "Reflect.get(xs, 'b')", "require('fs')", "module.exports",
  ])("%s を拒む", (code) => {
    badBy(expr(code), "許していないグローバル");
  });

  it("宣言した名前と許したグローバルは使える（window などの変数名も、宣言すれば使える）", () => {
    clean("const window = 5; export const a = window + 1;");
    clean("export function f(navigator: number) { return navigator + 1; }");
    clean("export const a = [new Map<string, number>(), new Set<number>(), JSON.stringify(1), Number(1), String(2), Symbol('s'), new Uint8Array(1), Object.keys({})];");
    clean("export const f = <T>(x: T, ...r: T[]) => { outer: for (;;) { break outer; } return [x, r, undefined, NaN]; };");
    clean("const a = 1; export { a as b };");
    clean("enum E { A, B = A } export const x = E.B;");
    clean("export class C { declare x: number; y = 1; }");
    clean('export * as ns from "./y";');
  });

  it("別のスコープの宣言や、型だけの宣言は、同名のグローバルを隠さない（その名前の使用は1件だけ違反）", () => {
    for (const [decl, name] of [
      ["export const f = (event: number) => event;", "event"],
      ["export const f = () => { try { g(); } catch (history) { g(history); } };", "history"],
      ["export const f = function performance() { return 1; };", "performance"],
      ["type location = number;", "location"],
      ["interface history { x: number }", "history"],
      ["export const k = <event,>(x: event) => x;", "event"],
      ["namespace performance {}", "performance"],
      ["export function f(event: number) { function inner() { return event; } return inner; }", "event"],
    ] as const) {
      const rules = badBy(`declare_g;\n${decl}\nexport const use = () => ${name};`.replace("declare_g;\n", "const g: any = 0;\n"), `許していないグローバル（${name}）`);
      expect(rules).toHaveLength(1);
    }
  });

  it("同じスコープの宣言は使える（引数・変数・関数・class・import・destructuring・for）", () => {
    clean("export const f = (event: number) => event + 1;");
    clean("export function g() { const history = 1; { const location = history; return location; } }");
    clean("export function h(xs: number[]) { for (const event of xs) { void event; } for (let i = 0; i < 1; i++) { void i; } const [p, q] = xs; const { length: n } = xs; return p + q + n; }");
    clean("class Foo { static make() { return new Foo(); } } export const mk = () => Foo.make();");
    clean('import { x } from "../ledger/y"; import * as ns from "../ledger/z"; import w from "../ledger/w"; export const v = [x, ns, w];', "src/events/x.ts");
  });

  it("型専用の import は値ではない：値として使うと同名のグローバルに届くので拒む。型の位置と export type は使える", () => {
    for (const code of [
      'import type { fetch } from "./types"; export const a = fetch("u");',
      'import { type performance } from "./types"; export const a = performance.now();',
      'import type { Event } from "./types"; export const a = new Event("x");',
      'import type * as fetch from "./types"; export const a = fetch("u");',
      'import type console from "./types"; export const a = console.log("x");',
    ])
      badBy(code, "許していないグローバル", "src/events/x.ts");
    clean('import type { T } from "./types"; import { type U, v } from "./types"; export type { T }; export const a: T | U = v;', "src/events/x.ts");
  });

  it("import の名前に組み込みの名前は使えない", () => {
    badBy('import type { Date } from "./types"; export type D = Date;', "組み込みの名前は宣言できない", "src/events/x.ts");
  });

  it("import 属性のキーはグローバルの参照ではない（層の中の x.json は checkTree が .ts 以外として止める）", () => {
    clean('import h from "./x.json" with { type: "json" }; export const o = h;', "src/events/x.ts");
  });

  it("型の位置は見ない（実行されない）。class の extends は値なので見る", () => {
    clean("export type M = keyof typeof Math; export type T = typeof Date; export abstract class C implements Date {} export const f = <X>(x: X) => x as Date;");
    clean("const g = <D,>(x: D) => x; export const a = g<Date>(1);");
    badBy("export class C extends Date {}", "Date の使い方");
    badBy("declare const navigator: any; export const a = navigator;", "declare は使えない");
  });

  it("組み込みの名前は宣言して隠せない", () => {
    badBy("const Date = { now: () => 1 }; export const a = Date.now();", "組み込みの名前は宣言できない");
    badBy("function Math() {} export const a = 1;", "組み込みの名前は宣言できない");
    badBy("export const f = (crypto: any) => crypto.randomUUID();", "組み込みの名前は宣言できない");
    badBy('import { x as Date } from "./y"; export const a = Date;', "組み込みの名前は宣言できない");
    badBy("type Date = number; export const a = 1;", "組み込みの名前は宣言できない");
  });
});

describe("Function コンストラクタに届く道を拒む", () => {
  it.each([
    "(() => {}).constructor('return 1')()", "(async () => {}).constructor", "({} as any).constructor.constructor('return 1')",
    "(() => {})['constructor']('x')", "Object.getPrototypeOf(f).constructor", "a.__proto__", "a.__lookupGetter__('x')", "a.__defineSetter__('x', f)",
    "(() => { const { constructor: F } = a; return F; })()", "(() => { const { 'constructor': F } = a; return F; })()", "(() => { const { constructor } = a; return constructor; })()",
    "(() => { const { __proto__: p } = a; return p; })()", "(() => { const { ['constructor']: F } = a; return F; })()",
    "(() => { let F: any; ({ constructor: F } = a); return F; })()",
    "(() => { let F: any; for ({ constructor: F } of [a]) { void F; } return 1; })()", "(() => { let F: any; [{ ['constructor']: F }] = [a]; return F; })()",
  ])("%s を拒む", (code) => {
    badBy(expr(code), "Function コンストラクタに届く");
  });
});

describe("コメント・文字列・正規表現・テンプレートで判定がずれない", () => {
  it("コメントと文字列の中は見ない", () => clean('// Date.now() は使わない\n/* Math.random */\nconst s = "fetch(x) process"; const t = `Date.now()`;'));
  it("${} の中は見る", () => {
    badBy(expr("`a ${Date.now()} b`"), "Date の使い方");
  });
  it.each([["/\\/*/"], ['/"/'], ["/`/"], ["/a\\//"]])("正規表現リテラル %s のあとの違反を見落とさない", (re) => {
    expect(badBy(`const r = ${re};\nconst t = Date.now();`, "Date の使い方")).toHaveLength(1);
  });
  it("解析できないファイルは違反（閉じていないコメント・構文エラー）", () => {
    expect(check("const a = 1; /* 閉じていない")[0]).toContain("構文エラー");
    expect(check("const a = ;")[0]).toContain("構文エラー");
  });
});

describe("import", () => {
  it.each([
    'import { a } from "node:fs"; export const o = a;', "import React from 'react'; export const o = React;", 'export * from "next/server";', 'import "left-pad";',
    'import { "readFileSync" as r } from "node:fs"; export const o = r;', 'import fs = require("fs"); export const o = fs;', 'type T = import("node:fs").Stats;',
  ])("相対パス以外の import %s を拒む", (code) => {
    badBy(code, "相対パス以外の import");
  });

  it("動的 import は拒む", () => {
    badBy("export const m = await import('./x');", "動的 import");
  });

  it("/// <reference> は拒む", () => {
    badBy('/// <reference types="node" />\nexport const a = 1;', "<reference>");
  });

  it("許した層だけ import できる（import type も同じ）", () => {
    clean('import { a } from "../ledger/ledger"; import type { T } from "./types"; export const b = a as T;', "src/events/x.ts");
    clean('import { t } from "../holidays/table"; import { u } from "../holidays/table.ts"; export const v = [t, u];', "src/events/x.ts");
    badBy('import { h } from "../holidays/index"; export const o = h;', "許していない層・ファイルの import", "src/events/x.ts");
    badBy('import type { T } from "../events/append"; export type U = T;', "許していない層・ファイルの import", "src/ledger/x.ts");
    badBy('import { a } from "../../tests/helper"; export const o = a;', "許していない層・ファイルの import", "src/ledger/x.ts");
    badBy('import {\n  a,\n  b,\n} from "../store/db"; export const o = [a, b];', "許していない層・ファイルの import", "src/events/x.ts");
  });

  it("単一ファイルの許可は、そのファイルだけ（table/ の下・table.tsx・末尾の / は拒む）", () => {
    for (const spec of ["../holidays/table/", "../holidays/table/index", "../holidays/table.tsx", "../holidays/table.js", "../holidays/tableX"])
      badBy(`import { a } from "${spec}"; export const b = a;`, "許していない層・ファイルの import", "src/events/x.ts");
  });
});

describe("ファイルの種類と実際のソース", () => {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  it("層には .ts だけ置ける（.tsx・.d.ts・.mjs・.js は違反）", () => {
    for (const f of ["src/ledger/x.tsx", "src/ledger/x.d.ts", "src/ledger/x.mjs", "src/events/x.js"])
      expect(checkSource(f, "export const a = 1;")).toEqual([{ file: f, line: 1, rule: "対象の層に置けるのは .ts だけ（.tsx・.d.ts・.js などは置けない）" }]);
  });

  it("src/ledger・src/events・src/contracts・src/view・src/holidays/table.ts に違反がない", () => expect(checkTree(webRoot)).toEqual([]));

  it("src/contracts と src/view も対象：時計・乱数・許していない層の import を拒む", () => {
    for (const f of ["src/contracts/x.ts", "src/view/x.ts"]) {
      expect(checkSource(f, "export const a = Date.now();").length).toBeGreaterThan(0);
      expect(checkSource(f, "export const a = Math.random();").length).toBeGreaterThan(0);
      expect(checkSource(f, 'import { x } from "../store/x";\nexport const a = x;').length).toBeGreaterThan(0);
      expect(checkSource(f, 'import type { LogEvent } from "../events/types";\nimport { LOT } from "../ledger/types";\nexport const a = LOT;')).toEqual([]);
    }
    expect(checkSource("src/view/x.ts", 'import type { Clock } from "../contracts";\nexport const a = 1;').length).toBeGreaterThan(0);
  });

  it("checkTree は層の中の .ts 以外のファイルも見つける", () => {
    const root = mkdtempSync(join(tmpdir(), "purity-"));
    try {
      for (const f of ["src/ledger/a.ts", "src/ledger/b.d.ts", "src/events/c.ts", "src/contracts/d.ts", "src/view/e.ts", "src/holidays/table.ts"]) {
        mkdirSync(join(root, dirname(f)), { recursive: true });
        writeFileSync(join(root, f), "export const a = 1;\n");
      }
      expect(checkTree(root).map((v) => v.file)).toEqual(["src/ledger/b.d.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
