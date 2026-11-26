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
      for (const [route, screen] of [["/", "home"], ["/deals/", "deals"], ["/guides/stroller-footmuffs/", "guide"], ["/about/", "about"]]) {
        await page.goto(origin + route, { waitUntil: "domcontentloaded" });
        await page.evaluate(() => document.fonts.ready);
        assert(await page.locator("h1").isVisible());
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (screen === "home") {
          assert(await page.locator(".memory-card").isVisible());
          assert.equal(await page.locator(".step-grid > li").count(), 3);
          await page.locator(".faq summary").first().click();
          assert(await page.locator(".faq details").first().evaluate(d => d.open));
        }
        if (screen === "deals") {
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
          // Load even the off-screen photographs for this visual review.
          await cards.first().scrollIntoViewIfNeeded();
          const images = cards.locator("img");
          const photos = await images.evaluateAll(async list => {
            for (const image of list) image.loading = "eager";
            await Promise.race([
              Promise.allSettled(list.map(image => image.decode())),
              new Promise(done => setTimeout(done, 8000))
            ]);
            return list.map(image => ({ host: new URL(image.src).hostname, loaded: image.naturalWidth > 0 }));
          });
          console.log(screen, name, "product photos loaded:", photos.filter(x => x.loaded).length, "of", await cards.count(), JSON.stringify(photos));
        }
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: path.join(directory, name + "-" + screen + ".jpg"), type: "jpeg", quality: 82 });
      }
      await page.goto(origin + "/#setup");
      await page.waitForURL("**/advisor.html#setup");
      assert(await page.locator("#need-form").count());
      await page.locator(".hero").scrollIntoViewIfNeeded();
      assert(await page.locator(".hero h1 em").isVisible());
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
      await page.screenshot({ path: path.join(directory, name + "-advisor.jpg"), type: "jpeg", quality: 82 });
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
