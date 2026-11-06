// RFC 8785（JSON Canonicalization Scheme）による正規化（docs/EVENT_LOG.md §5.1）。
// 数は安全な整数だけに限る。文字列は NFC で、対になっていないサロゲートと U+0000（Postgres の text に保存できない）を含まないこと。
// 黙って直すと、保存した値とハッシュの元がずれるので、条件に合わない値は例外にする。

/** 対になっていないサロゲート（u フラグでは、対になったものは1文字として扱われ一致しない） */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** 正規化できない値。ハッシュの計算そのものの失敗（Web Crypto がないなど）と区別する */
export class CanonicalizeError extends Error {}

/** 入れ子の上限。正規化する値の一番外を0段と数える（イベントなら payload の中身は1段目から。docs/EVENT_LOG.md §5.1） */
const MAX_DEPTH = 64;

export function checkText(s: string, where: string): void {
  if (LONE_SURROGATE.test(s)) throw new CanonicalizeError(`lone surrogate at ${where}`);
  // U+0000 は Postgres の text に保存できず、保存のときに失敗するだけで断った記録が残らない（#110 PR-2d）
  if (s.includes("\u0000")) throw new CanonicalizeError(`NUL character at ${where}`);
  if (s !== s.normalize("NFC")) throw new CanonicalizeError(`not NFC at ${where}`);
}

export function canonicalize(value: unknown): string {
  return write(value, "$", 0);
}

function write(v: unknown, where: string, depth: number): string {
  if (depth > MAX_DEPTH) throw new CanonicalizeError(`nested deeper than ${MAX_DEPTH} at ${where}`);
  if (v === null || v === true || v === false) return String(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new CanonicalizeError(`not a safe integer at ${where}: ${v}`);
    return String(v === 0 ? 0 : v); // -0 は 0 にする（RFC 8785 と同じ）
  }
  if (typeof v === "string") {
    checkText(v, where);
    // RFC 8785 の文字列の書き方は、ECMAScript の JSON.stringify と同じ
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    const parts: string[] = [];
    // map は穴を飛ばすので使わない。穴は undefined と同じく拒否する
    for (let i = 0; i < v.length; i++) {
      const d = Object.getOwnPropertyDescriptor(v, i);
      if (!d) throw new CanonicalizeError(`hole at ${where}[${i}]`);
      if (!("value" in d)) throw new CanonicalizeError(`accessor at ${where}[${i}]`);
      if (d.value === undefined) throw new CanonicalizeError(`undefined at ${where}[${i}]`);
      parts.push(write(d.value, `${where}[${i}]`, depth + 1));
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new CanonicalizeError(`not a plain object at ${where}`);
    // RFC 8785 はキーを UTF-16 の符号単位の順に並べる。Array.prototype.sort の既定の比較と同じ
    const keys = Object.keys(v).sort();
    const parts = keys.map((k) => {
      checkText(k, `${where} key`);
      // getter は計算のたびに値が変わりうるので拒否する
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d || !("value" in d)) throw new CanonicalizeError(`accessor at ${where}.${k}`);
      if (d.value === undefined) throw new CanonicalizeError(`undefined at ${where}.${k} (omit the key instead)`);
      return `${JSON.stringify(k)}:${write(d.value, `${where}.${k}`, depth + 1)}`;
    });
    return `{${parts.join(",")}}`;
  }
  throw new CanonicalizeError(`unsupported value at ${where}: ${typeof v}`);
}
