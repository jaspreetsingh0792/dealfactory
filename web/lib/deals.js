// One need -> research (with web search) -> structured picks -> grounding. Or, for models without
// web search, a buying checklist with search links (no product or price claims at all).

import { shareable } from "./context.js";
import { groundDeals, SourceRegistry } from "./ground.js";

const nullable = (type) => ({ type: [type, "null"] });
const obj = (properties) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
const arr = (items) => ({ type: "array", items });

export const DEALS_SCHEMA = obj({
  picks: arr(obj({
    role: { type: "string", enum: ["top", "budget", "premium", "alternative"] },
    product_name: { type: "string" },
    brand: nullable("string"),
    model: nullable("string"),
    why_it_fits: { type: "string", description: "Your judgement: why this suits this user's home and owned products" },
    tradeoffs: arr({ type: "string" }),
    compatible_with: arr(obj({
      owned_id: { type: "string" },
      status: { type: "string", enum: ["compatible", "incompatible", "unknown"] },
      evidence_quote: nullable("string"),
      source_id: nullable("string"),
    })),
    specs: arr(obj({ name: { type: "string" }, value: nullable("string"), quote: nullable("string"), source_id: nullable("string") })),
    offers: arr(obj({
      retailer: { type: "string" },
      price: nullable("number"),
      currency: nullable("string"),
      price_quote: nullable("string"),
      source_id: nullable("string"),
      in_stock: { type: "string", enum: ["yes", "no", "unknown"] },
    })),
  })),
  not_recommended: arr(obj({ product_name: { type: "string" }, reason: { type: "string" } })),
  caveats: arr({ type: "string" }),
});

export const CHECKLIST_SCHEMA = obj({
  must_have: arr({ type: "string" }),
  nice_to_have: arr({ type: "string" }),
  avoid: arr({ type: "string" }),
  compatibility_checks: arr(obj({ owned_id: nullable("string"), check: { type: "string" } })),
  questions_for_you: arr({ type: "string" }),
  search_terms: arr({ type: "string" }),
});

const RULES = `Ground rules:
- Never invent products, model numbers, specs, prices or links. If you did not see it on a page in this
  conversation, it is unknown.
- Report values exactly as the page states them. Quotes are short verbatim snippets from the page.
- Keep facts (with the page they came from) separate from your judgement.
- Prefer manufacturer pages and independent reviews over marketing copy and affiliate listicles.`;

function where(loc) {
  return [loc.city, loc.region, loc.country].filter(Boolean).join(", ") || "the user's country (unknown)";
}

export function researchPrompts(ctx, need) {
  const system = `You are DealFactory, a shopping researcher working for one person.\n${RULES}`;
  const prompt = `Find the best products for this need, sold right now by shops that deliver to ${where(ctx.location)}.

NEED: ${need.text}${need.budget_max ? `\nBUDGET: up to ${need.budget_max} ${need.currency || ctx.location.currency || ""}` : ""}${need.notes ? `\nNOTES: ${need.notes}` : ""}

THE USER'S SHOPPING CONTEXT (what they own, their home, preferences):
${JSON.stringify(shareable({ ...ctx, needs: [] }), null, 1)}

How to work:
1. Search for current expert reviews / buying guides for this category in ${ctx.location.country || "the user's country"} and pick 3-5 strong candidates that fit the context.
2. For anything in the need that refers to something they own (e.g. "for my stroller"), check compatibility on the manufacturer's page.
3. For each candidate, open at least one product page at a shop that delivers to ${ctx.location.country || "them"} and note the current price, currency and stock.
4. Write notes: for every product, list each page URL you used and copy the exact text for the price, key specs and compatibility statements.`;
  return { system, prompt };
}

export function structurePrompts(ctx, need, registry, notes) {
  const system = `You turn research notes into JSON for DealFactory.\n${RULES}
Cite only source ids from the SOURCES list (S1, S2...). Never write URLs. If a value is not supported by one of
those sources, set it to null. Offers must cite the retailer's product page as source_id.
Return up to 4 picks with exactly one "top"; "budget", "premium" and "alternative" are optional.
compatible_with.owned_id must be an id from OWNED. why_it_fits is your judgement and should refer to the user's
owned products and facts by name; do not state prices in it.`;
  const owned = (ctx.owned || []).filter((o) => o.status !== "rejected")
    .map((o) => `- ${o.id}: ${o.brand} ${o.model} [${o.category}]${o.status === "unconfirmed" ? " (unconfirmed)" : ""}`).join("\n");
  const prompt = `NEED: ${need.text}${need.budget_max ? ` (budget ${need.budget_max} ${need.currency || ctx.location.currency || ""})` : ""}
LOCATION: ${where(ctx.location)}

OWNED:
${owned || "(nothing listed)"}

SOURCES:
${registry.render() || "(none)"}

RESEARCH NOTES:
${notes}`;
  return { system, prompt };
}

export function checklistPrompts(ctx, need) {
  return {
    system: `You help one person decide what to look for when buying something. You have no web access, so you must not name specific products, models, prices or shops. Give criteria only.`,
    prompt: `NEED: ${need.text}\nLOCATION: ${where(ctx.location)}\n\nSHOPPING CONTEXT:\n${JSON.stringify(shareable({ ...ctx, needs: [] }), null, 1)}\n\nList what to look for given what they own and their home: must-haves, nice-to-haves, what to avoid, compatibility checks with owned items (by owned id), questions you'd ask them, and 2-4 generic search terms in the local language.`,
  };
}

export async function findDeals(llm, ctx, need, { onStep = () => {}, signal } = {}) {
  const audit = [];
  const startedAt = new Date().toISOString();
  if (!llm.search) {
    onStep("Asking your model for a buying checklist (it has no web search, so no products or prices)…");
    const { system, prompt } = checklistPrompts(ctx, need);
    const checklist = await llm.structured({ system, prompt, schema: CHECKLIST_SCHEMA, audit, signal, stage: "checklist" });
    return { kind: "checklist", need, location: ctx.location, startedAt, checklist, audit };
  }
  const registry = new SourceRegistry();
  onStep("Researching: searching reviews and shop pages near you…");
  const r = researchPrompts(ctx, need);
  const notes = await llm.research({ ...r, location: ctx.location, registry, audit, signal });
  onStep(`Read ${registry.size} sources. Turning the research into picks…`);
  const s = structurePrompts(ctx, need, registry, notes);
  const draft = await llm.structured({ ...s, schema: DEALS_SCHEMA, audit, signal, stage: "structure" });
  onStep("Checking every price and spec against the pages that were read…");
  const result = groundDeals(draft, registry, { ...ctx, _budget: need.budget_max ?? null });
  return { kind: "deals", need, location: ctx.location, startedAt, finishedAt: new Date().toISOString(),
           sources: registry.toJSON(), draft, ...result, audit };
}
