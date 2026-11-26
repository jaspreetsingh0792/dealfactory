// Exercise real site navigation with simulated provider consent and disposable tokens.
const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");

async function main() {
  const origin = "http://127.0.0.1:8764";
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext();
    let exchanges = 0;
    const chatTargets = [];
    for (const host of ["claude.ai", "chatgpt.com"]) {
      await context.route("https://" + host + "/**", route => {
        const target = new URL(route.request().url());
        assert(target.searchParams.get("q")?.includes("Shopping Context"));
        chatTargets.push(target.hostname);
        return route.fulfill({ contentType: "text/html", body: "<title>Assistant</title>" });
      });
    }
    await context.route("https://openrouter.ai/auth?**", route => {
      const query = new URL(route.request().url()).searchParams;
      assert.equal(query.get("callback_url"), origin + "/oauth/callback/");
      assert.equal(query.get("code_challenge_method"), "S256");
      assert.equal(query.get("code_challenge").length, 43);
      const callback = new URL(query.get("callback_url"));
      callback.searchParams.set("code", "simulated-code");
      callback.searchParams.set("state", query.get("state"));
      return route.fulfill({ contentType: "text/html", body: "<script>location.replace(" + JSON.stringify(callback.href) + ")</script>" });
    });
    await context.route("https://openrouter.ai/api/v1/auth/keys", route => {
      const data = route.request().postDataJSON();
      assert.equal(data.code, "simulated-code");
      assert(data.code_verifier.length >= 43);
      exchanges++;
      return route.fulfill({ json: { key: "test-only-key" }, headers: { "Access-Control-Allow-Origin": origin } });
    });
    await context.route("https://accounts.google.com/o/oauth2/v2/auth?**", route => {
      const query = new URL(route.request().url()).searchParams;
      assert.equal(query.get("scope"), "https://www.googleapis.com/auth/gmail.readonly");
      assert.equal(query.get("redirect_uri"), origin + "/oauth/callback/");
      const callback = new URL(query.get("redirect_uri"));
      callback.hash = new URLSearchParams({ error: "access_denied", state: query.get("state") });
      return route.fulfill({ contentType: "text/html", body: "<script>location.replace(" + JSON.stringify(callback.href) + ")</script>" });
    });
    const page = await context.newPage();
    await page.goto(origin + "/advisor.html#connect");
    assert.equal(await page.locator("#connector-url").textContent(), origin + "/mcp");
    assert(await page.locator("#cg-signin").isHidden());
    for (const id of ["open-claude", "open-chatgpt"]) {
      const target = context.waitForEvent("page");
      await page.locator("#" + id).click();
      const tab = await target;
      await tab.waitForLoadState();
      await tab.close();
    }
    assert.deepEqual(chatTargets, ["claude.ai", "chatgpt.com"]);
    await page.locator("#or-signin").click();
    await page.waitForFunction(() => document.querySelector("#ai-connected").textContent.includes("Connected:"));
    assert.equal(exchanges, 1);
    await page.locator("#gm-connect").click();
    await page.locator("#gm-status").filter({ hasText: "Gmail access was not granted" }).waitFor();
    // When the browser blocks popups, the callback returns to this advisor tab.
    await page.evaluate(() => { window.open = () => null; });
    await page.locator("#or-signin").click();
    await page.waitForURL("**/advisor.html#connect");
    await page.waitForFunction(() => !sessionStorage.getItem("dealfactory.oauth.flow") &&
      document.querySelector("#ai-connected")?.textContent.includes("Connected:"));
    assert.equal(exchanges, 2);
    console.log("Verified the chat handoffs, OpenRouter popup and full-page callback, and Gmail consent cancellation.");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
