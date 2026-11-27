// Offline tests for Gmail import, OpenRouter citations and the Claude.ai connector.
import assert from "node:assert/strict";
import test from "node:test";

import { contextFromPurchases, groundPurchase, htmlToText, importGmail, messageToDoc, redact } from "../lib/purchases.js";
import { harvestOpenRouter } from "../lib/llm.js";
import { SourceRegistry } from "../lib/ground.js";
import worker, { handleRpc, jsonLdOffers, pageText, robotsAllows, verifyOnPage } from "../../connector/src/index.js";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const EMAIL_HTML = `<html><body><p>Beste Sanne de Vries,</p><p>Bedankt voor je bestelling. Bestelnummer: 123-4567890-1234567</p>
<table><tr><td>Cybex Snogga 2 voetenzak</td><td>&euro; 89,99</td></tr><tr><td>Pampers Baby-Dry maat 4</td><td>&euro; 24,99</td></tr></table>
<p>Bezorgadres:</p><p>Sanne de Vries</p><p>Kerkstraat 12</p><p>1012 AB Amsterdam</p><p>Vragen? Bel 06 12345678 of mail sanne@example.nl</p></body></html>`;
const MSG = { id: "m1", internalDate: String(Date.UTC(2026, 9, 1)), payload: { mimeType: "multipart/alternative",
  headers: [{ name: "From", value: "Shop <noreply@mail.babyshop.example>" }, { name: "Subject", value: "Je bestelling" }],
  parts: [{ mimeType: "text/plain", body: { data: b64("Zie HTML") } }, { mimeType: "text/html", body: { data: b64(EMAIL_HTML) } }] } };

test("emails are redacted before any AI sees them", () => {
  const doc = messageToDoc(MSG);
  assert.equal(doc.senderDomain, "babyshop.example");
  assert.equal(doc.date, "2026-10-01");
  const text = redact(doc.text, ["sanne"]);
  for (const bad of ["Kerkstraat", "1012 AB", "06 12345678", "sanne@example.nl", "123-4567890", "Vries"]) assert.ok(!text.includes(bad), `${bad} leaked`);
  assert.ok(text.includes("Cybex Snogga 2 voetenzak") && text.includes("€ 89,99"));
});

test("purchase grounding drops invented items and unverified prices", () => {
  const text = redact(messageToDoc(MSG).text);
  const items = groundPurchase({ is_purchase: true, doc_type: "order_confirmation", merchant: "Babyshop", order_date: "2026-10-01", currency: "EUR", items: [
    { product_name: "Cybex Snogga 2 voetenzak", quote: "Cybex Snogga 2 voetenzak", brand: "Cybex", model: "Snogga 2", variant: null, category: "footmuff", kind: "accessory", quantity: 1, unit_price: 89.99 },
    { product_name: "Pampers Baby-Dry maat 4", quote: "Pampers Baby-Dry maat 4", brand: "Pampers", model: "Ultra", variant: null, category: "diapers", kind: "consumable", quantity: 1, unit_price: 19.99 },
    { product_name: "Invented TV", quote: "Samsung TV 55 inch", brand: "Samsung", model: null, variant: null, category: "tv", kind: "durable", quantity: 1, unit_price: 499 },
  ] }, { senderDomain: "babyshop.example", date: "2026-10-01" }, text, "abcd1234");
  assert.deepEqual(items.map((i) => i.productName), ["Cybex Snogga 2 voetenzak", "Pampers Baby-Dry maat 4"]);
  assert.equal(items[0].unitPrice, 89.99);
  assert.equal(items[1].unitPrice, null); // 19.99 isn't in the email
  assert.equal(items[1].model, null); // "Ultra" isn't in the email
});

test("purchases become unconfirmed owned items and habits", () => {
  const base = { merchant: "babyshop.example", docType: "order_confirmation", status: "unconfirmed", sourceKind: "email" };
  const ps = [
    { ...base, sourceRef: "a", orderDate: "2026-07-01", productName: "Cybex Snogga 2", brand: "Cybex", model: "Snogga 2", category: "footmuff", kind: "accessory" },
    ...["2026-07-01", "2026-07-29", "2026-08-26"].map((d, i) => ({ ...base, sourceRef: `d${i}`, orderDate: d, productName: "Pampers 4", brand: null, model: null, category: "diapers", kind: "consumable" })),
  ];
  const { owned, facts } = contextFromPurchases(ps, [{ id: "stroller", brand: "Cybex", model: "Balios S Lux" }]);
  assert.deepEqual(owned.map((o) => [o.id, o.status, o.source]), [["imp-cybex-snogga-2", "unconfirmed", "email"]]);
  assert.match(facts.find((f) => f.id === "habits.repeat_purchases").value[0], /diapers: about every 28 days/);
});

test("Gmail import reads, skips seen emails and never logs email text", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/profile")) return Response.json({ emailAddress: "sanne.devries@example.nl" });
    if (String(url).includes("/messages?")) return Response.json({ messages: [{ id: "m1" }, { id: "m2" }] });
    if (String(url).includes("/messages/m2")) return Response.json({ ...MSG, id: "m2", payload: { mimeType: "text/plain", headers: [], body: { data: b64("Nieuwsbrief zonder prijzen") } } });
    return Response.json(MSG);
  };
  const seen = [];
  const llm = { structured: async ({ prompt }) => { seen.push(prompt); return { is_purchase: true, doc_type: "order_confirmation", merchant: null, order_date: null, currency: "EUR",
    items: [{ product_name: "Cybex Snogga 2 voetenzak", quote: "Cybex Snogga 2 voetenzak", brand: "Cybex", model: null, variant: null, category: "footmuff", kind: "accessory", quantity: 1, unit_price: 89.99 }] }; } };
  const rep = await importGmail({ token: "t", llm, max: 10 });
  assert.equal(rep.purchases.length, 1);
  assert.equal(rep.skippedNoPrice, 1);
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].includes("devries") && !seen[0].includes("Kerkstraat"));
  assert.ok(!JSON.stringify(rep.audit).includes("voetenzak €") && /email omitted/.test(rep.audit[0].prompt));
  const again = await importGmail({ token: "t", llm, max: 10, seenRefs: new Set(rep.refs) });
  assert.equal(again.skippedSeen, 2);
  assert.ok(calls.every((u) => u.startsWith("https://gmail.googleapis.com/")));
});

test("Gmail import reports phases, retries and a cancel without email text", async () => {
  const receipt = { id: "m1", internalDate: String(Date.UTC(2026, 9, 1)), payload: { mimeType: "text/plain",
    headers: [{ name: "From", value: "Shop <orders@shop.example>" }, { name: "Subject", value: "Order" }],
    body: { data: b64("Widget Filter € 12,50") } } };
  const steps = [];
  let profiles = 0;
  globalThis.fetch = async (url) => {
    const address = String(url);
    if (address.endsWith("/profile")) {
      profiles++;
      if (profiles === 1) return new Response("buyer@example.com", { status: 429 });
      return Response.json({ emailAddress: "buyer@example.com" });
    }
    if (address.includes("/messages?")) return Response.json({ messages: [{ id: "m1" }, { id: "m2" }] });
    if (address.includes("/messages/m2")) return Response.json({ ...receipt, id: "m2" });
    return Response.json(receipt);
  };
  const llm = { structured: async () => ({ is_purchase: true, doc_type: "order_confirmation", merchant: null, order_date: null, currency: "EUR",
    items: [{ product_name: "Widget Filter", quote: "Widget Filter", brand: null, model: null, variant: null, category: "filter", kind: "accessory", quantity: 1, unit_price: 12.5 }] }) };
  const ctrl = new AbortController();
  await assert.rejects(importGmail({ token: "t", llm, max: 10, providerLabel: "OpenRouter (Claude, GPT and more)", signal: ctrl.signal,
    onStep: (update) => {
      steps.push(update.text);
      if (update.text === "Reading message 2 of 2") ctrl.abort();
    } }), (error) => error.name === "AbortError" && error.partial.purchases.length === 1);
  assert.ok(steps.includes("Gmail is busy, retrying in 1s"));
  assert.ok(steps.includes("Searching receipts (2 found)"));
  assert.ok(steps.includes("Reading message 1 of 2"));
  assert.ok(steps.includes("Extracting items with OpenRouter (Claude, GPT and more) (1 of 2)"));
  assert.equal(steps.at(-1), "Reading message 2 of 2");
  assert.ok(steps.every((text) => !/@|Widget Filter|buyer/.test(text)));
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/profile")) return Response.json({ emailAddress: "buyer@example.com" });
    if (String(url).includes("/messages?")) return new Response("buyer@example.com secret", { status: 400 });
    return Response.json({ messages: [] });
  };
  await assert.rejects(importGmail({ token: "t", llm, max: 1 }), (error) => error.message === "Gmail said 400");
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/profile")) return Response.json({ emailAddress: "buyer@example.com" });
    return Response.json({ messages: [] });
  };
  const emptySteps = [];
  const empty = await importGmail({ token: "t", llm, max: 5, onStep: (update) => emptySteps.push(update.text) });
  assert.equal(empty.listed, 0);
  assert.ok(emptySteps.includes("Searching receipts (0 found)"));
});

test("Gmail import stops before the AI if the profile cannot be read", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response("unavailable", { status: 503 });
  };
  const llm = { structured: async () => { throw new Error("AI should not be called"); } };
  await assert.rejects(importGmail({ token: "t", llm, max: 1 }), /profile could not be read/);
  assert.ok(calls.every((url) => url.endsWith("/profile")));
  assert.equal(calls.length, 4);
});

test("OpenRouter citations become cited sources", () => {
  const reg = new SourceRegistry();
  harvestOpenRouter([{ type: "message", content: [{ type: "output_text", text: "x", annotations: [
    { type: "url_citation", url: "https://www.bol.com/p/x", title: "X", content: "Nu € 89,99" },
    { type: "url_citation", url_citation: { url: "https://shop.example/y", title: "Y" } }] }] }], reg);
  assert.equal(reg.size, 2);
  assert.equal(reg.get("S1").hasPage, false);
});

test("connector: robots.txt, JSON-LD and verification", async () => {
  assert.equal(robotsAllows("User-agent: *\nDisallow: /checkout", "/p/1"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /", "/p/1"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /\nAllow: /p/", "/p/1"), true);
  const page = `<html><title>Acme Footmuff</title><script type="application/ld+json">{"@type":"Product","name":"Acme","offers":{"@type":"Offer","price":"89.99","priceCurrency":"EUR","availability":"https://schema.org/InStock"}}</script>
    <body>${"Fits Cybex Balios S Lux strollers. ".repeat(20)} Now €89,99</body></html>`;
  assert.deepEqual(jsonLdOffers(page)[0], { product: "Acme", price: 89.99, currency: "EUR", availability: "InStock" });
  const fetcher = async (u) => (String(u).endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /cart") : new Response(page, { status: 200 }));
  const good = await verifyOnPage({ url: "https://shop.example/p/acme", price: 89.99, currency: "EUR", quote: "Fits Cybex Balios S Lux strollers." }, fetcher);
  assert.equal(good.price_verified, true);
  assert.equal(good.quote_on_page, true);
  assert.match(good.verdict, /^VERIFIED/);
  const bad = await verifyOnPage({ url: "https://shop2.example/p/acme", price: 79, quote: "Fits Bugaboo Fox" }, fetcher);
  assert.match(bad.verdict, /^NOT VERIFIED/);
  await assert.rejects(verifyOnPage({ url: "http://127.0.0.1/x" }, fetcher));
  const priced = `<html><title>Filter</title><script type="application/ld+json">{"@type":"Product","name":"Filter","offers":{"@type":"Offer","priceCurrency":"EUR","availability":"https://schema.org/InStock","priceSpecification":{"price":"1.299,00","priceCurrency":"EUR"}}}</script><body>${"spec ".repeat(40)} $1299.00</body></html>`;
  const pricedFetcher = async (u) => (String(u).endsWith("/robots.txt") ? new Response("User-agent: *\nAllow: /") : new Response(priced, { status: 200 }));
  assert.equal(jsonLdOffers(priced)[0].price, 1299);
  assert.equal(jsonLdOffers(priced)[0].currency, "EUR");
  const structured = await verifyOnPage({ url: "https://shop3.example/filter", price: 1299, currency: "EUR" }, pricedFetcher);
  assert.equal(structured.price_in_structured_data, true);
  assert.equal(structured.price_in_text, false);
  const dollars = `<html><title>Plug</title><body>${"word ".repeat(80)} $89.99</body></html>`;
  const dollarFetcher = async (u) => (String(u).endsWith("/robots.txt") ? new Response("User-agent: *\nAllow: /") : new Response(dollars, { status: 200 }));
  const wrongCurrency = await verifyOnPage({ url: "https://shop4.example/plug", price: 89.99, currency: "EUR" }, dollarFetcher);
  assert.equal(wrongCurrency.price_in_text, false);
  assert.equal(wrongCurrency.price_verified, false);
  const euros = `<html><title>Plug</title><body>${"word ".repeat(80)} €89,99</body></html>`;
  const euroFetcher = async (u) => (String(u).endsWith("/robots.txt") ? new Response("User-agent: *\nAllow: /") : new Response(euros, { status: 200 }));
  const rightCurrency = await verifyOnPage({ url: "https://shop5.example/plug", price: 89.99, currency: "EUR" }, euroFetcher);
  assert.equal(rightCurrency.price_verified, true);
});

test("connector speaks MCP", async () => {
  const init = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const list = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["get_shopping_rules", "verify_on_page"]);
  const rules = await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_shopping_rules", arguments: { country: "nl" } } });
  assert.equal(rules.result.structuredContent.location.currency, "EUR");
  const r = await worker.fetch(new Request("https://c.example/mcp", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
  assert.equal(r.status, 202);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("strict-transport-security"), /max-age=31536000/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const denied = await worker.fetch(new Request("https://c.example/mcp", { method: "PUT" }));
  assert.equal(denied.status, 405);
  assert.equal(denied.headers.get("allow"), "POST");
});

test("security hardening: malformed entities, wildcard robots, deep JSON-LD, and internal hosts", async () => {
  assert.equal(pageText("Price &#9999999; &#55296; ok"), "Price ok");
  assert.equal(htmlToText("Email &#9999999; ok"), "Email ok");
  assert.equal(robotsAllows("User-agent: *\nDisallow: /" + "a*".repeat(25) + "b", "/" + "a".repeat(60)), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /p/*.pdf$", "/p/guide.pdf"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /p/*.pdf$", "/p/guide.pdf?x=1"), true);
  const deep = "<script type=\"application/ld+json\">" + "{\"a\":".repeat(40) + "1" + "}".repeat(40) + "</script>";
  assert.deepEqual(jsonLdOffers(deep), []);
  const fetcher = async () => { throw new Error("should not fetch blocked host"); };
  for (const bad of ["https://127.0.0.1.nip.io/x", "https://router.home.arpa/x", "https://app.localtest.me/x"]) {
    await assert.rejects(verifyOnPage({ url: bad }, fetcher));
  }
  await assert.rejects(verifyOnPage({ url: "https://shop.example/p", quote: "x".repeat(1001) }, fetcher));
});
