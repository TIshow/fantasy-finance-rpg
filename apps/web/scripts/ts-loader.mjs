// src/ の TypeScript を node で直接動かすための読み込みの補助（依存を足さずに、毎日の実行のコマンドを動かすため）。
//   node --experimental-transform-types --import ./scripts/ts-loader.mjs scripts/daily.ts
// src/ は拡張子なしの import と、import 属性なしの JSON の import を使う（Next.js・Vite 向けの書き方）ので、node の既定では読めない。
// そこで、相対パスの import に .ts・/index.ts を補い、JSON を属性なしでも読めるようにする。
import { existsSync, readFileSync, statSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register(new URL(import.meta.url));

const isFile = (url) => {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
};

export async function resolve(specifier, context, next) {
  if (!/^\.\.?\//.test(specifier) || !context.parentURL?.startsWith("file:")) return next(specifier, context);
  const base = new URL(specifier, context.parentURL);
  for (const suffix of ["", ".ts", "/index.ts"]) {
    const url = new URL(base.href + suffix);
    if (isFile(url)) return next(url.href, context);
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith("file:") && url.endsWith(".json") && existsSync(fileURLToPath(url))) {
    return { format: "json", source: readFileSync(fileURLToPath(url), "utf8"), shortCircuit: true };
  }
  return next(url, context);
}
