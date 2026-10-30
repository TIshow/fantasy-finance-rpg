import { execFileSync } from "node:child_process";
import { expect, test, type Browser, type Page } from "@playwright/test";

// 参加者6・運営・会場の8コンテキストで5ラウンドを完走する（MEETING_MVP_SPEC §8）。
// 参加者のうち3人はスマートフォン相当（360px幅）。

interface Created {
  joinCode: string;
  participant: string;
  screen: string;
  host: string;
}

function createMatch(base: string): Created {
  const out = execFileSync("npx", ["tsx", "--env-file=.env", "scripts/create-match.ts", "--e2e", "--json", "--base", base], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").at(-1)!) as Created;
}

async function newPage(browser: Browser, mobile: boolean): Promise<Page> {
  const context = await browser.newContext(
    mobile ? { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 900 } },
  );
  return context.newPage();
}

/** 公開の瞬間（直前のラウンドの注文の内訳が現れた時刻）を、ページの中で記録する */
async function watchReveal(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __revealAt?: number };
    const check = () => {
      if (!w.__revealAt && document.querySelector('[data-testid="flow"]')) w.__revealAt = Date.now();
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
    check();
  });
}

test("6商会・運営・会場が5ラウンドを完走し、公開がそろう", async ({ browser, baseURL }) => {
  const m = createMatch(baseURL!);
  const players = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => newPage(browser, i % 2 === 1)));
  const host = await newPage(browser, false);
  const screen = await newPage(browser, false);

  for (const [i, page] of players.entries()) {
    await page.goto(m.participant);
    await page.getByTestId("join-nickname").fill(`E2E商会${i + 1}`);
    await page.getByTestId("join-submit").click();
    await expect(page.getByTestId("waiting")).toBeVisible();
  }
  await screen.goto(m.screen);
  await host.goto(m.host);
  await expect(host.getByTestId("team-row")).toHaveCount(6);
  host.on("dialog", (d) => d.accept());
  await host.getByTestId("host-start").click();

  // 第1ラウンド：全員がドラゴンを5口買う
  for (const page of players) {
    await expect(page.getByTestId("phase-label")).toHaveText("注文受付中", { timeout: 20_000 });
  }
  for (const [i, page] of players.entries()) {
    await page.getByTestId("guild-dragon").click();
    await page.getByTestId("qty-5").click();
    const buy = page.getByTestId("order-buy");
    if (i % 2 === 1) {
      // 360px幅でも、注文ボタンが画面に収まって見える
      const box = (await buy.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(360);
      expect(box.y + box.height).toBeLessThanOrEqual(740);
    }
    await buy.click();
    await expect(page.getByTestId("order-status-dragon")).toContainText("買い 5口");
  }
  await Promise.all([...players, screen].map(watchReveal));

  // 公開：全員に同じ結果が、ほぼ同時に出る
  for (const page of players) {
    await expect(page.getByTestId("fill-dragon")).toContainText("5／5口", { timeout: 30_000 });
  }
  await expect(screen.getByTestId("flow")).toBeVisible();
  const times = await Promise.all([...players, screen].map((p) => p.evaluate(() => (window as unknown as { __revealAt?: number }).__revealAt ?? 0)));
  expect(times.every((t) => t > 0)).toBe(true);
  const spread = Math.max(...times) - Math.min(...times);
  console.log(`公開時刻の差：${spread}ms`);
  expect(spread).toBeLessThan(1000);
  const prices = await Promise.all(players.map((p) => p.getByTestId("price-dragon").textContent()));
  expect(new Set(prices).size).toBe(1);

  // 再読み込みしても、商会と保有が戻る
  await players[0]!.reload();
  await expect(players[0]!.getByTestId("nickname")).toHaveText("E2E商会1");
  await expect(players[0]!.getByTestId("guild-dragon")).toContainText("保有 5口");

  // 決算まで進む（以降は注文しない）
  for (const page of players) {
    await expect(page.getByTestId("result")).toBeVisible({ timeout: 150_000 });
    await expect(page.getByTestId("result-assets")).toContainText("G");
    await expect(page.getByTestId("replay")).toBeVisible();
  }
  await expect(screen.getByTestId("screen-winner")).toContainText("ドラゴン輸送ギルド");
  await expect(screen.getByTestId("ranking")).toBeVisible();
});
