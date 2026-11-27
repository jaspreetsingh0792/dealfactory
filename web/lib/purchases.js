// Purchase import in the browser (port of src/dealfactory/imports/*.py and inventory.py).
//
//   Gmail (read-only token) -> message text -> redact personal details -> skip if no price ->
//   your AI extracts items -> code keeps only items whose quote is in the text -> owned items + habits,
//   all "unconfirmed" until you confirm them.
//
// Only extracted fields are kept (in this browser). The email text is never stored, and the audit log
// replaces it with a short "document omitted" note.

import { norm, priceInText } from "./ground.js";

// ------------------------------------------------------------------ redaction
const MAX_CHARS = 12000;
const EMAIL = /[\p{L}\p{N}._+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;
const PHONE = /(?<![\p{L}\p{N}_€])(?:\+|00)\d{1,3}[\s-]?\(?\d\)?(?:[\s-]?\d){7,10}(?!\d)|(?<![\p{L}\p{N}_€,.])0\d(?:[\s-]?\d){8}(?!\d)/gu;
const IBAN = /\b[A-Z]{2}\d{2}\s?[A-Z]{4}(?:\s?\d){10}\b/g;
const CARD = /(?:\*{2,}|x{4,}|•{2,})\s?\d{4}\b|(?:eindigend op|ending in|ending with)\s+\d{4}/gi;
const REF_LABEL = /((?:order|bestel|factuur|invoice|klant|customer|account|track(?:ing)?|zending|pakket|transactie|referentie|reference|bon|receipt)[\w &-]{0,20}?(?:nummer|number|nr|no|id|code|#)?\.?\s*[:#]\s*)([A-Z0-9][\w-]{3,})/gi;
const LONG_NUMBER = /\b\d{9,}\b|\b\d{3}-\d{7}-\d{7}\b/g;
const GREETING = /^(\s*(?:beste|hallo|hoi|hi|hello|dear|geachte|goedemiddag|goedemorgen|goedenavond)\s+)([^\n,!]{1,40})/gim;
const ADDRESS_HEADER = /^\s*(?:bezorg|aflever|verzend|factuur|lever|post)?(?:adres|address)\b.*$|^\s*(?:shipping|delivery|billing|invoice|ship to|deliver to|bill to)\b.*$/i;
const POSTCODE_CITY = /^\s*\d{4}\s?[A-Z]{2}\b[\s,]+[A-Za-zÀ-ÿ' .-]{2,40}$/;
const STREET = /^\s*[A-Za-zÀ-ÿ' .-]{3,40}\s\d{1,5}\s?[a-zA-Z]?(?:[-/ ]\d{1,4}[a-zA-Z]?)?\s*$/;

function redactAddressBlocks(lines) {
  const out = [...lines];
  lines.forEach((line, i) => {
    if (ADDRESS_HEADER.test(line) && line.length < 60) {
      let taken = 0;
      for (let j = i + 1; j < lines.length && taken < 4; j++) {
        if (lines[j].trim()) { out[j] = "[address]"; taken++; } else if (taken) break;
      }
    }
  });
  lines.forEach((line, i) => {
    if (!POSTCODE_CITY.test(line)) return;
    out[i] = "[address]";
    if (i >= 1 && STREET.test(lines[i - 1])) out[i - 1] = "[address]";
    if (i >= 2 && (STREET.test(lines[i - 2]) || (STREET.test(lines[i - 1] || "") && lines[i - 2].split(/\s+/).length <= 4 && !/\d/.test(lines[i - 2])))) out[i - 2] = "[address]";
  });
  return out;
}

export function redact(text, extraTerms = []) {
  let t = String(text || "").replace(/\r\n?/g, "\n");
  for (const term of extraTerms) {
    if (term && term.length >= 3) t = t.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[name]");
  }
  t = t.replace(EMAIL, "[email]").replace(URL_RE, "[link]").replace(IBAN, "[iban]").replace(CARD, "[card]")
    .replace(REF_LABEL, (_, a) => `${a}[ref]`).replace(LONG_NUMBER, "[number]").replace(PHONE, "[phone]")
    .replace(GREETING, (_, a) => `${a}[name]`);
  t = redactAddressBlocks(t.split("\n")).join("\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
  return t.slice(0, MAX_CHARS);
}

const PRICE_HINT = /€|\bEUR\b|\bUSD\b|\$|£|₹|\bkr\b|\b\d+,\d{2}\b|\b\d+,-|\b\d+\.\d{2}\b/;
export const looksLikeItHasPrices = (text) => PRICE_HINT.test(text || "");

// ------------------------------------------------------------------ Gmail message -> text
export const GMAIL_QUERY = '(category:purchases OR subject:(bestelling OR bestelbevestiging OR orderbevestiging OR factuur OR ' +
  'kassabon OR "je order" OR "uw order" OR "your order" OR "order confirmation" OR invoice OR receipt OR ' +
  'verzonden OR shipped OR retour OR return OR bestellung OR commande OR pedido OR ordine)) ' +
  '-category:promotions -category:social -in:chats -in:spam';

function b64url(data) {
  const bin = atob(String(data || "").replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function safeCodePoint(n) {
  const cp = Number(n);
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10FFFF && (cp < 0xD800 || cp > 0xDFFF) ? String.fromCodePoint(cp) : " ";
}

// Plain text from HTML without running or loading anything (no DOM needed, works in node tests too).
export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n").replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&euro;/gi, "€").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => safeCodePoint(n))
    .replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function messageToDoc(msg) {
  const headers = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
  let plain = "", html = "";
  const walk = (part) => {
    if (!part) return;
    const type = (part.mimeType || "").toLowerCase();
    if (part.body?.data && !part.filename) {
      if (type === "text/plain" && !plain) plain = b64url(part.body.data);
      else if (type === "text/html" && !html) html = b64url(part.body.data);
    }
    (part.parts || []).forEach(walk);
  };
  walk(msg.payload);
  const from = headers.from || "";
  const domain = (from.match(/@([\w.-]+)/) || [])[1]?.toLowerCase().replace(/^(mail|email|e|info|noreply|no-reply|news)\./, "") || null;
  const date = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString().slice(0, 10) : null;
  // HTML usually carries the order table; plain text is often a stub.
  const text = html ? htmlToText(html) : plain;
  return { id: msg.id, subject: headers.subject || "", senderDomain: domain, date, text };
}

// ------------------------------------------------------------------ extraction schema + prompt
const KINDS = ["durable", "accessory", "consumable", "clothing", "service", "gift_card", "other"];
const DOC_TYPES = ["order_confirmation", "shipping", "invoice", "receipt", "return", "cancellation", "other"];
const nullable = (t) => ({ type: [t, "null"] });

export const PURCHASE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["is_purchase", "doc_type", "merchant", "order_date", "currency", "items"],
  properties: {
    is_purchase: { type: "boolean" },
    doc_type: { type: "string", enum: DOC_TYPES },
    merchant: nullable("string"),
    order_date: nullable("string"),
    currency: nullable("string"),
    items: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["product_name", "quote", "brand", "model", "variant", "category", "kind", "quantity", "unit_price"],
      properties: {
        product_name: { type: "string" }, quote: { type: "string" },
        brand: nullable("string"), model: nullable("string"), variant: nullable("string"),
        category: { type: "string" }, kind: { type: "string", enum: KINDS },
        quantity: { type: "integer" }, unit_price: nullable("number"),
      } } },
  },
};

export const PURCHASE_SYSTEM = `You read one shopping document (an order confirmation, shipping notice, invoice, return confirmation or a
shop receipt) and list the products in it, for the user's private inventory of things they own and buy.

Rules:
- Use only what is written in the document. Never guess a brand, model or price that is not written.
- product_name and quote are copied verbatim from the document; quote is the line naming the product.
- brand / model / variant: fill only if those exact words are in the document, otherwise null.
- unit_price: the price per item exactly as shown (as a number, e.g. 1299.0); null if no price is shown.
- currency: ISO code (EUR, USD, GBP, INR...) if shown, else null.
- order_date: YYYY-MM-DD if a date is written, else null.
- category: short generic English slug (thermostat, hub, sensor, filter, tv, soundbar ...).
- kind: durable (appliances, electronics, hubs, tools), accessory (for something owned:
  mounts, filters, cables), consumable (cleaning products, filters that wear out), clothing,
  service (subscriptions, delivery fees, warranties), gift_card, other. Skip shipping/payment fee lines.
- is_purchase=false for marketing, newsletters, price alerts, wishlists, abandoned carts, review requests
  and anything that is not about a concrete order. Then return no items.
- For returns and cancellations, set doc_type accordingly and list the returned/cancelled items.
- Placeholders like [address], [email], [ref], [name] hide personal data; ignore them.`;

export function purchasePrompt(doc, text) {
  return [`Document kind: email`, doc.senderDomain ? `Sender domain: ${doc.senderDomain}` : null,
    doc.date ? `Received: ${doc.date}` : null, doc.subject ? `Subject: ${redact(doc.subject)}` : null]
    .filter(Boolean).join("\n") + `\n\nDOCUMENT\n${text}`;
}

// ------------------------------------------------------------------ grounding
const slugify = (...parts) => norm(parts.filter(Boolean).join(" ")).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const inText = (needle, tn) => !!needle && tn.includes(norm(needle));

function plausibleDate(value, fallback) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(+d)) return fallback;
    if (fallback) return Math.abs(d - new Date(`${fallback}T00:00:00Z`)) <= 90 * 864e5 ? value : fallback;
    if (d >= new Date("2000-01-01") && d <= new Date()) return value;
  }
  return fallback;
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Keep only items whose quote is in the redacted text; drop brand/model/price that are not there.
export function groundPurchase(draft, doc, text, ref) {
  if (!draft?.is_purchase || draft.doc_type === "other") return [];
  const tn = norm(text);
  const merchant = (inText(draft.merchant, tn) ? draft.merchant : null) || doc.senderDomain || null;
  const orderDate = plausibleDate(draft.order_date, doc.date);
  const out = [];
  (draft.items || []).forEach((it, i) => {
    if (!inText(it.quote, tn)) return; // not in the document: invented or paraphrased
    const name = inText(it.product_name, tn) ? it.product_name : it.quote.trim();
    const verified = it.unit_price != null && (priceInText(it.unit_price, it.quote) || priceInText(it.unit_price, text));
    out.push({
      id: `${slugify(merchant || "shop", name).slice(0, 50)}-${ref.slice(0, 4)}${i}`,
      sourceKind: "email", sourceRef: ref, docType: draft.doc_type, merchant, orderDate,
      productName: name.slice(0, 200),
      brand: inText(it.brand, tn) ? it.brand : null,
      model: inText(it.model, tn) ? it.model : null,
      variant: inText(it.variant, tn) ? it.variant : null,
      category: slugify(it.category) || "other", kind: KINDS.includes(it.kind) ? it.kind : "other",
      quantity: Math.max(1, it.quantity || 1),
      unitPrice: verified ? it.unit_price : null, currency: verified ? draft.currency || null : null,
      priceVerified: !!verified, status: "unconfirmed", extractedAt: new Date().toISOString(),
    });
  });
  return out;
}

// ------------------------------------------------------------------ purchases -> Shopping Context
const keyOf = (p) => (p.model ? slugify(p.brand, p.model) : slugify(p.productName));
function active(purchases) {
  const returned = new Set(purchases.filter((p) => ["return", "cancellation"].includes(p.docType)).map((p) => `${p.merchant}|${keyOf(p)}`));
  return purchases.filter((p) => p.status !== "rejected" && !["return", "cancellation"].includes(p.docType) && !returned.has(`${p.merchant}|${keyOf(p)}`));
}
const tokens = (...parts) => new Set(norm(parts.filter(Boolean).join(" ")).match(/[a-z0-9]+/g) || []);

// Returns owned items and habit facts to merge into the context (marked inferred/unconfirmed).
export function contextFromPurchases(purchases, existingOwned = []) {
  const acts = active(purchases);
  const owned = new Map();
  for (const p of acts) {
    if (!["durable", "accessory"].includes(p.kind)) continue;
    const have = tokens(p.brand, p.model, p.productName);
    const dup = existingOwned.some((e) => {
      if (String(e.id).startsWith("imp-")) return false;
      const want = tokens(e.brand, e.model);
      want.delete("model"); want.delete("unknown");
      return want.size && [...want].every((w) => have.has(w));
    });
    if (dup) continue;
    const id = `imp-${keyOf(p)}`.slice(0, 64);
    const prev = owned.get(id);
    if (prev && (prev.purchase_date || "") <= (p.orderDate || "")) continue;
    owned.set(id, {
      id, category: p.category, brand: p.brand || "(brand not stated)", model: p.model || p.productName,
      ...(p.variant ? { variant: p.variant } : {}), aliases: [`my ${p.category.replace(/-/g, " ")}`],
      ...(p.orderDate ? { purchase_date: p.orderDate } : {}), ...(p.merchant ? { retailer: p.merchant } : {}),
      notes: `Imported from a purchase email: "${p.productName}"${p.kind === "accessory" ? " (accessory)" : ""}`,
      source: "email", status: p.status === "confirmed" ? "confirmed" : "unconfirmed",
      confidence: p.brand && p.model ? 0.75 : 0.6,
    });
  }
  const facts = [];
  const orders = new Map();
  for (const p of acts) if (p.merchant) orders.set(p.merchant, (orders.get(p.merchant) || new Set()).add(p.sourceRef));
  if (orders.size) {
    const ranked = [...orders].sort((a, b) => b[1].size - a[1].size).slice(0, 6);
    facts.push({ id: "habits.shops_at", value: ranked.map(([m]) => m), source: "email", status: "unconfirmed", confidence: 0.6,
      note: `Orders seen: ${ranked.map(([m, r]) => `${m} ${r.size}`).join(", ")}` });
  }
  const dates = new Map();
  for (const p of acts) if (["consumable", "accessory", "clothing"].includes(p.kind) && p.orderDate) {
    dates.set(p.category, (dates.get(p.category) || new Set()).add(p.orderDate));
  }
  const repeats = [];
  for (const [cat, ds] of [...dates].sort()) {
    if (ds.size < 3) continue;
    const d = [...ds].sort().map((x) => new Date(`${x}T00:00:00Z`));
    const gaps = d.slice(1).map((x, i) => (x - d[i]) / 864e5).sort((a, b) => a - b);
    const mid = gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
    repeats.push(`${cat}: about every ${Math.round(mid)} days (${d.length} orders, last ${[...ds].sort().at(-1)})`);
  }
  if (repeats.length) facts.push({ id: "habits.repeat_purchases", value: repeats, source: "email", status: "unconfirmed", confidence: 0.6,
    note: "Computed from imported purchase dates" });
  return { owned: [...owned.values()], facts };
}

// ------------------------------------------------------------------ the import run
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

const GMAIL_BACKOFF_MS = [200, 400, 800];

function waitMs(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

async function gget(token, path, signal, onRetry) {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
    const r = await fetch(`${GMAIL}${path}`, { headers: { authorization: `Bearer ${token}` }, signal });
    if (r.status === 401) throw new Error("Google sign-in expired. Connect Gmail again.");
    if ((r.status === 429 || r.status >= 500) && attempt < GMAIL_BACKOFF_MS.length) {
      const seconds = Math.max(1, Math.round(GMAIL_BACKOFF_MS[attempt] / 1000));
      onRetry?.(`Gmail is busy, retrying in ${seconds}s`);
      await waitMs(GMAIL_BACKOFF_MS[attempt], signal);
      continue;
    }
    if (!r.ok) throw new Error(`Gmail said ${r.status}`);
    return r.json();
  }
}

function progressText(text) {
  const value = String(text || "");
  if (!value || value.length > 180 || /@/.test(value)) return "Working on the import…";
  return value;
}

// llm: client() from llm.js (needs .structured). seenRefs: Set of sha256 refs already imported.
export async function importGmail({ token, llm, since = "2y", max = 100, seenRefs = new Set(), extraTerms = [],
                                    providerLabel = "your AI", onStep = () => {}, signal } = {}) {
  const report = { listed: 0, skippedSeen: 0, skippedNoPrice: 0, notPurchase: 0, failed: 0, purchases: [], refs: [], audit: [] };
  const ids = [];
  let page = null;
  let value = 0;
  let total = 1;
  const label = progressText(String(providerLabel || "your AI").replace(/@.*/, "")) === "Working on the import…"
    ? "your AI" : String(providerLabel || "your AI").replace(/@.*/, "").slice(0, 80);
  const step = (text, next = value, nextTotal = total, phase = "work") => {
    value = next;
    total = nextTotal;
    onStep({ phase, text: progressText(text), value, max: total });
  };
  const onRetry = (text) => step(text, value, total, "retry");
  try {
  // The user's own address and its name part are redacted too (emails often greet you by it).
  // If the profile cannot be read, stop before any receipt is sent to an AI provider.
  let me = "";
  try {
    me = (await gget(token, "/profile", signal, onRetry)).emailAddress || "";
  } catch (e) {
    if (e.name === "AbortError" || /expired/.test(e.message)) throw e;
    throw new Error("Gmail profile could not be read, so the import stopped before any receipt was sent to your AI.");
  }
  if (!me) throw new Error("Gmail profile could not be read, so the import stopped before any receipt was sent to your AI.");
  const local = me.split("@")[0];
  extraTerms = [...extraTerms, me, ...local.split(/[._+-]/).filter((w) => w.length >= 3 && !/^\d+$/.test(w))];
  step("Searching receipts (0 found)", 0, 1, "search");
  do {
    const q = encodeURIComponent(`${GMAIL_QUERY} newer_than:${since}`);
    const res = await gget(token, `/messages?q=${q}&maxResults=${Math.min(100, max - ids.length)}${page ? `&pageToken=${page}` : ""}`, signal, onRetry);
    ids.push(...(res.messages || []).map((m) => m.id));
    page = res.nextPageToken;
    step(`Searching receipts (${ids.length} found)`, 0, Math.max(ids.length, 1), "search");
  } while (page && ids.length < max);
  report.listed = ids.length;
  for (const [n, id] of ids.entries()) {
    signal?.throwIfAborted();
    const ref = await sha256(`gmail:${id}`);
    if (seenRefs.has(ref)) { report.skippedSeen++; step(`Reading message ${n + 1} of ${ids.length}`, n + 1, ids.length, "read"); continue; }
    step(`Reading message ${n + 1} of ${ids.length}`, n, ids.length, "read");
    try {
      const doc = messageToDoc(await gget(token, `/messages/${id}?format=full`, signal, onRetry));
      const text = redact(doc.text, extraTerms);
      report.refs.push(ref);
      if (!looksLikeItHasPrices(text)) { report.skippedNoPrice++; step(`Reading message ${n + 1} of ${ids.length}`, n + 1, ids.length, "read"); continue; }
      const sub = [];
      step(`Extracting items with ${label} (${n + 1} of ${ids.length})`, n + 0.5, ids.length, "extract");
      const draft = await llm.structured({ system: PURCHASE_SYSTEM, prompt: purchasePrompt(doc, text), schema: PURCHASE_SCHEMA,
        audit: sub, signal, stage: "purchase" });
      // Audit without the email: keep what the model returned, never what it was sent.
      report.audit.push({ stage: "purchase", prompt: `<email omitted: ${doc.senderDomain || "?"} ${doc.date || ""}, ${text.length} chars after redaction>`, response: draft });
      const items = groundPurchase(draft, doc, text, ref);
      if (!items.length) report.notPurchase++;
      report.purchases.push(...items);
      step(`Extracting items with ${label} (${n + 1} of ${ids.length})`, n + 1, ids.length, "extract");
    } catch (e) {
      if (e.name === "AbortError") throw e;
      report.failed++;
      report.lastError = progressText(e.message);
      if (/expired|401|403/.test(e.message)) throw e;
    }
  }
  return report;
  } catch (e) {
    if (e?.name === "AbortError") e.partial = report;
    throw e;
  }
}
