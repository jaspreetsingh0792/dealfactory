const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    args: ["--no-sandbox"], headless: true,
  });
  const directory = process.argv[2] || "/tmp/provider-picker";
  fs.mkdirSync(directory, { recursive: true });
  const origin = "http://127.0.0.1:8764";
  try {
    const context = await browser.newContext({ viewport: { width: 412, height: 900 } });
    await context.route("https://generativelanguage.googleapis.com/**", route => {
      const header = route.request().headers()["x-goog-api-key"];
      assert.equal(header, "test-gemini-key");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": origin },
        body: JSON.stringify({ name: "models/gemini-2.5-flash" }),
      });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin + "/advisor/#connect", { waitUntil: "domcontentloaded" });
    await page.locator("#ai-provider").scrollIntoViewIfNeeded();
    assert.equal(await page.locator("#ai-provider").isVisible(), true);
    assert.equal(await page.locator("summary", { hasText: "Use an API key or a local model instead" }).count(), 0);
    assert.equal(await page.locator("#ai-provider").inputValue(), "openrouter");
    assert.equal(await page.locator("#or-signin").isVisible(), true);
    const labels = await page.locator("#ai-provider option").allTextContents();
    for (const name of ["OpenRouter", "Google Gemini", "OpenAI", "Anthropic", "Mistral", "Groq", "OpenAI-compatible", "Ollama"]) {
      assert.ok(labels.some(label => label.includes(name)), name);
    }
    await page.screenshot({ path: path.join(directory, "mobile-provider-picker.jpg"), type: "jpeg", quality: 82 });

    await page.locator("#ai-provider").selectOption("gemini");
    await page.waitForFunction(() => document.querySelector("#ai-help").textContent.includes("free tier"));
    assert.match(await page.locator("#ai-model").inputValue(), /gemini-/);
    await page.locator("#ai-key").fill("test-gemini-key");
    await page.locator("#ai-test").click();
    await page.waitForFunction(() => document.querySelector("#gmail").dataset.locked === "false");
    assert.match(await page.locator("#ai-connected").innerText(), /Step 1 done\. Connected: Google Gemini/);
    assert.match(await page.locator("#ai-status").innerText(), /Google Gemini accepted the key/);
    assert.equal(await page.locator("#gm-connect").isDisabled(), false);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#ai-provider").value === "gemini"
      && document.querySelector("#gmail").dataset.locked === "false");
    assert.match(await page.locator("#ai-connected").innerText(), /Google Gemini/);
    await page.locator("#gmail").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, "mobile-provider-unlocked-reload.jpg"), type: "jpeg", quality: 82 });

    await page.locator("#ai-provider").selectOption("compatible");
    await page.locator("#ai-base").fill("http://evil.example/v1");
    await page.locator("#ai-model").fill("local-model");
    await page.locator("#ai-form button[type=submit]").click();
    assert.match(await page.locator("#ai-status").innerText(), /https/);
    assert.equal(await page.locator("#gmail").getAttribute("data-locked"), "false");

    await page.locator("#ai-provider").selectOption("ollama");
    await page.locator("#ai-model").fill("");
    await page.locator("#ai-form button[type=submit]").click();
    assert.match(await page.locator("#ai-status").innerText(), /model name/);
    assert.match(await page.locator("#ai-help").innerText(), /OLLAMA_ORIGINS/);

    await page.locator("#ai-provider").selectOption("gemini");
    await page.locator("#ai-forget").click();
    await page.waitForFunction(() => document.querySelector("#gmail").dataset.locked === "true");
    assert.match(await page.locator("#gm-status").innerText(), /Finish step 1/);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.goto(origin + "/privacy/", { waitUntil: "domcontentloaded" });
    const privacy = await page.locator("main").innerText();
    assert.match(privacy, /whichever AI provider you pick/);
    assert.match(privacy, /OpenRouter, Google Gemini, OpenAI, Anthropic, Mistral, Groq/);
    assert.doesNotMatch(privacy, /deals@agentsealteam.com/);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
