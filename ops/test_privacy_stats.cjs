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
      await page.goto(origin + "/privacy/", { waitUntil: "domcontentloaded" });
      const text = await page.locator("main").innerText();
      assert.match(text, /cookieless beacon/);
      assert.match(text, /does not use cookies/);
      assert.equal(text.includes("deals@agentsealteam.com"), false);
      assert.match(text, /Limited Use/);
      const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
      assert.match(csp, /cloudflareinsights\.com/);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
