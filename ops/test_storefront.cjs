const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    args: ["--no-sandbox"], headless: true,
  });
  try {
    const origin = "http://127.0.0.1:8764";
    const directory = process.argv[2];
    fs.mkdirSync(directory, { recursive: true });
    for (const [name, width, height] of [["desktop", 1440, 1080], ["mobile", 390, 844]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      for (const [route, screen] of [["/", "home"], ["/guides/stroller-footmuffs/", "guide"]]) {
        await page.goto(origin + route, { waitUntil: "domcontentloaded" });
        await page.evaluate(() => document.fonts.ready);
        assert(await page.locator("h1").isVisible());
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (screen === "home") {
          assert(await page.locator(".cover-photo").evaluate(img => img.decode().then(() => img.naturalWidth > 0)));
        }
        const cards = page.locator(".product");
        if (await cards.count()) {
          await page.locator("#offer-sort").selectOption("desc");
          const prices = await cards.evaluateAll(items => items.map(x => Number(x.dataset.price)));
          assert.deepEqual(prices, [...prices].sort((a, b) => b - a));
          const filter = page.locator("[data-filter]").nth(1);
          await filter.click();
          const shop = await filter.getAttribute("data-filter");
          assert(await page.locator(".product:visible").evaluateAll((items, chosen) =>
            items.length > 0 && items.every(x => x.dataset.shop === chosen), shop));
          await page.locator('[data-filter=""]').click();
          await page.locator("#offer-sort").selectOption("asc");
          // Lazy-loaded merchant photographs are allowed to fail independently.
          await cards.first().scrollIntoViewIfNeeded();
          const images = cards.locator("img");
          if (await images.count()) {
            await images.first().evaluate(img => Promise.race([
              img.decode().catch(() => {}), new Promise(done => setTimeout(done, 8000))
            ]));
          }
          console.log(screen, name, "product photos loaded:", await images.evaluateAll(list => list.filter(x => x.naturalWidth > 0).length), "of", await cards.count());
        }
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: path.join(directory, name + "-" + screen + ".jpg"), type: "jpeg", quality: 82 });
      }
      await page.goto(origin + "/#setup");
      await page.waitForURL("**/advisor.html#setup");
      assert(await page.locator("#need-form").count());
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
