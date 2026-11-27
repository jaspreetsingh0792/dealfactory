const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const origin = "http://127.0.0.1:8764";
const draft = JSON.stringify({
  is_purchase: true, doc_type: "order_confirmation", merchant: null, order_date: "2026-11-01", currency: "EUR",
  items: [{ product_name: "Widget Filter", quote: "Widget Filter", brand: null, model: null, variant: null,
    category: "filter", kind: "accessory", quantity: 1, unit_price: 12.5 }],
});

function message(id) {
  return {
    id, internalDate: String(Date.UTC(2026, 10, 1)),
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "From", value: "Shop <orders@shop.example>" }, { name: "Subject", value: "Order" }],
      body: { data: Buffer.from("Widget Filter € 12,50").toString("base64url") },
    },
  };
}

function cors(extra = {}) {
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization,content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", ...extra };
}

async function installRoutes(context, mode) {
  let release = () => {};
  const hold = new Promise((resolve) => { release = resolve; });
  let profiles = 0;
  await context.route("https://accounts.google.com/o/oauth2/v2/auth?**", route => {
    const query = new URL(route.request().url()).searchParams;
    const callback = new URL(query.get("redirect_uri"));
    callback.hash = new URLSearchParams({
      access_token: "test-token", expires_in: "3600", token_type: "Bearer", state: query.get("state"),
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    }).toString();
    return route.fulfill({ contentType: "text/html", body: "<script>location.replace(" + JSON.stringify(callback.href) + ")</script>" });
  });
  await context.route("https://gmail.googleapis.com/**", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors() });
    const url = route.request().url();
    if (url.endsWith("/profile")) {
      profiles += 1;
      if (mode === "retry" && profiles === 1) return route.fulfill({ status: 429, body: "buyer@example.com", headers: cors() });
      if (mode === "retry") await new Promise((resolve) => setTimeout(resolve, 700));
      return route.fulfill({ json: { emailAddress: "buyer@example.com" }, headers: cors() });
    }
    if (url.includes("/messages?")) {
      const ids = mode === "empty" ? [] : mode === "cancel" || mode === "partial" ? [{ id: "m1" }, { id: "m2" }] : [{ id: "m1" }];
      return route.fulfill({ json: { messages: ids }, headers: cors() });
    }
    if (url.includes("/messages/m2") && mode === "partial") return route.fulfill({ status: 500, body: "buyer@example.com", headers: cors() });
    if ((url.includes("/messages/m1") && mode === "progress") || (url.includes("/messages/m2") && mode === "cancel")) await hold;
    return route.fulfill({ json: message(url.includes("m2") ? "m2" : "m1"), headers: cors() });
  });
  await context.route("https://openrouter.ai/api/v1/responses", route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors() });
    return route.fulfill({
      json: { output: [{ content: [{ type: "output_text", text: draft }] }] },
      headers: cors(),
    });
  });
  return () => release();
}

async function prepare(page) {
  await page.goto(origin + "/advisor/#connect", { waitUntil: "domcontentloaded" });
  await page.locator("#ai-key").fill("test-key-not-sent");
  await page.locator("#ai-form button[type=submit]").click();
  await page.waitForFunction(() => document.querySelector("#gmail").dataset.locked === "false");
  await page.evaluate(() => {
    window.__events = [];
    window.dealfactoryCount = (event) => window.__events.push(event);
  });
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    args: ["--no-sandbox"], headless: true,
  });
  const directory = process.argv[2] || "/tmp/gmail-progress";
  fs.mkdirSync(directory, { recursive: true });
  try {
    for (const [name, width] of [["mobile", 412], ["desktop", 1280]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const release = await installRoutes(context, "progress");
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await prepare(page);
      await page.locator("#gm-connect").click();
      await page.waitForFunction(() => /Reading message 1 of 1/.test(document.querySelector("#gm-status").textContent));
      assert.equal(await page.locator("#gm-connect").isDisabled(), true);
      assert.equal(await page.locator("#gm-cancel").isVisible(), true);
      assert.equal(await page.locator("#gm-status").getAttribute("aria-live"), "polite");
      const bar = await page.locator("#gm-bar").evaluate(el => getComputedStyle(el).backgroundColor);
      const fill = await page.locator("#gm-bar-fill").evaluate(el => getComputedStyle(el).backgroundColor);
      assert.match(bar, /250,\s*249,\s*244/);
      assert.match(fill, /224,\s*250,\s*105/);
      await page.locator("#gmail").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(directory, name + "-gmail-reading.jpg"), type: "jpeg", quality: 82 });
      release();
      await page.waitForFunction(() => /Done: 1 item added as/.test(document.querySelector("#gm-status").textContent));
      assert.equal(await page.locator("#gm-bar").getAttribute("aria-valuenow"), "100");
      assert.equal(await page.locator("#gm-status a[href='#setup']").count(), 1);
      await page.screenshot({ path: path.join(directory, name + "-gmail-done.jpg"), type: "jpeg", quality: 82 });
      assert.deepEqual(await page.evaluate(() => window.__events), ["gmail_import_start", "gmail_import"]);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      await context.close();

      const retryContext = await browser.newContext({ viewport: { width, height: 900 } });
      await installRoutes(retryContext, "retry");
      const retry = await retryContext.newPage();
      await prepare(retry);
      await retry.locator("#gm-connect").click();
      await retry.waitForFunction(() => /Gmail is busy, retrying in 1s/.test(document.querySelector("#gm-status").textContent));
      assert.doesNotMatch(await retry.locator("#gm-status").innerText(), /@/);
      await retry.locator("#gmail").scrollIntoViewIfNeeded();
      await retry.screenshot({ path: path.join(directory, name + "-gmail-retry.jpg"), type: "jpeg", quality: 82 });
      await retry.waitForFunction(() => /Done: 1 item added as/.test(document.querySelector("#gm-status").textContent));
      await retryContext.close();

      const cancelContext = await browser.newContext({ viewport: { width, height: 900 } });
      const releaseCancel = await installRoutes(cancelContext, "cancel");
      const cancel = await cancelContext.newPage();
      await prepare(cancel);
      await cancel.locator("#gm-connect").click();
      await cancel.waitForFunction(() => /Reading message 2 of 2/.test(document.querySelector("#gm-status").textContent));
      await cancel.locator("#gm-cancel").click();
      releaseCancel();
      await cancel.waitForFunction(() => /Stopped\. 1 item already added as/.test(document.querySelector("#gm-status").textContent));
      assert.equal(await cancel.locator("#gm-connect").isDisabled(), false);
      const stored = await cancel.evaluate(() => localStorage.getItem("dealfactory.purchases.v1") || "");
      assert.match(stored, /Widget Filter/);
      assert.doesNotMatch(stored, /@|buyer/);
      await cancel.locator("#gmail").scrollIntoViewIfNeeded();
      await cancel.screenshot({ path: path.join(directory, name + "-gmail-cancel.jpg"), type: "jpeg", quality: 82 });
      assert.deepEqual(await cancel.evaluate(() => window.__events), ["gmail_import_start", "gmail_import_cancel"]);
      await cancelContext.close();
    }

    const emptyContext = await browser.newContext({ viewport: { width: 412, height: 900 } });
    await installRoutes(emptyContext, "empty");
    const empty = await emptyContext.newPage();
    await prepare(empty);
    await empty.locator("#gm-since").selectOption("6m");
    await empty.locator("#gm-connect").click();
    await empty.waitForFunction(() => /No receipts found in the last 6 months/.test(document.querySelector("#gm-status").textContent));
    await empty.screenshot({ path: path.join(directory, "mobile-gmail-empty.jpg"), type: "jpeg", quality: 82 });
    await emptyContext.close();

    const partialContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await installRoutes(partialContext, "partial");
    const partial = await partialContext.newPage();
    await prepare(partial);
    await partial.locator("#gm-connect").click();
    await partial.waitForFunction(() => /1 message skipped/.test(document.querySelector("#gm-status").textContent));
    assert.match(await partial.locator("#gm-status").innerText(), /Done: 1 item added as/);
    assert.doesNotMatch(await partial.locator("#gm-status").innerText(), /@|buyer/);
    await partial.screenshot({ path: path.join(directory, "desktop-gmail-partial.jpg"), type: "jpeg", quality: 82 });
    await partialContext.close();
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
