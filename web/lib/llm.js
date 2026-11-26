// Bring-your-own-model. Calls go straight from the browser to the visitor's provider with their key.
// Nothing passes through a DealFactory server (there is none).
//
//   anthropic  Claude with server-side web_search + web_fetch (reads pages -> strongest grounding)
//   openai     OpenAI Responses API with web_search (citations only -> weaker grounding, marked *)
//   openrouter One-click sign-in (OAuth PKCE) to the visitor's OpenRouter account: Claude, GPT and others,
//              with OpenRouter's web search (search excerpts, not full pages -> marked *)
//   chatgpt    Sign in with ChatGPT, using the visitor's ChatGPT plan. Only when DealFactory runs on their
//              own computer (`dealfactory web`): OpenAI requires a loopback sign-in and keeps the tokens
//              out of the browser, so the local server holds them and relays requests.
//   compatible Any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter...). No web search, so it
//              only produces a buying checklist + search links, never product or price claims.

import { harvestAnthropic, harvestOpenAI } from "./ground.js";

export const PROVIDERS = {
  anthropic: {
    label: "Claude (Anthropic)",
    models: ["claude-sonnet-5-5", "claude-opus-5-5"],
    defaultModel: "claude-sonnet-5-5",
    keyHelp: "console.anthropic.com → API keys",
    search: true,
  },
  openai: {
    label: "OpenAI",
    models: [],
    defaultModel: "",
    keyHelp: "platform.openai.com → API keys; use a model that supports the web_search tool",
    search: true,
  },
  openrouter: {
    label: "OpenRouter (Claude, GPT and more)",
    models: ["openrouter/auto"],
    defaultModel: "openrouter/auto",
    keyHelp: "use “Sign in with OpenRouter” above, or paste a key from openrouter.ai/keys",
    search: true,
    oauth: true,
  },
  chatgpt: {
    label: "ChatGPT plan (Sign in with ChatGPT)",
    models: [],
    defaultModel: "",
    keyHelp: "no key: sign in with ChatGPT above (only when DealFactory runs on your computer)",
    search: true,
    local: true,
  },
  compatible: {
    label: "OpenAI-compatible (Ollama, LM Studio, OpenRouter…)",
    models: [],
    defaultModel: "",
    keyHelp: "Ollama: start it with OLLAMA_ORIGINS set to this site's address; base URL http://localhost:11434/v1",
    search: false,
  },
};

export class LLMError extends Error {}

async function post(url, headers, body, signal) {
  let r;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers },
                           body: JSON.stringify(body), signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new LLMError(`Could not reach ${new URL(url).host} (${e.message}). Check the address, CORS and your connection.`);
  }
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!r.ok) {
    const msg = data?.error?.message || data?.message || text.slice(0, 300);
    throw new LLMError(`${new URL(url).host} said ${r.status}: ${msg}`);
  }
  return data;
}

function textOf(blocks) {
  return (blocks || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// ---------------------------------------------------------------- Anthropic
const ANTHROPIC = "https://api.anthropic.com/v1/messages";

function anthropicHeaders(cfg) {
  return { "x-api-key": cfg.key, "anthropic-version": "2023-06-01",
           "anthropic-dangerous-direct-browser-access": "true" };
}

function anthropicCheck(msg) {
  if (msg.stop_reason === "refusal") throw new LLMError("The model declined this request.");
  if (msg.stop_reason === "max_tokens") throw new LLMError("The answer was cut off (max_tokens). Try a narrower need.");
}

async function anthropicResearch(cfg, { system, prompt, location, registry, audit, signal }) {
  const tools = [
    { type: "web_search_20260209", name: "web_search", max_uses: 6,
      ...(location.country ? { user_location: { type: "approximate", country: location.country,
                                                ...(location.city ? { city: location.city } : {}) } } : {}) },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6, citations: { enabled: true } },
  ];
  const messages = [{ role: "user", content: prompt }];
  let notes = "";
  for (let turn = 0; turn < 5; turn++) {
    const body = { model: cfg.model, max_tokens: 16000, system, messages, tools, output_config: { effort: "medium" } };
    const msg = await post(ANTHROPIC, anthropicHeaders(cfg), body, signal);
    audit.push({ stage: "research", provider: "anthropic", request: body, response: msg });
    harvestAnthropic(msg.content, registry);
    notes += (notes ? "\n" : "") + textOf(msg.content);
    if (msg.stop_reason !== "pause_turn") { anthropicCheck(msg); break; }
    messages.push({ role: "assistant", content: msg.content });
  }
  return notes;
}

async function anthropicStructured(cfg, { system, prompt, schema, audit, signal, stage }) {
  const body = { model: cfg.model, max_tokens: 12000, system, messages: [{ role: "user", content: prompt }],
                 output_config: { effort: "low", format: { type: "json_schema", schema } } };
  const msg = await post(ANTHROPIC, anthropicHeaders(cfg), body, signal);
  audit.push({ stage, provider: "anthropic", request: body, response: msg });
  anthropicCheck(msg);
  return JSON.parse(textOf(msg.content));
}

// ---------------------------------------------------------------- OpenAI (Responses API)
const OPENAI = "https://api.openai.com/v1/responses";

function outputText(resp) {
  return (resp.output || []).flatMap((o) => o.content || []).filter((c) => c.type === "output_text")
    .map((c) => c.text).join("\n").trim();
}

async function openaiResearch(cfg, { system, prompt, location, registry, audit, signal }) {
  const body = { model: cfg.model, instructions: system, input: prompt,
                 tools: [{ type: "web_search", ...(location.country ? { user_location: { type: "approximate",
                   country: location.country, ...(location.city ? { city: location.city } : {}) } } : {}) }],
                 include: ["web_search_call.action.sources"] };
  const resp = await post(OPENAI, { authorization: `Bearer ${cfg.key}` }, body, signal);
  audit.push({ stage: "research", provider: "openai", request: body, response: resp });
  harvestOpenAI(resp.output, registry);
  return outputText(resp);
}

async function openaiStructured(cfg, { system, prompt, schema, audit, signal, stage }) {
  const body = { model: cfg.model, instructions: system, input: prompt,
                 text: { format: { type: "json_schema", name: stage, schema, strict: true } } };
  const resp = await post(OPENAI, { authorization: `Bearer ${cfg.key}` }, body, signal);
  audit.push({ stage, provider: "openai", request: body, response: resp });
  return JSON.parse(outputText(resp));
}

// ---------------------------------------------------------------- OpenAI-compatible chat
async function compatStructured(cfg, { system, prompt, schema, audit, signal, stage }) {
  const base = (cfg.baseUrl || "http://localhost:11434/v1").replace(/\/$/, "");
  const body = { model: cfg.model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
                 response_format: { type: "json_schema", json_schema: { name: stage, schema, strict: true } } };
  const resp = await post(`${base}/chat/completions`, cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}, body, signal);
  audit.push({ stage, provider: "compatible", request: body, response: resp });
  const text = resp.choices?.[0]?.message?.content || "";
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0) throw new LLMError("The model did not return JSON.");
  return JSON.parse(text.slice(start, end + 1));
}

// ---------------------------------------------------------------- OpenRouter (Responses API + server web search)
const OPENROUTER = "https://openrouter.ai/api/v1/responses";
const orHeaders = (cfg) => ({ authorization: `Bearer ${cfg.key}`, "x-title": "DealFactory" });

// OpenRouter returns url_citation annotations, flat or nested, sometimes with an excerpt of the page.
export function harvestOpenRouter(output, reg) {
  for (const item of output || []) {
    for (const s of item?.action?.sources || []) if (s.url) reg.add(s.url, "search_result", s.title);
    for (const c of item?.content || []) {
      for (const a of c.annotations || []) {
        const u = a.url_citation || a;
        if ((a.type === "url_citation" || a.url_citation) && u.url) reg.add(u.url, "citation", u.title, u.content || null);
      }
    }
  }
}

async function openrouterResearch(cfg, { system, prompt, registry, audit, signal }) {
  const body = { model: cfg.model, instructions: system, input: prompt, max_tool_calls: 8,
                 tools: [{ type: "openrouter:web_search", parameters: { max_results: 6 } }] };
  const resp = await post(OPENROUTER, orHeaders(cfg), body, signal);
  audit.push({ stage: "research", provider: "openrouter", request: body, response: resp });
  harvestOpenRouter(resp.output, registry);
  return outputText(resp);
}

async function openrouterStructured(cfg, { system, prompt, schema, audit, signal, stage }) {
  const body = { model: cfg.model, instructions: system, input: prompt,
                 text: { format: { type: "json_schema", name: stage, schema, strict: true } } };
  const resp = await post(OPENROUTER, orHeaders(cfg), body, signal);
  audit.push({ stage, provider: "openrouter", request: body, response: resp });
  return parseJson(outputText(resp));
}

// ---------------------------------------------------------------- ChatGPT plan (via the local server)
const CHATGPT = "/api/chatgpt/responses";

async function chatgptResearch(cfg, { system, prompt, registry, audit, signal }) {
  const body = { model: cfg.model, instructions: system, input: prompt, tools: [{ type: "web_search" }],
                 include: ["web_search_call.action.sources"] };
  const resp = await post(CHATGPT, {}, body, signal);
  audit.push({ stage: "research", provider: "chatgpt", request: body, response: resp });
  harvestOpenAI(resp.output, registry);
  return outputText(resp);
}

async function chatgptStructured(cfg, { system, prompt, schema, audit, signal, stage }) {
  const body = { model: cfg.model, instructions: system, input: prompt,
                 text: { format: { type: "json_schema", name: stage, schema, strict: true } } };
  const resp = await post(CHATGPT, {}, body, signal);
  audit.push({ stage, provider: "chatgpt", request: body, response: resp });
  return parseJson(outputText(resp));
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0) throw new LLMError("The model did not return JSON.");
  return JSON.parse(text.slice(start, end + 1));
}

// What the local `dealfactory web` server offers (null when the site is hosted publicly).
export async function localServer() {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return null;
  try {
    const r = await fetch("/api/local", { headers: { accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export function client(cfg) {
  if (!cfg?.provider || !PROVIDERS[cfg.provider]) throw new LLMError("Choose an AI provider first.");
  if (cfg.provider === "openrouter" && !cfg.key) throw new LLMError("Sign in with OpenRouter (or paste an OpenRouter key) first.");
  if (!["compatible", "openrouter", "chatgpt"].includes(cfg.provider) && !cfg.key) throw new LLMError("Add your API key first.");
  if (!cfg.model) throw new LLMError("Choose a model first.");
  if (cfg.provider === "anthropic") return { search: true, research: (a) => anthropicResearch(cfg, a), structured: (a) => anthropicStructured(cfg, a) };
  if (cfg.provider === "openrouter") return { search: true, research: (a) => openrouterResearch(cfg, a), structured: (a) => openrouterStructured(cfg, a) };
  if (cfg.provider === "chatgpt") return { search: true, research: (a) => chatgptResearch(cfg, a), structured: (a) => chatgptStructured(cfg, a) };
  if (cfg.provider === "openai") return { search: true, research: (a) => openaiResearch(cfg, a), structured: (a) => openaiStructured(cfg, a) };
  return { search: false, research: null, structured: (a) => compatStructured(cfg, a) };
}
