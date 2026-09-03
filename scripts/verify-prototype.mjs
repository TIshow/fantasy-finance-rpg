import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const prototypeUrl = new URL("../prototype/guild-market-demo.html", import.meta.url);
const html = await readFile(prototypeUrl, "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

assert.ok(scriptMatch, "inline script must exist");
assert.equal((html.match(/<script/g) || []).length, 1, "prototype must contain one inline script");
assert.equal((html.match(/<style/g) || []).length, 1, "prototype must contain one inline stylesheet");
assert.equal((html.match(/https?:\/\//g) || []).length, 0, "prototype must not reference external URLs");
assert.match(html, /default-src 'none'/, "CSP must default to denying external resources");
assert.match(html, /connect-src 'none'/, "CSP must deny runtime network connections");
assert.match(html, /<meta name="viewport"/, "mobile viewport metadata must exist");
assert.match(html, /@media \(max-width: 620px\)/, "smartphone layout breakpoint must exist");
assert.match(html, /min-height:\s*44px/, "primary controls must provide a 44px touch target");

const testHook = `
      window.__GUILD_MARKET_TEST__ = {
        getState: () => state,
        getStage: () => stage().id,
        getDisplayPrices: () => displayPrices(),
        getForecast: () => calculateForecastSnapshot(),
        getQuote: (guildId, quantity) => quote(guildId, quantity),
        advanceStage,
        runNpcSequence,
        chooseInvestigation,
        saveTicketForLater,
        expireTicket,
        trade,
        render,
        resetDemo,
        saveState,
        selectGuild: (guildId) => { state.selectedGuild = guildId; },
        setQuantity: (quantity) => { state.selectedQuantity = quantity; },
        viewBothInfoTabs: () => {
          state.viewedInfo.scout = true;
          state.viewedInfo.analyst = true;
        }
      };
`;

const originalStartup = "      onEnterStage();\n      render();";
assert.ok(scriptMatch[1].includes(originalStartup), "prototype startup marker must remain recognizable");
const instrumentedScript = scriptMatch[1].replace(originalStartup, testHook);
new Function(instrumentedScript);

function createStorage(seed) {
  const values = new Map(seed || []);
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

function loadPrototype(seed) {
  const storage = createStorage(seed);
  const app = { innerHTML: "" };
  const liveRegion = { textContent: "" };
  const document = {
    getElementById(id) {
      if (id === "app") return app;
      if (id === "live-region") return liveRegion;
      return null;
    },
    addEventListener() {}
  };
  const window = {
    addEventListener() {},
    clearTimeout,
    confirm: () => true,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame() {},
    scrollTo() {},
    setTimeout
  };

  new Function("document", "window", "localStorage", instrumentedScript)(document, window, storage);
  return { api: window.__GUILD_MARKET_TEST__, app, storage };
}

function assertPriceInvariant(api, label) {
  const displayPrices = api.getDisplayPrices();
  assert.equal(
    Object.values(displayPrices).reduce((sum, price) => sum + price, 0),
    100,
    `${label}: displayed prices must add up to 100G`
  );
}

const mainRun = loadPrototype();
const { api } = mainRun;
api.render();
assert.equal(api.getStage(), "WELCOME");
assert.deepEqual(api.getDisplayPrices(), { airship: 28, alchemy: 34, dragon: 23, academy: 15 });
assert.match(mainRun.app.innerHTML, /GUILD MARKET/);

api.advanceStage();
api.advanceStage();
assert.equal(api.getStage(), "INITIAL_MARKET");
api.selectGuild("airship");
api.setQuantity(5);
api.trade("buy");
assert.equal(api.getState().holdings.airship.quantity, 5);
assert.equal(api.getState().cash, 860);
assert.equal(api.getQuote("airship", 5), api.getDisplayPrices().airship * 5);
assertPriceInvariant(api, "initial player trade");
api.advanceStage();
assert.equal(api.getState().snapshots.initial.favoriteId, "airship");

api.advanceStage();
assert.equal(api.getStage(), "POPULARITY_MOVE");
await api.runNpcSequence();
assert.equal(api.getDisplayPrices().dragon, 30);
assertPriceInvariant(api, "popularity move");
api.advanceStage();
api.viewBothInfoTabs();
api.advanceStage();
api.advanceStage();
assert.equal(api.getStage(), "RUMOR_CRASH");
await api.runNpcSequence();
assert.equal(api.getDisplayPrices().dragon, 12);
assertPriceInvariant(api, "rumor crash");

api.advanceStage();
api.saveTicketForLater();
assert.equal(api.getState().ticket.available, true);
api.advanceStage();
api.advanceStage();
assert.equal(api.getStage(), "AI_PUBLIC_REPORT");
await api.runNpcSequence();
assert.equal(api.getDisplayPrices().dragon, 9);
assertPriceInvariant(api, "AI report");

api.advanceStage();
api.chooseInvestigation("official");
assert.equal(api.getState().investigationHistory.length, 1);
assert.equal(api.getState().ticket.usedAt, "window2");
api.chooseInvestigation("ai");
assert.equal(api.getState().investigationHistory.length, 1, "investigation ticket must be single-use");
api.advanceStage();
api.advanceStage();
assert.equal(api.getStage(), "OFFICIAL_EVIDENCE");
await api.runNpcSequence();
assert.equal(api.getDisplayPrices().dragon, 29);
assertPriceInvariant(api, "official evidence");

api.advanceStage();
assert.equal(api.getStage(), "FINAL_MARKET");
api.selectGuild("dragon");
api.setQuantity(5);
api.trade("buy");
assert.equal(api.getForecast().favoriteId, "dragon");
api.advanceStage();
assert.equal(api.getStage(), "SETTLEMENT");
assert.equal(api.getState().settled, true);
assert.equal(api.getState().settlement.winnerId, "dragon");
assert.equal(api.getState().settlement.total, api.getState().cash + 500);
assert.equal(api.getState().snapshots.final.favoriteId, "dragon");
api.advanceStage();
assert.equal(api.getStage(), "REPLAY");

const marketClosedRun = loadPrototype();
marketClosedRun.api.selectGuild("dragon");
marketClosedRun.api.setQuantity(10);
marketClosedRun.api.trade("buy");
assert.equal(marketClosedRun.api.getState().cash, 1000, "orders must be rejected while market is closed");
assert.equal(marketClosedRun.api.getState().holdings.dragon.quantity, 0);

const balanceRun = loadPrototype();
balanceRun.api.advanceStage();
balanceRun.api.advanceStage();
balanceRun.api.selectGuild("alchemy");
balanceRun.api.setQuantity(10);
balanceRun.api.getState().cash = 1;
balanceRun.api.trade("buy");
assert.equal(balanceRun.api.getState().holdings.alchemy.quantity, 0, "orders above available balance must fail");
balanceRun.api.getState().cash = 1000;
balanceRun.api.trade("sell");
assert.equal(balanceRun.api.getState().cash, 1000, "orders above holdings must fail");

const costBasisRun = loadPrototype();
costBasisRun.api.advanceStage();
costBasisRun.api.advanceStage();
costBasisRun.api.selectGuild("alchemy");
costBasisRun.api.setQuantity(10);
costBasisRun.api.trade("buy");
assert.equal(costBasisRun.api.getState().holdings.alchemy.costBasis, 340);
costBasisRun.api.setQuantity(5);
costBasisRun.api.trade("sell");
assert.equal(costBasisRun.api.getState().holdings.alchemy.quantity, 5);
assert.equal(costBasisRun.api.getState().holdings.alchemy.costBasis, 170, "selling must reduce current cost basis proportionally");

api.getState().animating = true;
api.saveState();
const restoredRun = loadPrototype(mainRun.storage.values);
assert.equal(restoredRun.api.getState().animating, false, "reload must clear transient animation lock");
assert.equal(restoredRun.api.getStage(), "REPLAY", "reload must restore the current stage");
restoredRun.api.resetDemo();
assert.equal(restoredRun.api.getStage(), "WELCOME", "reset must return to the initial stage");
assert.equal(restoredRun.api.getState().cash, 1000);

console.log("Prototype verification: OK");
