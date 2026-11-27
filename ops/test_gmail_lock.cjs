const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

function rgb(color) {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    args: ["--no-sandbox"], headless: true,
  });
  const directory = process.argv[2] || "/tmp/gmail-lock";
  fs.mkdirSync(directory, { recursive: true });
  try {
    const origin = "http://127.0.0.1:8764";
    for (const [name, width] of [["narrow", 360], ["mobile", 412], ["desktop", 1280]]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin + "/advisor/#connect", { waitUntil: "domcontentloaded" });
      await page.locator("#gmail").scrollIntoViewIfNeeded();
      const button = page.locator("#gm-connect");
      assert.equal(await button.isDisabled(), true, name + " gmail button should start disabled");
      assert.equal(await button.getAttribute("aria-disabled"), "true");
      assert.equal(await page.locator("#gmail").getAttribute("data-locked"), "true");
      const hint = page.locator("#gm-status");
      assert.match(await hint.innerText(), /Finish step 1 before importing receipts/);
      assert.doesNotMatch(await hint.innerText(), /Add your API key first/);
      const hintColor = rgb(await hint.evaluate(el => getComputedStyle(el).color));
      assert.ok(hintColor && hintColor[0] < 80 && hintColor[1] > hintColor[0], name + " hint should stay in the pine palette");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const step1 = await page.locator("#ai").boundingBox();
      const step2 = await page.locator("#gmail").boundingBox();
      if (width < 760) assert.ok(step1.y < step2.y, name + " should show step 1 above step 2");
      await page.screenshot({ path: path.join(directory, name + "-gmail-locked.jpg"), type: "jpeg", quality: 82 });

      await page.locator("#ai-advanced summary").click();
      await page.locator("#ai-key").fill("test-key-not-sent");
      await page.locator("#ai-form button[type=submit]").click();
      await page.waitForFunction(() => document.querySelector("#ai").classList.contains("is-ready"));
      assert.match(await page.locator("#ai-connected").innerText(), /Step 1 done/);
      assert.equal(await button.isDisabled(), false);
      assert.equal(await button.getAttribute("aria-disabled"), "false");
      assert.equal(await page.locator("#gmail").getAttribute("data-locked"), "false");
      assert.equal((await hint.innerText()).trim(), "");
      await page.locator("#gmail").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(directory, name + "-gmail-unlocked.jpg"), type: "jpeg", quality: 82 });
      await page.locator("#ai").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(directory, name + "-ai-done.jpg"), type: "jpeg", quality: 82 });
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
