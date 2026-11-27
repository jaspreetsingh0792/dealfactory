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

    const context = await browser.newContext({ viewport: { width: 412, height: 900 } });
    await context.route("https://openrouter.ai/api/v1/auth/keys", route => route.fulfill({
      json: { key: "callback-test-key" },
      headers: { "Access-Control-Allow-Origin": origin },
    }));
    const restored = await context.newPage();
    const restoredErrors = [];
    restored.on("pageerror", error => restoredErrors.push(error.message));
    await restored.goto(origin + "/advisor/#connect", { waitUntil: "domcontentloaded" });
    await restored.evaluate(() => {
      localStorage.setItem("dealfactory.ai.v1", JSON.stringify({
        provider: "openrouter", model: "openrouter/auto", baseUrl: "", remember: false,
      }));
      sessionStorage.setItem("dealfactory.key.v1", JSON.stringify("restored-openrouter-key"));
    });
    await restored.reload({ waitUntil: "domcontentloaded" });
    await restored.waitForFunction(() => document.querySelector("#gmail").dataset.locked === "false");
    assert.match(await restored.locator("#ai-connected").innerText(), /Step 1 done\. Connected: OpenRouter/);
    assert.equal(await restored.locator("#gm-connect").isDisabled(), false);
    assert.equal(await restored.locator("#gm-connect").getAttribute("aria-disabled"), "false");
    assert.equal((await restored.locator("#gm-status").innerText()).trim(), "");
    await restored.locator("#gmail").scrollIntoViewIfNeeded();
    await restored.screenshot({ path: path.join(directory, "mobile-gmail-unlocked-reload.jpg"), type: "jpeg", quality: 82 });

    const other = await context.newPage();
    await other.goto(origin + "/advisor/#connect", { waitUntil: "domcontentloaded" });
    await restored.evaluate(() => {
      localStorage.setItem("dealfactory.ai.v1", JSON.stringify({
        provider: "openrouter", model: "openrouter/auto", baseUrl: "", remember: true,
      }));
      localStorage.removeItem("dealfactory.key.v1");
      localStorage.setItem("dealfactory.key.v1", JSON.stringify("cross-tab-openrouter-key"));
    });
    await other.waitForFunction(() => document.querySelector("#gmail").dataset.locked === "false");
    assert.match(await other.locator("#ai-connected").innerText(), /Step 1 done/);
    await other.close();

    await restored.locator("#ai-advanced summary").click();
    await restored.locator("#ai-forget").click();
    await restored.waitForFunction(() => document.querySelector("#gmail").dataset.locked === "true");
    assert.match(await restored.locator("#ai-connected").innerText(), /not connected yet/);
    assert.equal(await restored.locator("#gm-connect").isDisabled(), true);
    assert.match(await restored.locator("#gm-status").innerText(), /Finish step 1 before importing receipts/);
    await restored.locator("#gmail").scrollIntoViewIfNeeded();
    await restored.screenshot({ path: path.join(directory, "mobile-gmail-relocked.jpg"), type: "jpeg", quality: 82 });
    assert.deepEqual(restoredErrors, []);
    await restored.close();

    const callback = await context.newPage();
    const callbackErrors = [];
    callback.on("pageerror", error => callbackErrors.push(error.message));
    await callback.addInitScript(() => {
      const verifier = "verifier-verifier-verifier-verifier-verifier-48";
      sessionStorage.setItem("dealfactory.oauth.flow", JSON.stringify({
        provider: "openrouter", state: "state-1", verifier, returnPath: "/advisor/",
      }));
      sessionStorage.setItem("dealfactory.oauth.pending", JSON.stringify({
        type: "dealfactory-oauth", search: "?code=simulated-code&state=state-1", hash: "",
      }));
    });
    await callback.goto(origin + "/advisor/#connect", { waitUntil: "domcontentloaded" });
    await callback.waitForFunction(() => document.querySelector("#gmail").dataset.locked === "false");
    assert.match(await callback.locator("#ai-connected").innerText(), /Step 1 done\. Connected: OpenRouter/);
    assert.equal(await callback.locator("#gm-connect").isDisabled(), false);
    assert.equal(await callback.evaluate(() => !sessionStorage.getItem("dealfactory.oauth.flow") && !sessionStorage.getItem("dealfactory.oauth.pending")), true);
    await callback.locator("#gmail").scrollIntoViewIfNeeded();
    await callback.screenshot({ path: path.join(directory, "mobile-gmail-unlocked-callback.jpg"), type: "jpeg", quality: 82 });
    assert.deepEqual(callbackErrors, []);
    await callback.close();
    await context.close();
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
