const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    args: ["--no-sandbox"], headless: true,
  });
  const origin = "http://127.0.0.1:8764";
  try {
    for (const [name, width] of [["narrow", 360], ["mobile", 412], ["desktop", 1280]]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
      assert.match(await page.locator("#memory-title").innerText(), /your home/i);
      assert.equal(await page.locator(".step-grid > li").count(), 3);
      const faq = await page.locator(".faq").innerText();
      for (const phrase of ["free", "open source", "private", "bring my own AI"]) {
        assert.match(faq.toLowerCase(), new RegExp(phrase.toLowerCase()));
      }
      assert.equal(await page.locator("a[href='/guides/stroller-footmuffs/']").count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name);
      const missing = await page.goto(origin + "/404.html");
      assert.equal(missing.status(), 200);
      assert.match(await page.locator("h1").innerText(), /doesn't exist/i);
      assert.match(await page.locator('meta[name="robots"]').getAttribute("content"), /noindex/);
      const robots = await page.goto(origin + "/robots.txt");
      assert.equal(robots.status(), 200);
      assert.match(await robots.text(), /Sitemap:/);
      const sitemap = await page.goto(origin + "/sitemap.xml");
      assert.equal(sitemap.status(), 200);
      const xml = await sitemap.text();
      assert.ok(xml.includes("<lastmod>") && xml.includes("/advisor/"));
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
