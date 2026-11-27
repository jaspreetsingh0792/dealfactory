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
      await page.goto(origin + "/advisor/", { waitUntil: "domcontentloaded" });
      assert.equal(await page.title(), "Shopping advisor: what fits your home | DealFactory");
      const description = await page.locator('meta[name="description"]').getAttribute("content");
      assert.match(description, /what you own/);
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), "https://dealfactory.example/advisor/");
      const graph = JSON.parse(await page.locator('script[type="application/ld+json"]').last().textContent());
      const types = graph["@graph"].map(item => item["@type"]);
      assert.ok(types.includes("WebApplication"));
      assert.ok(types.includes("BreadcrumbList"));
      await page.screenshot({ path: path.join(directory, `advisor-seo-${width}.png`) });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main();
