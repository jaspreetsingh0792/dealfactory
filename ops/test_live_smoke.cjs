// Read-only checks against the public site. Set LIVE_ORIGIN to point elsewhere.
const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");

const origin = (process.env.LIVE_ORIGIN || "https://deals.agentsealteam.com").replace(/\/$/, "");

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    args: ["--no-sandbox"], headless: true,
  });
  try {
    for (const [name, width] of [["narrow", 360], ["mobile", 412], ["desktop", 1280]]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
      assert.match(await page.title(), /DealFactory/);
      assert.match(await page.locator("h1").innerText(), /your home/i);
      await page.goto(origin + "/advisor/#setup", { waitUntil: "domcontentloaded" });
      const setup = await page.locator("#owned-form").boundingBox();
      const gmail = await page.locator("#gmail").boundingBox();
      assert.ok(setup && gmail && setup.y < gmail.y, name);
      assert.match(await page.locator("#gmail-title").innerText(), /limited beta/i);
      assert.equal(await page.locator("input[type=email]").count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      await page.close();
    }
    const page = await browser.newPage();
    const robots = await page.goto(origin + "/robots.txt");
    assert.equal(robots.status(), 200);
    assert.match(await robots.text(), /Sitemap:/);
    const sitemap = await page.goto(origin + "/sitemap.xml");
    assert.equal(sitemap.status(), 200);
    const xml = await sitemap.text();
    assert.ok(xml.includes("/advisor/") && xml.includes("<lastmod>"));
    const missing = await page.goto(origin + "/this-page-does-not-exist");
    assert.equal(missing.status(), 404);
    const privacy = await page.goto(origin + "/privacy/");
    assert.equal(privacy.status(), 200);
    const privacyText = await privacy.text();
    assert.equal(privacyText.includes("deals@agentsealteam.com"), false);
    assert.match(privacyText, /Limited Use/);
    console.log("Live smoke passed for " + origin);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
