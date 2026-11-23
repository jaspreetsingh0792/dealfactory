// Grounding: the code, not the model, decides what counts as a fact.
// Ported from the Python pipeline (src/dealfactory/llm.py, stages/_common.py, fetch.py).
//
//   source id unknown                      -> dropped / unknown
//   page text available, quote on page     -> "verified"
//   page text available, quote not on page -> unknown
//   only a search hit (no page text)       -> "cited" (weaker, shown with *)

export function norm(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[  ]/g, " ")
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|ref$)/i.test(k)) u.searchParams.delete(k);
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export class SourceRegistry {
  constructor() {
    this.byId = new Map();
    this.byUrl = new Map();
  }
  add(url, kind, title = null, text = null, retrievedAt = null) {
    const canon = canonUrl(url);
    if (!canon || !/^https?:/.test(canon)) return null;
    let s = this.byUrl.get(canon);
    if (!s) {
      s = { id: `S${this.byId.size + 1}`, url: canon, title: title || null, kind, texts: [],
            hasPage: false, retrievedAt: retrievedAt || new Date().toISOString() };
      this.byId.set(s.id, s);
      this.byUrl.set(canon, s);
    }
    if (title && !s.title) s.title = title;
    if (text) {
      s.texts.push(text);
      if (kind === "fetched_page") { s.hasPage = true; s.kind = "fetched_page"; }
    }
    return s;
  }
  get(id) {
    return id ? this.byId.get(String(id).trim()) || null : null;
  }
  get size() {
    return this.byId.size;
  }
  quoteOnPage(id, quote) {
    const s = this.get(id);
    if (!s || !quote) return false;
    const needle = norm(quote).replace(/^[\s."'…]+|[\s."'…]+$/g, "");
    return needle.length > 0 && norm(s.texts.join("\n")).includes(needle);
  }
  render() {
    return [...this.byId.values()]
      .map((s) => `${s.id} [${s.kind}${s.hasPage ? ", page read" : ""}] ${s.title || ""} ${s.url}`)
      .join("\n");
  }
  toJSON() {
    return [...this.byId.values()].map(({ texts, ...rest }) => ({ ...rest, evidenceChars: texts.join("").length }));
  }
}

// Anthropic response content: web_search_result, web_fetch_result, text citations.
export function harvestAnthropic(content, reg) {
  if (Array.isArray(content)) { for (const c of content) harvestAnthropic(c, reg); return; }
  if (!content || typeof content !== "object") return;
  const t = content.type;
  if (t === "web_search_result" && content.url) reg.add(content.url, "search_result", content.title);
  else if (t === "web_fetch_result" && content.url) {
    const doc = content.content || {};
    const src = doc.source || {};
    reg.add(content.url, "fetched_page", doc.title, src.type === "text" ? src.data : null, content.retrieved_at);
  } else if (t === "text") {
    for (const c of content.citations || []) if (c.url) reg.add(c.url, "citation", c.title, c.cited_text);
  }
  for (const v of Object.values(content)) if (v && typeof v === "object") harvestAnthropic(v, reg);
}

// OpenAI Responses API output: web_search_call sources + url_citation annotations (no page text).
export function harvestOpenAI(output, reg) {
  for (const item of output || []) {
    for (const s of item?.action?.sources || []) if (s.url) reg.add(s.url, "search_result", s.title);
    for (const c of item?.content || []) {
      for (const a of c.annotations || []) if (a.type === "url_citation" && a.url) reg.add(a.url, "citation", a.title);
    }
  }
}

const NUM = /\d+(?:[.,]\d+)?/g;

export function valueInQuote(value, quote) {
  const nums = String(value).match(NUM) || [];
  const q = norm(quote);
  if (nums.length) {
    const qn = new Set((q.match(NUM) || []).map((n) => n.replace(",", ".")));
    return nums.every((n) => qn.has(n.replace(",", ".")));
  }
  const words = (norm(value).match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 2);
  return words.length === 0 || words.some((w) => q.includes(w));
}

const PRICE_TOKEN = /\d[\d.,\s  ]*/g;

// True if `price` is visibly written in `text` (1.299,00 / 1299 / 299,- / 299.99 / 1 299,00).
export function priceInText(price, text) {
  if (price == null || !text) return false;
  for (const token of String(text).match(PRICE_TOKEN) || []) {
    const t = token.trim().replace(/[\s  ]/g, "");
    const cands = new Set();
    if (t.includes(",")) cands.add(t.replace(/\./g, "").replace(",", "."));
    cands.add(t.replace(/,/g, ""));
    for (let c of cands) {
      c = c.replace(/\.+$/, "");
      const v = Number(c);
      if (c && !Number.isNaN(v) && Math.abs(v - price) < 0.005) return true;
    }
  }
  return false;
}

function claim(reg, sourceId, quote, check) {
  const s = reg.get(sourceId);
  if (!s) return { status: "unknown", reason: "no valid source" };
  const base = { url: s.url, sourceId: s.id, retrievedAt: s.retrievedAt, quote: quote || null };
  if (s.hasPage) {
    if (quote && reg.quoteOnPage(s.id, quote) && check(quote)) return { status: "known", verification: "verified", ...base };
    return { status: "unknown", reason: "not found on the page that was read", url: s.url };
  }
  if (quote && !check(quote)) return { status: "unknown", reason: "quote does not contain the value", url: s.url };
  return { status: "known", verification: "cited", ...base };
}

const AMOUNT = /(?:€|eur\b|euro\b|\$|£|usd\b|gbp\b|chf\b|kr\b|zł|₹)\s?(\d[\d.,]*)|(\d[\d.,]*)\s?(?:€|euro\b|eur\b|usd\b|gbp\b|chf\b|kr\b|zł|₹)/gi;

function amountsIn(text) {
  const out = [];
  for (const m of String(text || "").matchAll(AMOUNT)) {
    const raw = (m[1] || m[2]).replace(/[.,]$/, "");
    const v = raw.includes(",") ? Number(raw.replace(/\./g, "").replace(",", ".")) : Number(raw.replace(/,/g, ""));
    if (!Number.isNaN(v)) out.push(v);
  }
  return out;
}

const COMPAT = new Set(["compatible", "incompatible", "unknown"]);

// Turn the model's DealsDraft into what the page shows. Nothing ungrounded is shown as a fact.
export function groundDeals(draft, reg, ctx) {
  const ownedIds = new Set((ctx.owned || []).map((o) => o.id));
  const picks = [];
  const dropped = [];
  const warnings = [];
  for (const p of draft.picks || []) {
    const specs = (p.specs || []).map((s) => ({
      name: s.name,
      ...(s.value == null ? { status: "unknown" } : claim(reg, s.source_id, s.quote, (q) => valueInQuote(s.value, q))),
      value: s.value,
    }));
    const offers = [];
    for (const o of p.offers || []) {
      const src = reg.get(o.source_id);
      if (!src) continue; // an offer must point at a page that was actually seen
      const price = o.price == null ? { status: "unknown" } : claim(reg, o.source_id, o.price_quote, (q) => priceInText(o.price, q));
      offers.push({
        retailer: hostOf(src.url) || o.retailer,
        retailerClaimed: o.retailer,
        url: src.url,
        sourceId: src.id,
        retrievedAt: src.retrievedAt,
        price: price.status === "known" ? o.price : null,
        currency: price.status === "known" ? o.currency : null,
        priceStatus: price.status,
        priceVerification: price.verification || null,
        priceQuote: o.price_quote,
        inStock: o.in_stock || "unknown",
      });
    }
    offers.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    const compat = (p.compatible_with || [])
      .filter((c) => ownedIds.has(c.owned_id))
      .map((c) => {
        const status = COMPAT.has(c.status) ? c.status : "unknown";
        if (status === "unknown") return { ownedId: c.owned_id, status: "unknown" };
        const g = claim(reg, c.source_id, c.evidence_quote, () => true);
        return g.status === "known" ? { ...g, ownedId: c.owned_id, status } : { ownedId: c.owned_id, status: "unknown", reason: g.reason };
      });
    const grounded = offers.length > 0 || specs.some((s) => s.status === "known");
    if (!grounded) {
      dropped.push({ product: p.product_name, reason: "no source page for this product was found in the research" });
      continue;
    }
    const known = offers.filter((o) => o.price != null).map((o) => o.price);
    const budget = ctx._budget ?? null;
    for (const v of amountsIn(p.why_it_fits)) {
      if (!known.some((k) => Math.abs(k - v) <= 1) && !(budget != null && Math.abs(budget - v) <= 1)) {
        warnings.push(`"${p.product_name}": the explanation mentions ${v}, which is not a verified price.`);
      }
    }
    picks.push({
      role: p.role,
      product: p.product_name,
      brand: p.brand,
      model: p.model,
      whyItFits: p.why_it_fits,
      tradeoffs: p.tradeoffs || [],
      specs,
      offers,
      compat,
    });
  }
  const tops = picks.filter((p) => p.role === "top").length;
  if (picks.length && tops !== 1) warnings.push(tops === 0 ? "No top pick survived the source checks." : "More than one top pick.");
  return { picks, dropped, warnings, caveats: draft.caveats || [], notRecommended: draft.not_recommended || [] };
}
