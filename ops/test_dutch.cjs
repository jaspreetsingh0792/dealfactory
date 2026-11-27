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
    for (const width of [360, 412, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(origin + "/nl/", { waitUntil: "domcontentloaded" });
      assert.equal(await page.locator("html").getAttribute("lang"), "nl");
      assert.match(await page.locator("h1").innerText(), /past bij jouw huis/i);
      assert.equal(await page.locator('link[rel="alternate"][hreflang="x-default"]').getAttribute("href"), "https://dealfactory.example/");
      assert.equal(await page.locator('link[rel="alternate"][hreflang="nl"]').getAttribute("href"), "https://dealfactory.example/nl/");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.goto(origin + "/nl/deals/", { waitUntil: "domcontentloaded" });
      assert.match(await page.locator("h1").innerText(), /passen bij jouw huis/i);
      await page.goto(origin + "/nl/advisor/", { waitUntil: "domcontentloaded" });
      assert.match(await page.locator("h1").innerText(), /past bij jouw huis/i);
      assert.match(await page.title(), /past bij jouw huis/);
      if (width === 412) {
        await page.goto(origin + "/nl/", { waitUntil: "domcontentloaded" });
        await page.screenshot({ path: path.join(directory, "nl-home-412.png"), fullPage: true });
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main();
