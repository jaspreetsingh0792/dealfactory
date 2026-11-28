import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyAffiliates, rewriteRetailerLink, sortOffers } from "../lib/affiliate.js";

const COOLBLUE = "https://www.coolblue.nl/product/983933/tado-bedrade-slimme-thermostaat-x-startpakket-2e-generatie.html";
const AQARA = "https://eu.aqara.com/en-eu/products/aqara-smart-hub-m3";
const AMAZON = "https://www.amazon.nl/dp/B0TEST";

test("an unset shop id leaves the retailer URL unchanged", () => {
  assert.deepEqual(rewriteRetailerLink(COOLBLUE, "Coolblue", {}), { href: COOLBLUE, affiliate: false });
  assert.deepEqual(rewriteRetailerLink(COOLBLUE, "Coolblue", {
    AFFILIATE_COOLBLUE_NETWORK: "awin",
    AFFILIATE_COOLBLUE_MERCHANT_ID: "mid123",
  }), { href: COOLBLUE, affiliate: false });
  assert.deepEqual(rewriteRetailerLink(AMAZON, "Amazon.nl", {}), { href: AMAZON, affiliate: false });
});

test("a complete awin, daisycon, tradetracker, or amazon id rewrites only that shop", () => {
  const awin = rewriteRetailerLink(COOLBLUE, "Coolblue", {
    AFFILIATE_AWIN_PUBLISHER_ID: "pub123",
    AFFILIATE_COOLBLUE_NETWORK: "awin",
    AFFILIATE_COOLBLUE_MERCHANT_ID: "mid123",
  });
  assert.equal(awin.affiliate, true);
  assert.equal(awin.href, `https://www.awin1.com/cread.php?awinmid=mid123&awinaffid=pub123&ued=${encodeURIComponent(COOLBLUE)}`);
  const daisy = rewriteRetailerLink(AQARA, "Aqara", {
    AFFILIATE_DAISYCON_WEBSITE_ID: "web123",
    AFFILIATE_AQARA_NETWORK: "daisycon",
    AFFILIATE_AQARA_MERCHANT_ID: "prog123",
    AFFILIATE_AQARA_MATERIAL_ID: "mat123",
  });
  assert.equal(daisy.href, `https://ds1.nl/c/?wi=web123&si=prog123&li=mat123&dl=${encodeURIComponent(AQARA)}`);
  const trade = rewriteRetailerLink("https://www.bol.com/nl/p/example/1/", "bol.com", {
    AFFILIATE_TRADETRACKER_AFFILIATE_ID: "aff123",
    AFFILIATE_BOL_NETWORK: "tradetracker",
    AFFILIATE_BOL_MERCHANT_ID: "camp123",
    AFFILIATE_BOL_MATERIAL_ID: "mat123",
  });
  assert.ok(trade.href.startsWith("https://tc.tradetracker.net/?c=camp123&m=mat123&a=aff123&u="));
  const amazon = rewriteRetailerLink(AMAZON, "Amazon.nl", { AFFILIATE_AMAZON_NL_TAG: "dealfactory-21" });
  assert.equal(amazon.href, `${AMAZON}?tag=dealfactory-21`);
  assert.equal(rewriteRetailerLink(AQARA, "Aqara", {
    AFFILIATE_AWIN_PUBLISHER_ID: "pub123",
    AFFILIATE_COOLBLUE_NETWORK: "awin",
    AFFILIATE_COOLBLUE_MERCHANT_ID: "mid123",
  }).href, AQARA);
});

test("a bad id is ignored and the plain URL is kept", () => {
  const result = rewriteRetailerLink(COOLBLUE, "Coolblue", {
    AFFILIATE_AWIN_PUBLISHER_ID: "pub 123",
    AFFILIATE_COOLBLUE_NETWORK: "awin",
    AFFILIATE_COOLBLUE_MERCHANT_ID: "mid123",
  });
  assert.deepEqual(result, { href: COOLBLUE, affiliate: false });
});

test("affiliate flags do not change sort order", () => {
  const offers = [
    { name: "Expensive", price: "20,00", url: COOLBLUE, retailer: "Coolblue", affiliate: true, commission: 50 },
    { name: "Cheap", price: "5,00", url: AQARA, retailer: "Aqara", affiliate: false, commission: 0 },
  ];
  const ordered = sortOffers(applyAffiliates(offers, {
    AFFILIATE_AWIN_PUBLISHER_ID: "pub123",
    AFFILIATE_COOLBLUE_NETWORK: "awin",
    AFFILIATE_COOLBLUE_MERCHANT_ID: "mid123",
  }), "asc");
  assert.deepEqual(ordered.map(item => item.name), ["Cheap", "Expensive"]);
  const source = readFileSync(new URL("../lib/storefront.js", import.meta.url), "utf8");
  assert.equal(source.includes("affiliate"), false);
  assert.equal(source.includes("commission"), false);
});
