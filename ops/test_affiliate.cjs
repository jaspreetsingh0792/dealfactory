const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright-core");

async function main() {
  const { renderOpenShop, rewriteRetailerLink, DISCLOSURE } = await import(pathToFileURL(path.resolve("web/lib/affiliate.js")).href);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    args: ["--no-sandbox"], headless: true,
  });
  try {
    const origin = "http://127.0.0.1:8764";
    for (const width of [360, 412, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(origin + "/deals/", { waitUntil: "domcontentloaded" });
      assert.equal(await page.locator(".affiliate-label").count(), 0);
      assert.equal(await page.locator(".affiliate-disclosure").count(), 0);
      const shop = page.locator(".open-shop").first();
      if (await shop.count()) {
        const href = await shop.getAttribute("href");
        assert.equal(href.startsWith("https://www.awin1.com/"), false);
        assert.equal(await shop.getAttribute("rel"), null);
      }
      const plain = "https://www.coolblue.nl/product/1/example.html";
      const off = rewriteRetailerLink(plain, "Coolblue", {});
      await page.setContent(`<main>${renderOpenShop({ href: off.href, affiliate: off.affiliate })}</main>`);
      assert.equal(await page.locator(".affiliate-label").count(), 0);
      const on = rewriteRetailerLink(plain, "Coolblue", {
        AFFILIATE_AWIN_PUBLISHER_ID: "pub123",
        AFFILIATE_COOLBLUE_NETWORK: "awin",
        AFFILIATE_COOLBLUE_MERCHANT_ID: "mid123",
      });
      await page.setContent(`<main>${renderOpenShop({ href: on.href, affiliate: on.affiliate })}<p class="affiliate-disclosure">${DISCLOSURE.en}</p></main>`);
      assert.equal(await page.locator(".affiliate-label").innerText(), "Affiliate link");
      assert.equal(await page.locator(".open-shop").getAttribute("rel"), "sponsored nofollow noopener");
      assert.match(await page.locator(".affiliate-disclosure").innerText(), /no extra cost/);
      await page.setContent(`<main>${renderOpenShop({ href: on.href, affiliate: true, dutch: true })}<p class="affiliate-disclosure">${DISCLOSURE.nl}</p></main>`);
      assert.equal(await page.locator(".affiliate-label").innerText(), "Affiliatelink");
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main();
