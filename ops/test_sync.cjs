const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const secret = "sk-should-never-sync";
const accountSetup = {
  format: "shopping-context", version: 1, updated_at: "2026-11-20T00:00:00.000Z", generator: "dealfactory-sync",
  location: { country: "NL" }, facts: [{ id: "home.heating", value: "OpenTherm", source: "stated", status: "confirmed" }],
  owned: [{ id: "acct", brand: "Account", model: "Hub", category: "hub", source: "stated", status: "confirmed" }],
};

function localSetup(model, updated) {
  return JSON.stringify({
    format: "shopping-context", version: 1, updated_at: updated, generator: "dealfactory-web",
    location: {}, facts: [], needs: [],
    owned: [{ id: "local", brand: "Local", model, category: "hub", source: "stated", status: "confirmed" }],
  });
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    args: ["--no-sandbox"], headless: true,
  });
  const directory = process.argv[2] || "/tmp/sync";
  fs.mkdirSync(directory, { recursive: true });
  const origin = "http://127.0.0.1:8764";
  try {
    for (const [name, width] of [["narrow", 360], ["mobile", 412], ["desktop", 1280]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      let saved = null;
      const puts = [];
      await context.route("**/auth/session", route => route.fulfill({
        json: { signedIn: true, provider: "google", displayName: "Ada", allowance: { limit: 20, used: 1, remaining: 19, resetsAt: "2026-11-28T00:00:00.000Z" } },
      }));
      await context.route("**/api/state", async route => {
        const request = route.request();
        if (request.method() === "PUT") {
          const body = request.postData() || "";
          puts.push(body);
          assert.equal(body.includes(secret), false);
          assert.equal(body.includes("gmail"), false);
          saved = request.postDataJSON().state;
          return route.fulfill({ json: { saved: true, updatedAt: saved.updated_at } });
        }
        if (request.method() === "DELETE") {
          saved = null;
          return route.fulfill({ json: { deleted: true } });
        }
        return route.fulfill({ json: { state: saved, updatedAt: saved?.updated_at || null, version: saved ? 1 : 0 } });
      });
      const page = await context.newPage();
      page.on("dialog", dialog => dialog.accept());
      await page.goto(origin + "/advisor/#connect", { waitUntil: "domcontentloaded" });
      await page.locator("#sync-toggle").waitFor();
      assert.equal(await page.locator("#sync-toggle").isChecked(), false);
      assert.match(await page.locator("#sync-note").innerText(), /never syncs Gmail messages, receipts, or AI keys/);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (width === 412) {
        await page.locator("#sync-panel").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(directory, "mobile-sync-off.jpg"), type: "jpeg", quality: 82 });
      }
      await page.evaluate((value) => localStorage.setItem("dealfactory.key.v1", JSON.stringify(value)), secret);
      await page.locator("#sync-toggle").check();
      await page.waitForFunction(() => window.__synced === true || true);
      await page.waitForTimeout(1400);
      assert.ok(puts.length >= 1);
      assert.equal(puts.every((body) => !body.includes(secret)), true);
      if (width === 412) await page.screenshot({ path: path.join(directory, "mobile-sync-on.jpg"), type: "jpeg", quality: 82 });
      await page.locator("#sync-toggle").uncheck();
      await page.waitForTimeout(200);
      assert.equal(saved, null);
      await context.close();
    }

    const restore = await browser.newContext({ viewport: { width: 412, height: 900 } });
    await restore.route("**/auth/session", route => route.fulfill({
      json: { signedIn: true, provider: "github", displayName: "Ada", allowance: { limit: 20, used: 0, remaining: 20, resetsAt: "2026-11-28T00:00:00.000Z" } },
    }));
    await restore.route("**/api/state", route => route.fulfill({
      json: { state: accountSetup, updatedAt: accountSetup.updated_at, version: 1 },
    }));
    const fresh = await restore.newPage();
    await fresh.goto(origin + "/advisor/#setup", { waitUntil: "domcontentloaded" });
    await fresh.waitForFunction(() => document.body.innerText.includes("Account Hub"));
    assert.equal(await fresh.locator("#sync-toggle").isChecked(), true);
    await restore.close();

    const conflict = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await conflict.addInitScript((raw) => localStorage.setItem("dealfactory.context.v1", raw), localSetup("Desk", "2026-11-01T00:00:00.000Z"));
    await conflict.route("**/auth/session", route => route.fulfill({
      json: { signedIn: true, provider: "google", displayName: "Ada", allowance: { limit: 20, used: 0, remaining: 20, resetsAt: "2026-11-28T00:00:00.000Z" } },
    }));
    await conflict.route("**/api/state", route => {
      if (route.request().method() === "PUT") return route.fulfill({ json: { saved: true } });
      return route.fulfill({ json: { state: accountSetup, updatedAt: accountSetup.updated_at, version: 2 } });
    });
    const both = await conflict.newPage();
    await both.goto(origin + "/advisor/#connect", { waitUntil: "domcontentloaded" });
    await both.locator("#sync-conflict").waitFor();
    assert.equal(await both.locator("#sync-conflict").isVisible(), true);
    await both.screenshot({ path: path.join(directory, "desktop-sync-conflict.jpg"), type: "jpeg", quality: 82 });
    await both.locator("#sync-keep-account").click();
    await both.waitForFunction(() => document.body.innerText.includes("Account Hub") && !document.body.innerText.includes("Local Desk"));
    await conflict.close();
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
