import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AboutPage from "../../src/app/about/page";
import { Shell } from "../../src/components/Shell";

describe("このサイトについてのページ", () => {
  it("どのページの下にも、このページへのリンクがある", () => {
    const html = renderToStaticMarkup(<Shell>中身</Shell>);
    expect(html).toContain("このサイトについて</a>");
    expect(html.indexOf('href="/about"')).toBeGreaterThan(html.indexOf("</main>"));
  });

  it("主な説明が出る", () => {
    const html = renderToStaticMarkup(<AboutPage />);
    for (const t of ["架空", "実際のお金は動きません", "投資助言ではありません", "板寄せ", "ハッシュ", "取り下げられました"]) {
      expect(html).toContain(t);
    }
  });
});
