const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    args: ["--no-sandbox"], headless: true,
  });
  const directory = process.argv[2] || "/tmp/signin";
  fs.mkdirSync(directory, { recursive: true });
  const origin = "http://127.0.0.1:8764";
  try {
    for (const [name, width] of [["narrow", 360], ["mobile", 412], ["desktop", 1280]]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin + "/advisor/#connect", { waitUntil: "domcontentloaded" });
      await page.locator("#signin-google").scrollIntoViewIfNeeded();
      assert.equal(await page.locator("#signin-google").getAttribute("href"), "/auth/login/google");
      assert.equal(await page.locator("#signin-github").getAttribute("href"), "/auth/login/github");
      assert.equal(await page.locator("#gmail").getAttribute("data-locked"), "true");
      assert.equal(await page.locator("#ai-byo").getAttribute("open"), null);
      const color = await page.locator("#signin-google").evaluate(el => getComputedStyle(el).backgroundColor);
      const ink = await page.locator("#signin-google").evaluate(el => getComputedStyle(el).color);
      assert.match(color, /24,\s*46,\s*32/);
      assert.match(ink, /224,\s*250,\s*105/);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(directory, name + "-signin.jpg"), type: "jpeg", quality: 82 });
      assert.deepEqual(errors, []);
      await page.close();
    }
    const context = await browser.newContext({ viewport: { width: 412, height: 900 } });
    await context.route("**/auth/session", route => route.fulfill({
      json: { signedIn: true, provider: "google", displayName: "Ada", allowance: { limit: 20, used: 3, remaining: 17, resetsAt: "2026-11-28T00:00:00.000Z" } },
    }));
    const signed = await context.newPage();
    await signed.goto(origin + "/advisor/#connect", { waitUntil: "domcontentloaded" });
    await signed.waitForFunction(() => document.querySelector("#gmail").dataset.locked === "false");
    assert.match(await signed.locator("#ai-connected").innerText(), /Signed in with Google as Ada/);
    assert.match(await signed.locator("#ai-allowance").innerText(), /17 of 20 free answers left today/);
    assert.equal(await signed.locator("#signin-google").isVisible(), false);
    assert.equal(await signed.locator("#gm-connect").isDisabled(), false);
    await signed.locator("#ai").scrollIntoViewIfNeeded();
    await signed.screenshot({ path: path.join(directory, "mobile-signed-in.jpg"), type: "jpeg", quality: 82 });
    await context.close();
    const soonContext = await browser.newContext({ viewport: { width: 412, height: 900 } });
    await soonContext.route("**/auth/providers", route => route.fulfill({ json: { google: false, github: false, ai: false } }));
    await soonContext.route("**/auth/session", route => route.fulfill({ json: { signedIn: false } }));
    const soon = await soonContext.newPage();
    await soon.goto(origin + "/advisor/#connect", { waitUntil: "domcontentloaded" });
    await soon.waitForFunction(() => !document.querySelector("#signin-soon").hidden);
    assert.equal(await soon.locator("#signin-google").isVisible(), false);
    assert.match(await soon.locator("#signin-soon").innerText(), /coming soon/);
    assert.equal(await soon.locator("#ai-byo summary").isVisible(), true);
    await soonContext.close();
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
