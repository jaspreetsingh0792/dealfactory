const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    args: ["--no-sandbox"], headless: true,
  });
  const directory = process.argv[2] || "/tmp/manual-entry";
  fs.mkdirSync(directory, { recursive: true });
  const origin = "http://127.0.0.1:8764";
  try {
    for (const [name, width] of [["narrow", 360], ["mobile", 412], ["desktop", 1280]]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin + "/advisor/#setup", { waitUntil: "domcontentloaded" });
      const setup = await page.locator("#owned-form").boundingBox();
      const gmail = await page.locator("#gmail").boundingBox();
      assert.ok(setup.y < gmail.y, name + " should offer manual entry before Gmail");
      assert.match(await page.locator("#gmail-title").innerText(), /limited beta/i);
      assert.match(await page.locator("#gmail-beta").innerText(), /100 test users/);
      assert.equal(await page.locator("input[type=email]").count(), 0);
      await page.locator("#owned-category").fill("hub");
      await page.locator("#owned-brand").fill("Philips");
      await page.locator("#owned-model").fill("Hue Bridge");
      await page.locator("#owned-form button[type=submit]").click();
      await page.waitForFunction(() => document.body.innerText.includes("Philips Hue Bridge"));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator("#setup").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(directory, name + "-add-device.jpg"), type: "jpeg", quality: 82 });
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
