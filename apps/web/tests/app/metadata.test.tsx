// サイトの題名と、検索エンジンへの掲載（検索を止める設定が無いこと）を確かめる。
import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => {
  const f = () => ({ variable: "" });
  return { Dela_Gothic_One: f, Noto_Sans_JP: f, Share_Tech_Mono: f };
});

import { metadata } from "../../src/app/layout";

describe("サイト全体の metadata", () => {
  it("題名は「AI投資家アリーナ」で、内部確認用の文言を含まない", () => {
    expect(metadata.title).toBe("AI投資家アリーナ");
    expect(JSON.stringify(metadata)).not.toContain("内部確認用");
  });

  it("robots で検索を止めていない", () => {
    expect((metadata as Record<string, unknown>).robots).toBeUndefined();
  });
});
