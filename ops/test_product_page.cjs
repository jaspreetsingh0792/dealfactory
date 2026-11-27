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
    const list = await browser.newPage();
    await list.goto(origin + "/deals/", { waitUntil: "domcontentloaded" });
    const href = await list.locator("a.product-target").first().getAttribute("href");
    assert.ok(href.startsWith("/deals/") && href.endsWith("/"));
    await list.close();
    for (const width of [360, 412, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(origin + href, { waitUntil: "domcontentloaded" });
      assert.match(await page.title(), /: checked price and fit \| DealFactory$/);
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), "https://dealfactory.example" + href);
      const graph = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
      const types = graph["@graph"].map(item => item["@type"]);
      assert.ok(types.includes("Product"));
      assert.ok(types.includes("BreadcrumbList"));
      const offer = graph["@graph"].find(item => item["@type"] === "Product").offers;
      assert.ok(offer["@type"] === "Offer" || offer["@type"] === "AggregateOffer");
      if (offer["@type"] === "AggregateOffer") assert.ok(offer.offerCount >= 2);
      assert.match(await page.locator("h1").innerText(), /.+/);
      assert.match(await page.locator(".price-note").first().innerText(), /Price before delivery/);
      await page.screenshot({ path: path.join(directory, `product-page-${width}.png`), fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main();
