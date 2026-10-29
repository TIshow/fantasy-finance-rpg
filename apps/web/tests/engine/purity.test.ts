import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// src/engine は純関数だけ。Next.js、React、Prisma、node:* などを読み込まない（ARCHITECTURE §7）
describe("エンジンの境界", () => {
  it("src/engine は同じディレクトリのモジュールだけを読み込む", () => {
    const dir = fileURLToPath(new URL("../../src/engine/", import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(dir + file, "utf8");
      const imports = [...source.matchAll(/(?:import|export)[^"']*from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const spec of imports) expect(spec, `${file} imports ${spec}`).toMatch(/^\.\//);
    }
  });
});
