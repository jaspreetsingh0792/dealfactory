// node --test web/tests   (no network, no keys)
import assert from "node:assert/strict";
import test from "node:test";

import { mergeContext, normalizeContext, parseAssistantReply, shareable, exportPrompt } from "../lib/context.js";
import { findDeals, DEALS_SCHEMA } from "../lib/deals.js";
import { groundDeals, harvestAnthropic, priceInText, SourceRegistry, valueInQuote } from "../lib/ground.js";
import { guessFromDevice } from "../lib/location.js";

test("priceInText handles local formats", () => {
  for (const [p, t, ok] of [[1299, "Nu € 1.299,-", true], [89.99, "€ 89,99", true], [89.99, "$89.99", true],
    [1299, "1 299,00 kr", true], [299, "€ 249,00", false], [24.99, "EUR 24,99 per pak", true]]) {
    assert.equal(priceInText(p, t), ok, `${p} in ${t}`);
  }
});

test("valueInQuote requires the numbers", () => {
  assert.ok(valueInQuote("2.5 TOG", "Warmth rating: 2.5 TOG"));
  assert.ok(!valueInQuote("3 TOG", "Warmth rating: 2.5 TOG"));
});

const PAGE = "Acme Fleece Footmuff X. Compatible with Cybex Balios S Lux. Now €89,99. TOG 2.5. In stock.";
function registry() {
  const reg = new SourceRegistry();
  harvestAnthropic([
    { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://guide.example/best", title: "Guide" }] },
    { type: "web_fetch_tool_result", content: { type: "web_fetch_result", url: "https://www.bol.com/p/acme-x?utm_source=x",
      retrieved_at: "2026-11-23T10:00:00Z", content: { type: "document", title: "Acme X", source: { type: "text", data: PAGE } } } },
    { type: "text", text: "notes", citations: [{ type: "web_search_result_location", url: "https://shop.example/y", title: "Y", cited_text: "Y Muff €49" }] },
  ], reg);
  return reg;
}

const CTX = { location: { country: "NL", city: "Utrecht", currency: "EUR" }, facts: [], needs: [],
  owned: [{ id: "stroller-cybex", brand: "Cybex", model: "Balios S Lux", category: "stroller", status: "confirmed" }] };

function draft() {
  return {
    picks: [
      { role: "top", product_name: "Acme Fleece Footmuff X", brand: "Acme", model: "X", why_it_fits: "Fits your Cybex; only €89,99.",
        tradeoffs: ["bulky"],
        compatible_with: [{ owned_id: "stroller-cybex", status: "compatible", evidence_quote: "Compatible with Cybex Balios S Lux", source_id: "S2" },
                          { owned_id: "ghost", status: "compatible", evidence_quote: null, source_id: null }],
        specs: [{ name: "TOG", value: "2.5", quote: "TOG 2.5", source_id: "S2" },
                { name: "Weight", value: "900 g", quote: "Weight 900 g", source_id: "S2" },
                { name: "Colour", value: "black", quote: null, source_id: "S99" }],
        offers: [{ retailer: "bol", price: 89.99, currency: "EUR", price_quote: "Now €89,99", source_id: "S2", in_stock: "yes" },
                 { retailer: "fake", price: 10, currency: "EUR", price_quote: "€10", source_id: "S42", in_stock: "yes" }] },
      { role: "budget", product_name: "Y Muff", brand: null, model: null, why_it_fits: "Cheaper, often €30.", tradeoffs: [],
        compatible_with: [], specs: [],
        offers: [{ retailer: "shop", price: 49, currency: "EUR", price_quote: "Y Muff €49", source_id: "S3", in_stock: "unknown" }] },
      { role: "premium", product_name: "Phantom 9000", brand: "Ghost", model: "9000", why_it_fits: "x", tradeoffs: [],
        compatible_with: [], specs: [{ name: "TOG", value: "4", quote: "TOG 4", source_id: null }], offers: [] },
    ],
    not_recommended: [], caveats: ["check the harness slots"],
  };
}

test("grounding: verified, cited, unknown, dropped", () => {
  const reg = registry();
  assert.equal(reg.size, 3);
  assert.equal(reg.get("S2").url, "https://www.bol.com/p/acme-x");  // tracking params stripped
  const g = groundDeals(draft(), reg, { ...CTX, _budget: 120 });
  const [top, budget] = g.picks;
  assert.equal(top.offers.length, 1);                                 // S42 does not exist -> offer gone
  assert.deepEqual([top.offers[0].price, top.offers[0].priceVerification, top.offers[0].retailer], [89.99, "verified", "bol.com"]);
  assert.deepEqual(top.specs.map((s) => s.status), ["known", "unknown", "unknown"]);  // weight not on page; S99 unknown
  assert.equal(top.compat.length, 1);                                 // "ghost" is not an owned id
  assert.equal(top.compat[0].status, "compatible");
  assert.equal(budget.offers[0].priceVerification, "cited");          // search citation only
  assert.deepEqual(g.dropped.map((d) => d.product), ["Phantom 9000"]); // nothing sourced -> never shown
  assert.ok(g.warnings.some((w) => w.includes("30")));               // €30 in the explanation is not a real price
  assert.ok(!g.warnings.some((w) => w.includes("89.99")));
});

test("compatibility claims not on the page become unknown", () => {
  const d = draft();
  d.picks[0].compatible_with[0].evidence_quote = "Fits every stroller ever made";
  const g = groundDeals(d, registry(), CTX);
  assert.equal(g.picks[0].compat[0].status, "unknown");
});

test("findDeals end to end with a fake model", async () => {
  const seen = [];
  const llm = {
    search: true,
    async research({ registry, prompt, location }) {
      seen.push(prompt);
      assert.equal(location.city, "Utrecht");
      harvestAnthropic(registry === null ? [] : [
        { type: "web_search_result", url: "https://guide.example/best" },
        { type: "web_fetch_result", url: "https://www.bol.com/p/acme-x", content: { source: { type: "text", data: PAGE } } },
        { type: "text", citations: [{ url: "https://shop.example/y", cited_text: "Y Muff €49" }] }], registry);
      return "notes";
    },
    async structured({ schema, prompt, stage }) {
      assert.equal(schema, DEALS_SCHEMA);
      assert.equal(stage, "structure");
      assert.match(prompt, /S2 \[fetched_page, page read\]/);
      return draft();
    },
  };
  const steps = [];
  const res = await findDeals(llm, CTX, { id: "footmuff", text: "fleece footmuff for my stroller", budget_max: 120 }, { onStep: (s) => steps.push(s) });
  assert.equal(res.kind, "deals");
  assert.equal(res.picks[0].product, "Acme Fleece Footmuff X");
  assert.match(seen[0], /Utrecht, NL/);
  assert.match(seen[0], /Balios S Lux/);
  assert.equal(steps.length, 3);
});

test("models without web search only get a checklist", async () => {
  const llm = { search: false, async structured({ stage }) { assert.equal(stage, "checklist");
    return { must_have: ["2.5 TOG"], nice_to_have: [], avoid: [], compatibility_checks: [], questions_for_you: [], search_terms: ["voetenzak"] }; } };
  const res = await findDeals(llm, CTX, { id: "x", text: "footmuff" });
  assert.equal(res.kind, "checklist");
  assert.equal(res.picks, undefined);
});

test("assistant import is unconfirmed and never overrides confirmed facts", () => {
  const reply = 'Sure! Here it is:\n```json\n{"format":"shopping-context","version":1,"location":{"country":"nl","city":"Utrecht"},' +
    '"facts":[{"id":"home.type","value":"house","source":"stated","status":"confirmed"},{"id":"household.pets","value":["cat"]},{"id":"bad id!","value":1}],' +
    '"owned":[{"category":"tv","brand":"TCL","model":"C805"},{"brand":"Cybex","model":"Balios S Lux","category":"stroller"}],' +
    '"needs":[{"text":"robot vacuum","budget_max":"600"}]}\n```\nLet me know!';
  const incoming = normalizeContext(parseAssistantReply(reply), { fromAssistant: true });
  assert.equal(incoming.location.country, "NL");
  assert.deepEqual(incoming.facts.map((f) => [f.id, f.source, f.status]), [["home.type", "inferred", "unconfirmed"], ["household.pets", "inferred", "unconfirmed"]]);
  const base = { ...CTX, facts: [{ id: "home.type", value: "apartment", source: "stated", status: "confirmed" }], needs: [], location: { country: "NL" } };
  const { context, changes } = mergeContext(normalizeContext(base), incoming);
  assert.equal(context.facts.find((f) => f.id === "home.type").value, "apartment");
  assert.equal(context.location.city, "Utrecht");
  assert.deepEqual(changes, { facts: 1, owned: 1, needs: 1, location: 1 });  // Cybex already owned
  assert.equal(context.needs[0].budget_max, 600);
});

test("shareable drops rejected and private items; export prompt carries the rules", () => {
  const c = normalizeContext({ location: { country: "NL" }, facts: [{ id: "a.b", value: 1, status: "rejected" }, { id: "a.c", value: 2 }],
    owned: [], needs: [] });
  c.facts.push({ id: "location.postcode", value: "1234", private: true, source: "stated", status: "confirmed" });
  c.location._how = "time zone";
  const s = shareable(c);
  assert.deepEqual(s.facts.map((f) => f.id), ["a.c"]);
  assert.equal(s.location._how, undefined);
  assert.match(exportPrompt(c, "robot vacuum"), /Never invent products/);
});

test("country guess from time zone, then language", () => {
  const env = (tz, langs) => ({ Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: tz }) }) }, navigator: { languages: langs } });
  assert.equal(guessFromDevice(env("Europe/Amsterdam", ["en-US"])).country, "NL");
  assert.equal(guessFromDevice(env("Europe/Amsterdam", ["en-US"])).currency, "EUR");
  assert.equal(guessFromDevice(env("Etc/UTC", ["pt-BR"])).country, "BR");
  assert.equal(guessFromDevice(env("Etc/UTC", ["en"])), null);
});
