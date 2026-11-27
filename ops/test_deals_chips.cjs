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
      await page.goto(origin + "/deals/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Matter", exact: true }).click();
      const visible = page.locator("#offer-grid article:not([hidden])");
      assert.ok(await visible.count() > 0);
      assert.match(await visible.first().innerText(), /Fits:.*Matter/);
      assert.match(await page.locator(".price-note").first().innerText(), /Price before delivery/);
      assert.equal(await page.locator(".open-shop").first().innerText(), "Open shop");
      await page.screenshot({ path: path.join(directory, `deals-chips-${width}.png`), fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main();
