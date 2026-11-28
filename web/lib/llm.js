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
  openrouter: {
    label: "OpenRouter (Claude, GPT and more)",
    models: ["openrouter/auto"],
    defaultModel: "openrouter/auto",
    help: "Default. Sign in with your OpenRouter account, or paste a key from openrouter.ai/keys. Claude, GPT and other models are billed on that account. The key stays in this browser.",
    search: true,
    oauth: true,
  },
  gemini: {
    label: "Google Gemini",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    defaultModel: "gemini-2.5-flash",
    help: "Google AI Studio has a free tier with rate limits. After that, Google bills the key. Create one at aistudio.google.com/apikey. The key stays in this browser, and product searches become a buying checklist.",
    search: false,
  },
  openai: {
    label: "OpenAI",
    models: ["gpt-4.1-mini", "gpt-4.1"],
    defaultModel: "gpt-4.1-mini",
    help: "Billed on your OpenAI platform account. Create a key at platform.openai.com/api-keys. This page calls api.openai.com directly. Type another model id if the suggested one is retired.",
    search: true,
  },
  anthropic: {
    label: "Anthropic",
    models: ["claude-sonnet-5-5", "claude-opus-5-5"],
    defaultModel: "claude-sonnet-5-5",
    help: "Billed on your Anthropic account. Create a key at console.anthropic.com. This page sends Anthropic's browser-access header so Claude can be called from the browser. The key stays on this device.",
    search: true,
  },
  mistral: {
    label: "Mistral",
    models: ["mistral-small-latest", "mistral-large-latest"],
    defaultModel: "mistral-small-latest",
    base: "https://api.mistral.ai/v1",
    help: "Billed on your Mistral account. Create a key at console.mistral.ai. Calls go from this browser to api.mistral.ai. Product searches become a buying checklist.",
    search: false,
  },
  groq: {
    label: "Groq",
    models: ["llama-3.3-70b-versatile"],
    defaultModel: "llama-3.3-70b-versatile",
    base: "https://api.groq.com/openai/v1",
    help: "Groq has a free rate-limited tier; see console.groq.com for current prices. The key stays in this browser. Product searches become a buying checklist.",
    search: false,
  },
  compatible: {
    label: "OpenAI-compatible server",
    models: [],
    defaultModel: "",
    needsKey: false,
    needsBase: true,
    help: "Any https endpoint that accepts OpenAI-style /chat/completions, plus the model name. http is only allowed on localhost. The server must allow this site in CORS. A key, if the server wants one, stays in this browser. Product searches become a buying checklist.",
    search: false,
  },
  ollama: {
    label: "Ollama on this computer",
    models: [],
    defaultModel: "",
    needsKey: false,
    localOnly: true,
    defaultBase: "http://127.0.0.1:11434/v1",
    help: "Free, on your own machine. No key leaves this computer. Start Ollama with OLLAMA_ORIGINS set to this site's address, then enter a model name from ollama list. If that variable is unset, the browser cannot call Ollama and Test connection says so.",
    search: false,
  },
  chatgpt: {
    label: "ChatGPT plan (Sign in with ChatGPT)",
    models: [],
    defaultModel: "",
    needsKey: false,
    help: "Uses your ChatGPT plan. Only when DealFactory runs on your computer, because OpenAI's sign-in stays on that loopback server.",
    search: true,
    local: true,
  },
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function allowedBaseUrl(raw, { localOnly = false } = {}) {
  const value = (raw || "").trim();
  if (!value) return { ok: false, error: "Enter the base URL, including https://." };
  let url;
  try { url = new URL(value); } catch { return { ok: false, error: "Enter a full URL, including https://." }; }
  if (url.username || url.password) return { ok: false, error: "Put the key in the API key field, not in the URL." };
  const local = LOCAL_HOSTS.has(url.hostname);
  if (localOnly && !local) return { ok: false, error: "Ollama has to run on this computer (localhost)." };
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return { ok: false, error: "Use https, or http://localhost / http://127.0.0.1 for a model on this computer." };
  }
  return { ok: true, href: url.origin + url.pathname.replace(/\/$/, ""), origin: url.origin, local };
}

export function connectionHint(cfg) {
  const spec = PROVIDERS[cfg?.provider];
  if (!spec) return "Choose an AI provider first.";
  if (spec.browser === false) return spec.browserNote || "This provider cannot be called from the browser.";
  if (cfg.provider === "chatgpt") return "";
  if (spec.needsKey !== false && !(cfg.key || "").trim()) return "Add your API key first.";
  if (!(cfg.model || "").trim()) return "Enter the model name first.";
  if (spec.needsBase || spec.localOnly) {
    const checked = allowedBaseUrl(cfg.baseUrl || spec.defaultBase || "", { localOnly: !!spec.localOnly });
    if (!checked.ok) return checked.error;
  }
  return "";
}

export function providerReady(cfg, { chatgptSignedIn = false } = {}) {
  if (cfg?.provider === "chatgpt") return !!chatgptSignedIn;
  return !!PROVIDERS[cfg?.provider] && connectionHint(cfg) === "";
}

function normalizeBase(cfg) {
  const spec = PROVIDERS[cfg.provider];
  const checked = allowedBaseUrl(cfg.baseUrl || spec?.defaultBase || "", { localOnly: !!spec?.localOnly });
  if (!checked.ok) throw new LLMError(checked.error);
  return checked.href;
}

export class LLMError extends Error {}

function reachError(url, error) {
  let host = url;
  try { host = new URL(url).host; } catch { /* keep the raw address */ }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const extra = local
    ? " For Ollama, start it with OLLAMA_ORIGINS set to this site's address."
    : " The server has to allow this site in CORS.";
  return new LLMError(`Could not reach ${host} (${error.message}).${extra}`);
}

async function exchange(url, { method, headers, body, signal }) {
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw reachError(url, error);
  }
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!response.ok) {
    const msg = data?.error?.message || data?.message || text.slice(0, 300);
    let host = url;
    try { host = new URL(url).host; } catch { /* keep the raw address */ }
    throw new LLMError(`${host} said ${response.status}: ${msg}`);
  }
  return data;
}

async function post(url, headers, body, signal) {
  return exchange(url, { method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body), signal });
}

async function getJson(url, headers, signal) {
  return exchange(url, { method: "GET", headers, signal });
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

// ---------------------------------------------------------------- Gemini
async function geminiStructured(cfg, { system, prompt, schema, audit, signal, stage }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
  const body = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema },
  };
  const data = await post(url, { "x-goog-api-key": cfg.key }, body, signal);
  audit.push({ stage, provider: "gemini", request: body, response: data });
  const text = (data?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("").trim();
  if (data?.promptFeedback?.blockReason) throw new LLMError(`Gemini declined this request (${data.promptFeedback.blockReason}).`);
  return parseJson(text);
}

// ---------------------------------------------------------------- OpenAI-compatible chat (Mistral, Groq, Ollama, custom)
async function chatStructured(cfg, base, { system, prompt, schema, audit, signal, stage }) {
  const body = { model: cfg.model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
                 response_format: { type: "json_schema", json_schema: { name: stage, schema, strict: true } } };
  const resp = await post(`${base}/chat/completions`, cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}, body, signal);
  audit.push({ stage, provider: cfg.provider, request: body, response: resp });
  return parseJson(resp.choices?.[0]?.message?.content || "");
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

function chatBase(cfg) {
  return PROVIDERS[cfg.provider]?.base || normalizeBase(cfg);
}

export async function testConnection(cfg, signal) {
  const hint = connectionHint(cfg);
  if (hint) throw new LLMError(hint);
  if (cfg.provider === "anthropic") {
    await post(ANTHROPIC, anthropicHeaders(cfg), { model: cfg.model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }, signal);
    return "Anthropic accepted the key.";
  }
  if (cfg.provider === "openai") {
    await getJson("https://api.openai.com/v1/models", { authorization: `Bearer ${cfg.key}` }, signal);
    return "OpenAI accepted the key.";
  }
  if (cfg.provider === "openrouter") {
    await getJson("https://openrouter.ai/api/v1/key", { authorization: `Bearer ${cfg.key}` }, signal);
    return "OpenRouter accepted the key.";
  }
  if (cfg.provider === "gemini") {
    await getJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}`, { "x-goog-api-key": cfg.key }, signal);
    return "Google Gemini accepted the key.";
  }
  if (cfg.provider === "mistral" || cfg.provider === "groq" || cfg.provider === "compatible") {
    await getJson(`${chatBase(cfg)}/models`, cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}, signal);
    return `${PROVIDERS[cfg.provider].label} accepted the connection.`;
  }
  if (cfg.provider === "ollama") {
    const origin = new URL(chatBase(cfg)).origin;
    const data = await getJson(`${origin}/api/tags`, {}, signal);
    const names = (data?.models || []).map((model) => model.name || "");
    const wanted = cfg.model.trim();
    if (names.length && !names.some((name) => name === wanted || name.startsWith(`${wanted}:`))) {
      throw new LLMError(`Ollama is running, but it has no model named ${wanted}.`);
    }
    return "Ollama is reachable from this browser.";
  }
  throw new LLMError(PROVIDERS[cfg.provider]?.browserNote || "This provider cannot be called from the browser.");
}

export function builtinClient() {
  return {
    search: false,
    research: null,
    structured: async ({ system, prompt, signal }) => {
      let response;
      try {
        response = await fetch("/api/ai", {
          method: "POST", credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ system, prompt }), signal,
        });
      } catch (error) {
        if (error.name === "AbortError") throw error;
        throw new LLMError("Could not reach the built-in AI.");
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new LLMError(data.message || "The built-in AI did not answer.");
      return parseJson(data.text || "");
    },
  };
}

export function client(cfg) {
  const spec = PROVIDERS[cfg?.provider];
  if (!spec) throw new LLMError("Choose an AI provider first.");
  if (spec.browser === false) throw new LLMError(spec.browserNote || "This provider cannot be called from the browser.");
  if (cfg.provider !== "chatgpt") {
    const hint = connectionHint(cfg);
    if (hint) throw new LLMError(cfg.provider === "openrouter" && !(cfg.key || "").trim()
      ? "Sign in with OpenRouter (or paste an OpenRouter key) first." : hint);
  }
  if (cfg.provider === "anthropic") return { search: true, research: (a) => anthropicResearch(cfg, a), structured: (a) => anthropicStructured(cfg, a) };
  if (cfg.provider === "openrouter") return { search: true, research: (a) => openrouterResearch(cfg, a), structured: (a) => openrouterStructured(cfg, a) };
  if (cfg.provider === "chatgpt") return { search: true, research: (a) => chatgptResearch(cfg, a), structured: (a) => chatgptStructured(cfg, a) };
  if (cfg.provider === "openai") return { search: true, research: (a) => openaiResearch(cfg, a), structured: (a) => openaiStructured(cfg, a) };
  if (cfg.provider === "gemini") return { search: false, research: null, structured: (a) => geminiStructured(cfg, a) };
  const base = chatBase(cfg);
  return { search: false, research: null, structured: (a) => chatStructured(cfg, base, a) };
}
