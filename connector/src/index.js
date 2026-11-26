// DealFactory connector for Claude.ai (and any remote-MCP client such as ChatGPT developer mode).
//
// Claude does the searching inside the user's own Claude plan. This server adds what the plan can't
// guarantee by itself: the shopping rules, and an independent check that a price or a compatibility
// statement is really on the shop's page before Claude repeats it.
//
// Stateless MCP over Streamable HTTP (JSON responses), no accounts, no storage, nothing logged.
// It fetches only public pages the assistant asks about, honours robots.txt and rate-limits per site.

import { GUIDE } from "../../web/lib/context.js";
import { norm, priceInText } from "../../web/lib/ground.js";
import { countryName, currencyFor, languageFor } from "../../web/lib/location.js";

const VERSION = "0.2.0";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const UA = "DealFactoryVerifier/0.2 (+https://github.com/jaspreetsingh0792/dealfactory; checks one product page on request)";
const MAX_BYTES = 2_000_000;
const MIN_GAP_MS = 4000;

const INSTRUCTIONS = `DealFactory helps you give shopping advice that fits what the user owns, with verified prices.
1. Call get_shopping_rules first (with the user's country if you know it).
2. If the user shared a DealFactory Shopping Context (JSON or a prompt from the DealFactory site), use it.
3. Before you state a price, stock, spec or "works with <owned item>", call verify_on_page with the product
   page URL and the exact text. Only present it as verified when the tool says so; otherwise say unknown.`;

const TOOLS = [
  {
    name: "get_shopping_rules",
    title: "Shopping rules",
    description: "The rules for honest shopping advice (no invented products, prices or links; check compatibility with owned items) plus the currency and language for the user's country. Call this before giving product or deal advice.",
    inputSchema: { type: "object", properties: { country: { type: "string", description: "ISO 3166-1 alpha-2 code, e.g. NL, US, IN" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "verify_on_page",
    title: "Verify a price or claim on a shop page",
    description: "Fetches one public product page and checks whether a price and/or an exact quote (spec, stock, compatibility statement) is really on it. Also returns the price and currency from the page's structured data (schema.org) when present. Use it before presenting any price or compatibility claim as fact.",
    inputSchema: {
      type: "object", required: ["url"], additionalProperties: false,
      properties: {
        url: { type: "string", description: "https URL of the product page" },
        price: { type: "number", description: "Price you intend to state, e.g. 89.99" },
        currency: { type: "string", description: "ISO currency of that price, e.g. EUR" },
        quote: { type: "string", description: "Exact text you intend to rely on, copied from the page" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

// ------------------------------------------------------------------ page fetching (polite)
const lastHit = new Map();
const robotsCache = new Map();

function safeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Not a valid URL."); }
  if (u.protocol !== "https:") throw new Error("Only https:// pages can be checked.");
  const h = u.hostname.replace(/\.$/, "");
  if (!h.includes(".") || /\.(localhost|local|internal)$/i.test(h) || /^[\d.]+$/.test(h) ||
      h.includes(":") || u.username || u.password || u.port) throw new Error("Only public HTTPS websites can be checked.");
  u.hash = "";
  return u;
}

async function readLimited(message, limit) {
  if (!message.body) return "";
  const reader = message.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new Error("Response exceeds the size limit.");
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); }
}

export function robotsAllows(txt, path, agent = "dealfactoryverifier") {
  const groups = [];
  let cur = null;
  for (const line of String(txt || "").split(/\r?\n/)) {
    const [k, ...rest] = line.replace(/#.*/, "").split(":");
    const key = k.trim().toLowerCase(), val = rest.join(":").trim();
    if (key === "user-agent") {
      if (!cur || cur.rules.length) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
    } else if ((key === "disallow" || key === "allow") && cur) cur.rules.push([key, val]);
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== "*" && agent.includes(a))) || groups.find((g) => g.agents.includes("*"));
  if (!mine) return true;
  let best = ["allow", ""];
  for (const [kind, pat] of mine.rules) {
    if (!pat) continue;
    const re = new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(path) && pat.length >= best[1].length) best = [kind, pat];
  }
  return best[0] === "allow";
}

async function allowedByRobots(u, fetcher) {
  let txt = robotsCache.get(u.host);
  if (txt === undefined) {
    try {
      const r = await fetcher(`${u.origin}/robots.txt`, { headers: { "user-agent": UA }, redirect: "error", signal: AbortSignal.timeout(8000) });
      if (!r.ok && ![404, 410].includes(r.status)) return false;
      txt = r.ok ? await readLimited(r, 200_000) : "";
    } catch { return false; }
    if (robotsCache.size >= 1024) robotsCache.delete(robotsCache.keys().next().value);
    robotsCache.set(u.host, txt);
  }
  return robotsAllows(txt, u.pathname + u.search);
}

export function pageText(html) {
  return String(html).replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&euro;/g, "€").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/\s+/g, " ").trim();
}

export function jsonLdOffers(html) {
  const out = [];
  const visit = (node, name) => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, name));
    if (!node || typeof node !== "object") return;
    const types = [].concat(node["@type"] || []).map(String);
    const nm = types.includes("Product") ? node.name || name : name;
    if (types.some((t) => /Offer$/.test(t))) {
      const price = node.price ?? node.lowPrice;
      if (price != null) out.push({ product: nm || null, price: Number(String(price).replace(",", ".")), currency: node.priceCurrency || null,
        availability: node.availability ? String(node.availability).replace(/^https?:\/\/schema\.org\//, "") : null });
    }
    for (const v of Object.values(node)) if (v && typeof v === "object") visit(v, nm);
  };
  for (const m of String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1].trim()), null); } catch { /* bad JSON-LD is common */ }
  }
  return out.filter((o) => Number.isFinite(o.price));
}

export async function verifyOnPage({ url, price, currency, quote }, fetcher = fetch, now = Date.now) {
  let u = safeUrl(url), r;
  for (let hop = 0; hop < 4; hop++) {
    if (!(await allowedByRobots(u, fetcher))) return { url: u.href, checked: false, reason: "Could not confirm the retailer permits this check." };
    const previous = lastHit.get(u.host) || 0;
    const start = Math.max(now(), previous + MIN_GAP_MS);
    if (start - now() > MIN_GAP_MS) return { url: u.href, checked: false, reason: "The shop is already being checked. Try again later." };
    if (lastHit.size >= 1024) lastHit.delete(lastHit.keys().next().value);
    lastHit.set(u.host, start);
    if (start > now()) await new Promise(resolve => setTimeout(resolve, start - now()));
    r = await fetcher(u.href, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
    if (![301, 302, 303, 307, 308].includes(r.status)) break;
    const next = r.headers.get("location");
    await r.body?.cancel();
    if (!next || hop === 3) throw new Error("The shop redirected too many times or omitted its destination.");
    u = safeUrl(new URL(next, u));
  }
  const retrievedAt = new Date(now()).toISOString();
  if (!r.ok) return { url: u.href, checked: false, http_status: r.status, retrieved_at: retrievedAt, reason: `The page answered ${r.status}. Treat its price as unknown.` };
  const html = await readLimited(r, MAX_BYTES);
  const text = pageText(html);
  const offers = jsonLdOffers(html);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
  const res = { url: r.url || u.href, checked: true, http_status: r.status, retrieved_at: retrievedAt, title, structured_offers: offers.slice(0, 10) };
  if (quote) {
    const needle = norm(quote).replace(/^[\s."'…]+|[\s."'…]+$/g, "");
    res.quote_on_page = !!needle && norm(text).includes(needle);
  }
  if (price != null) {
    const inLd = offers.some((o) => Math.abs(o.price - price) < 0.005 && (!currency || !o.currency || o.currency.toUpperCase() === currency.toUpperCase()));
    res.price_in_structured_data = inLd;
    res.price_in_text = priceInText(price, text);
    res.price_verified = inLd || res.price_in_text;
  }
  const bad = (quote && !res.quote_on_page) || (price != null && !res.price_verified);
  res.verdict = bad ? "NOT VERIFIED: don't state this as fact; say unknown or quote what the page does say." :
    (quote || price != null) ? `VERIFIED on the page at ${retrievedAt}. Cite the URL and date.` : "Page read. Use structured_offers or ask again with a price or quote.";
  if (text.length < 400 && !offers.length) res.note = "The page returned very little text (it may need JavaScript). Treat details as unknown.";
  return res;
}

function rules(country) {
  const c = country ? String(country).trim().toUpperCase().slice(0, 2) : null;
  return {
    rules: GUIDE,
    location: c ? { country: c, country_name: countryName(c, "en"), currency: currencyFor(c), language: languageFor(c) } : null,
    how_to_get_context: "If you don't have the user's Shopping Context yet, ask them to open DealFactory, set up what they own, and use “Open in Claude”, or paste their shopping-context.json.",
  };
}

// ------------------------------------------------------------------ MCP (JSON-RPC over Streamable HTTP)
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function handleRpc(msg, fetcher = fetch) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null; // notification
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return ok(id, { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "dealfactory", title: "DealFactory", version: VERSION }, instructions: INSTRUCTIONS });
    }
    case "ping": return ok(id, {});
    case "tools/list": return ok(id, { tools: TOOLS });
    case "tools/call": {
      const args = params?.arguments || {};
      try {
        let data;
        if (params?.name === "get_shopping_rules") data = rules(args.country);
        else if (params?.name === "verify_on_page") data = await verifyOnPage(args, fetcher);
        else return fail(id, -32602, `Unknown tool: ${params?.name}`);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(data, null, 1) }], structuredContent: data, isError: false });
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: `Could not check: ${e.message}` }], isError: true });
      }
    }
    default: return fail(id, -32601, `Method not found: ${method}`);
  }
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, authorization", "access-control-expose-headers": "mcp-session-id" };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(`DealFactory connector ${VERSION}. Add ${url.origin}/mcp as a custom connector in Claude.\n`, { headers: { "content-type": "text/plain", ...CORS } });
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404, headers: CORS });
    if (request.method === "GET") return new Response("This server answers POST only (no event stream).", { status: 405, headers: { allow: "POST", ...CORS } });
    if (request.method === "DELETE") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });
    let body;
    try { body = JSON.parse(await readLimited(request, 65536)); } catch { return Response.json(fail(null, -32700, "Invalid or oversized request"), { status: 400, headers: CORS }); }
    const batch = Array.isArray(body);
    if (batch && body.length > 8) return Response.json(fail(null, -32600, "Batch too large"), { status: 400, headers: CORS });
    const replies = (await Promise.all((batch ? body : [body]).map((m) => handleRpc(m)))).filter(Boolean);
    if (!replies.length) return new Response(null, { status: 202, headers: CORS });
    return Response.json(batch ? replies : replies[0], { headers: CORS });
  },
};
