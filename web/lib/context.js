// Shopping Context v1 (spec/shopping-context.md): create, validate, merge, export, import.

export const GUIDE = `How to use this shopping context (for AI assistants):
- Recommend products that work with what the user already owns (\`owned\`) and fit their home and
  household (\`facts\`). Say explicitly which owned item a product is compatible with, and how you know.
- Facts with status \`unconfirmed\` or source \`inferred\` may be wrong: use them, but say so.
- Never invent products, specs, prices or links. Every price and spec needs a source page you actually
  read, with the date. If you could not verify something, say "unknown".
- Keep sourced facts separate from your own judgement, and label the judgement.
- Search shops that deliver to \`location\` and quote prices in the local currency.`;

const SOURCES = new Set(["stated", "email", "receipt", "inferred", "example"]);
const STATUSES = new Set(["confirmed", "unconfirmed", "rejected"]);
const NEED_STATUSES = new Set(["active", "paused", "closed"]);

export const SUGGESTED_FACTS = [
  ["ecosystems.smart_home", "Smart home", "Apple Home, Google Home, Home Assistant, Hue…"],
  ["ecosystems.protocols", "Protocols & hubs", "Matter, Thread, Zigbee, Hue Bridge…"],
  ["home.heating", "Boiler / heating", "OpenTherm (Intergas, Remeha), on/off, district…"],
  ["home.type", "Home type", "apartment, house, studio…"],
  ["home.size_m2", "Home size (m²)", "75"],
  ["home.floor_types", "Floors", "laminate, tiles, carpet"],
  ["ecosystems.phone_os", "Phone", "iPhone, Android"],
  ["household.children", "Children", "toddler 18 months"],
  ["household.pets", "Pets", "cat (sheds a lot)"],
  ["preferences.condition", "New or used", "new only / second-hand OK"],
  ["preferences.priorities", "What matters most", "local control, quiet, repairable, no subscription…"],
  ["preferences.avoided_retailers", "Shops to avoid", ""],
];

export function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

export function slug(text) {
  return String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "item";
}

export function uniqueId(base, taken) {
  let id = slug(base), n = 2;
  while (taken.has(id)) id = `${slug(base)}-${n++}`;
  return id;
}

export function emptyContext() {
  return { format: "shopping-context", version: 1, updated_at: nowIso(), generator: "dealfactory-web",
           location: {}, facts: [], owned: [], needs: [] };
}

const str = (v, max = 300) => (v == null || v === "" ? null : String(v).slice(0, max));
const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const clamp01 = (v) => (num(v) == null ? null : Math.min(1, Math.max(0, Number(v))));

function factValue(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map((x) => String(x).slice(0, 200)).slice(0, 30);
  if (["string", "number", "boolean"].includes(typeof v)) return typeof v === "string" ? v.slice(0, 500) : v;
  return String(JSON.stringify(v)).slice(0, 500);
}

// Lenient parse + strict shape. `fromAssistant` marks everything as an unconfirmed inference.
export function normalizeContext(raw, { fromAssistant = false } = {}) {
  if (!raw || typeof raw !== "object") throw new Error("Not a JSON object.");
  if (raw.format && raw.format !== "shopping-context") throw new Error(`Unknown format "${raw.format}".`);
  if (raw.version && Number(raw.version) !== 1) throw new Error(`Unsupported version ${raw.version}.`);
  const ctx = emptyContext();
  ctx.updated_at = str(raw.updated_at, 40) || nowIso();
  ctx.generator = str(raw.generator, 80);
  const loc = raw.location || {};
  ctx.location = Object.fromEntries(
    Object.entries({ country: str(loc.country, 2)?.toUpperCase(), city: str(loc.city, 100), region: str(loc.region, 100),
                     currency: str(loc.currency, 3)?.toUpperCase(), language: str(loc.language, 20) })
      .filter(([, v]) => v));
  const prov = (o) => {
    const source = fromAssistant ? "inferred" : SOURCES.has(o.source) ? o.source : "stated";
    const status = fromAssistant ? "unconfirmed" : STATUSES.has(o.status) ? o.status : "confirmed";
    return { source, status, confidence: clamp01(o.confidence) ?? (source === "inferred" ? 0.5 : 1) };
  };
  const seen = new Set();
  for (const f of Array.isArray(raw.facts) ? raw.facts.slice(0, 200) : []) {
    const id = str(f?.id, 80);
    if (!id || seen.has(id) || !/^[a-z0-9_]+(\.[a-z0-9_]+)*$/i.test(id)) continue;
    seen.add(id);
    ctx.facts.push({ id, value: factValue(f.value), ...prov(f), note: str(f.note) });
  }
  const ownedIds = new Set();
  for (const o of Array.isArray(raw.owned) ? raw.owned.slice(0, 300) : []) {
    if (!o || !(o.brand || o.model || o.category)) continue;
    const id = uniqueId(o.id || `${o.brand || ""} ${o.model || o.category}`, ownedIds);
    ownedIds.add(id);
    ctx.owned.push({ id, category: str(o.category, 60) || "other", brand: str(o.brand, 80) || "(brand unknown)",
                     model: str(o.model, 120) || "(model unknown)", variant: str(o.variant, 80), year: num(o.year),
                     room: str(o.room, 60), aliases: Array.isArray(o.aliases) ? o.aliases.map((a) => String(a).slice(0, 60)).slice(0, 10) : [],
                     purchase_date: str(o.purchase_date, 10), notes: str(o.notes), ...prov(o) });
  }
  const needIds = new Set();
  for (const n of Array.isArray(raw.needs) ? raw.needs.slice(0, 100) : []) {
    const text = str(n?.text, 300);
    if (!text) continue;
    const id = uniqueId(n.id || text, needIds);
    needIds.add(id);
    ctx.needs.push({ id, text, status: NEED_STATUSES.has(n.status) ? n.status : "active", budget_max: num(n.budget_max),
                     currency: str(n.currency, 3), deadline: str(n.deadline, 10), notes: str(n.notes) });
  }
  return ctx;
}

// Extract the JSON object from an assistant's reply (it may wrap it in prose or ```json fences).
export function parseAssistantReply(text) {
  const t = String(text || "");
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object found in the pasted text.");
  return JSON.parse(body.slice(start, end + 1));
}

// Imported items never overwrite what the user stated or confirmed.
export function mergeContext(base, incoming) {
  const out = structuredClone(base);
  const changes = { facts: 0, owned: 0, needs: 0, location: 0 };
  for (const [k, v] of Object.entries(incoming.location || {})) {
    if (!out.location[k]) { out.location[k] = v; changes.location++; }
  }
  const facts = new Map(out.facts.map((f) => [f.id, f]));
  for (const f of incoming.facts) {
    const cur = facts.get(f.id);
    if (cur && (cur.status === "confirmed" || cur.status === "rejected")) continue;
    facts.set(f.id, f);
    changes.facts++;
  }
  out.facts = [...facts.values()];
  const key = (o) => `${o.brand} ${o.model}`.toLowerCase().replace(/\s+/g, " ");
  const ownedKeys = new Set(out.owned.map(key));
  const ownedIds = new Set(out.owned.map((o) => o.id));
  for (const o of incoming.owned) {
    if (ownedKeys.has(key(o))) continue;
    const id = uniqueId(o.id, ownedIds);
    ownedIds.add(id);
    ownedKeys.add(key(o));
    out.owned.push({ ...o, id });
    changes.owned++;
  }
  const needTexts = new Set(out.needs.map((n) => n.text.toLowerCase()));
  const needIds = new Set(out.needs.map((n) => n.id));
  for (const n of incoming.needs) {
    if (needTexts.has(n.text.toLowerCase())) continue;
    const id = uniqueId(n.id, needIds);
    needIds.add(id);
    out.needs.push({ ...n, id });
    changes.needs++;
  }
  out.updated_at = nowIso();
  return { context: out, changes };
}

// What leaves the browser: no rejected items, and nothing marked private.
export function shareable(ctx) {
  const c = structuredClone(ctx);
  c.location = Object.fromEntries(Object.entries(c.location || {}).filter(([k, v]) => !k.startsWith("_") && v));
  c.facts = c.facts.filter((f) => f.status !== "rejected" && !f.private);
  c.owned = c.owned.filter((o) => o.status !== "rejected");
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));
  c.facts = c.facts.map(strip);
  c.owned = c.owned.map(strip);
  c.needs = c.needs.map(strip);
  return c;
}

export function exportPrompt(ctx, needText = null) {
  return `I'm sharing my Shopping Context (an open JSON format from DealFactory). Use it whenever I ask about buying something.

${GUIDE}

\`\`\`json
${JSON.stringify(shareable(ctx), null, 2)}
\`\`\`
${needText ? `\nMy question: find the best options for "${needText}" near ${[ctx.location.city, ctx.location.country].filter(Boolean).join(", ") || "me"}, with current prices from shops that deliver to me. For each pick, say how it fits what I own, link the pages you used, and mark anything you could not verify as unknown.` : ""}`;
}

export const IMPORT_PROMPT = `From what you already know about me (our past conversations and your memory), fill in my Shopping Context in exactly this JSON format. Include only things you actually know or have good reason to believe. Don't guess brands or models you don't know. Put your reason in "note" and a confidence from 0 to 1. Reply with the JSON only.

{
  "format": "shopping-context",
  "version": 1,
  "location": {"country": "NL", "city": "Utrecht", "currency": "EUR", "language": "nl"},
  "facts": [
    {"id": "home.type", "value": "apartment", "source": "inferred", "confidence": 0.8, "status": "unconfirmed", "note": "why you think so"}
  ],
  "owned": [
    {"id": "stroller-cybex-balios", "category": "stroller", "brand": "Cybex", "model": "Balios S Lux", "aliases": ["my stroller"], "source": "inferred", "confidence": 0.9, "status": "unconfirmed"}
  ],
  "needs": [
    {"id": "robot-vacuum", "text": "robot vacuum for my apartment", "status": "active", "budget_max": 600}
  ]
}

Useful fact ids: home.type, home.size_m2, home.floor_types, home.floors_in_home, household.adults, household.children, household.pets, ecosystems.smart_home, ecosystems.phone_os, ecosystems.computer_os, preferences.condition, preferences.priorities, preferences.preferred_retailers, preferences.avoided_retailers, constraints.<anything>.`;
