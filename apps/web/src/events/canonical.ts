// RFC 8785（JSON Canonicalization Scheme）による正規化（docs/EVENT_LOG.md §5.1）。
// 数は安全な整数だけに限る。文字列は NFC で、対になっていないサロゲートを含まないこと。
// 黙って直すと、保存した値とハッシュの元がずれるので、条件に合わない値は例外にする。

/** 対になっていないサロゲート（u フラグでは、対になったものは1文字として扱われ一致しない） */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

export function checkText(s: string, where: string): void {
  if (LONE_SURROGATE.test(s)) throw new Error(`lone surrogate at ${where}`);
  if (s !== s.normalize("NFC")) throw new Error(`not NFC at ${where}`);
}

export function canonicalize(value: unknown): string {
  return write(value, "$");
}

function write(v: unknown, where: string): string {
  if (v === null || v === true || v === false) return String(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`not a safe integer at ${where}: ${v}`);
    return String(v === 0 ? 0 : v); // -0 は 0 にする（RFC 8785 と同じ）
  }
  if (typeof v === "string") {
    checkText(v, where);
    // RFC 8785 の文字列の書き方は、ECMAScript の JSON.stringify と同じ
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x, i) => write(x, `${where}[${i}]`)).join(",")}]`;
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error(`not a plain object at ${where}`);
    // RFC 8785 はキーを UTF-16 の符号単位の順に並べる。Array.prototype.sort の既定の比較と同じ
    const keys = Object.keys(v).sort();
    const parts = keys.map((k) => {
      checkText(k, `${where} key`);
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined) throw new Error(`undefined at ${where}.${k} (omit the key instead)`);
      return `${JSON.stringify(k)}:${write(x, `${where}.${k}`)}`;
    });
    return `{${parts.join(",")}}`;
  }
  throw new Error(`unsupported value at ${where}: ${typeof v}`);
}
