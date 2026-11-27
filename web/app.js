import { emptyContext, exportPrompt, IMPORT_PROMPT, mergeContext, normalizeContext, nowIso, parseAssistantReply,
         shareable, slug, SUGGESTED_FACTS, uniqueId } from "./lib/context.js";
import { findDeals } from "./lib/deals.js";
import { builtinClient, client, connectionHint, LLMError, localServer, PROVIDERS, providerReady, testConnection } from "./lib/llm.js";
import { finishGoogle, finishOpenRouter, googleSignIn, openRouterSignIn, pendingProvider, pendingResult } from "./lib/oauth.js";
import { contextFromPurchases, importGmail } from "./lib/purchases.js";
import { CONFIG } from "./config.js";
import { countryName, currencyFor, guessFromDevice, languageFor, countryOptions } from "./lib/location.js";

// ------------------------------------------------------------------ storage (never throws)
const legacyResultsKey = "dealfactory.results.v1";
const KEYS = { ctx: "dealfactory.context.v1", ai: "dealfactory.ai.v1", key: "dealfactory.key.v1", results: "dealfactory.results.v2", purchases: "dealfactory.purchases.v1", sync: "dealfactory.sync.v1" };
const store = {
  get(k, area) { try { return JSON.parse((area ?? localStorage).getItem(k)); } catch { return null; } },
  set(k, v, area) { try { (area ?? localStorage).setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k, area) { try { (area ?? localStorage).removeItem(k); } catch { /* ignore */ } },
};
const session = (() => { try { return sessionStorage; } catch { return null; } })();

let ctx = (() => { try { return normalizeContext(store.get(KEYS.ctx) || emptyContext()); } catch { return emptyContext(); } })();
let ai = { provider: "openrouter", model: PROVIDERS.openrouter.defaultModel, baseUrl: "", remember: false, key: "" };
let results = store.get(KEYS.results) || {};
let imported = store.get(KEYS.purchases) || { refs: [], purchases: [] };
let local = null; // what `dealfactory web` offers when running on this computer
const audits = {};
let running = null;
let gmailRunning = false;
let gmailRun = null;
let account = { signedIn: false };
let syncOn = false;
let syncTimer = null;
let applyingSync = false;
let serverSetup = null;

function saveCtx() { ctx.updated_at = nowIso(); store.set(KEYS.ctx, ctx); if (!applyingSync) scheduleSync(); }
function contextEmpty() {
  return !ctx.owned.length && !ctx.facts.length;
}
function syncSlice() {
  return { format: "shopping-context", version: 1, updated_at: ctx.updated_at, generator: "dealfactory-sync",
    location: ctx.location, facts: ctx.facts, owned: ctx.owned };
}
function scheduleSync() {
  if (!syncOn || !account?.signedIn) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => putSync(), 1200);
}
async function putSync() {
  if (!syncOn || !account?.signedIn) return;
  await fetch("/api/state", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: syncSlice() }) }).catch(() => {});
}
function applyServer(doc) {
  applyingSync = true;
  try {
    const next = normalizeContext(doc);
    ctx.location = next.location;
    ctx.facts = next.facts;
    ctx.owned = next.owned;
    ctx.updated_at = next.updated_at || nowIso();
    store.set(KEYS.ctx, ctx);
    renderLocation();
    renderFacts();
    renderOwned();
  } finally { applyingSync = false; }
}
function showConflict(doc) {
  serverSetup = doc;
  const box = $("#sync-conflict");
  if (box) box.hidden = false;
}
function track(event) {
  try { window.dealfactoryCount?.(event); } catch { /* a counter must not block the advisor */ }
}
function saveResults() {
  // Keep the last result per need, without the bulky audit trail.
  const slim = Object.fromEntries(Object.entries(results).slice(-12).map(([k, v]) => [k, { ...v, audit: undefined }]));
  if (!store.set(KEYS.results, slim)) store.set(KEYS.results, {});
}

// ------------------------------------------------------------------ tiny DOM helper (textContent only)
const $ = (sel) => document.querySelector(sel);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "href") { if (/^https?:\/\//i.test(v) || v.startsWith("#")) el.setAttribute("href", v); }
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const tag = (cls, text) => h("span", { class: `tag ${cls}` }, text);
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 2600);
}
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
  catch { toast("Copy failed: select and copy manually"); }
}
function download(name, data) {
  const blob = new Blob([typeof data === "string" ? data : JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = h("a", { download: name });
  a.href = URL.createObjectURL(blob);
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function money(amount, currency) {
  if (amount == null) return null;
  try {
    return new Intl.NumberFormat(ctx.location.language || navigator.language || "en",
      { style: "currency", currency: currency || ctx.location.currency || "EUR" }).format(amount);
  } catch {
    return `${currency || ""} ${amount}`.trim();
  }
}
const when = (iso) => { try { return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); } catch { return iso; } };
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

// ------------------------------------------------------------------ location
function renderLocation() {
  const l = ctx.location;
  const label = l.country
    ? [l.city, countryName(l.country)].filter(Boolean).join(", ") + (l.currency ? ` · ${l.currency}` : "")
    : "Location unknown: set your city";
  $("#loc-label").textContent = label;
  $("#loc-label").title = l._how ? `Guessed from your ${l._how}` : "";
  $("#loc-country").value = l.country || "";
  $("#loc-city").value = l.city || "";
  renderMcp();
}
function setLocation(loc, how) {
  ctx.location = Object.fromEntries(Object.entries({
    country: loc.country, region: loc.region || null, city: loc.city || null,
    currency: loc.currency || currencyFor(loc.country), language: loc.language || languageFor(loc.country),
  }).filter(([, v]) => v));
  if (how) ctx.location._how = how;
  saveCtx();
  renderLocation();
}
function initLocation() {
  const editor = $("#loc-editor");
  const toggle = $("#loc-change");
  const country = $("#loc-country");
  const city = $("#loc-city");
  country.replaceChildren(h("option", { value: "" }, "Choose a country"),
    ...countryOptions(navigator.language).map(([code, name]) => h("option", { value: code }, name)));
  const show = (open) => {
    editor.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  };
  if (!ctx.location.country) {
    const guess = guessFromDevice();
    if (guess) setLocation(guess, guess.how);
  }
  renderLocation();
  show(!ctx.location.country);
  toggle.onclick = () => {
    show(editor.hidden);
    if (!editor.hidden) country.focus();
  };
  $("#loc-form").onsubmit = (e) => {
    e.preventDefault();
    if (!country.value) return;
    setLocation({ country: country.value, city: city.value.trim() }, null);
    show(false);
    toggle.focus();
    toast("Shopping location saved");
  };
}

// ------------------------------------------------------------------ setup: facts + owned
function statusControls(item, onChange) {
  if (item.status !== "unconfirmed") return null;
  return h("span", { class: "confirm" },
    tag("warn", item.source === "inferred" ? "inferred" : "unconfirmed"),
    h("button", { type: "button", class: "icon", title: "Confirm", "aria-label": "Confirm", onclick: () => { item.status = "confirmed"; item.confidence = 1; onChange(); } }, "✓"),
    h("button", { type: "button", class: "icon", title: "Reject", "aria-label": "Reject", onclick: () => { item.status = "rejected"; onChange(); } }, "✕"));
}
function renderFacts() {
  const box = $("#facts");
  const byId = new Map(ctx.facts.map((f) => [f.id, f]));
  const rows = SUGGESTED_FACTS.map(([id, label, ph]) => {
    const f = byId.get(id);
    const val = f && f.status !== "rejected" ? (Array.isArray(f.value) ? f.value.join(", ") : f.value ?? "") : "";
    const input = h("input", { value: val, placeholder: ph, "aria-label": label });
    input.addEventListener("change", () => {
      const v = input.value.trim();
      const listy = /floor_types|pets|children|priorities|retailers/.test(id);
      const value = listy ? v.split(",").map((s) => s.trim()).filter(Boolean) : (/size_m2/.test(id) && v && !Number.isNaN(+v) ? +v : v);
      if (!v) ctx.facts = ctx.facts.filter((x) => x.id !== id);
      else if (f) Object.assign(f, { value, source: "stated", status: "confirmed", confidence: 1 });
      else ctx.facts.push({ id, value, source: "stated", status: "confirmed", confidence: 1 });
      saveCtx();
      renderFacts();
    });
    return h("label", { class: `fact-row ${f?.status || ""}` }, h("span", { class: "fact-label" }, label), input,
      f ? statusControls(f, () => { saveCtx(); renderFacts(); }) : null);
  });
  const known = new Set(SUGGESTED_FACTS.map(([id]) => id));
  const extra = ctx.facts.filter((f) => !known.has(f.id) && f.status !== "rejected").map((f) =>
    h("div", { class: `fact-row ${f.status}` }, h("span", { class: "fact-label" }, h("code", {}, f.id)),
      h("span", { class: "fact-value" }, Array.isArray(f.value) ? f.value.join(", ") : String(f.value ?? "")),
      statusControls(f, () => { saveCtx(); renderFacts(); }),
      h("button", { type: "button", class: "icon", title: "Remove", "aria-label": `Remove ${f.id}`, onclick: () => { ctx.facts = ctx.facts.filter((x) => x !== f); saveCtx(); renderFacts(); } }, "🗑")));
  box.replaceChildren(...rows, ...extra);
}
function renderOwned() {
  const list = $("#owned");
  const items = ctx.owned.filter((o) => o.status !== "rejected");
  list.replaceChildren(...(items.length ? items.map((o) => h("li", { class: o.status },
    h("div", {}, h("strong", {}, `${o.brand} ${o.model}`), h("span", { class: "muted small" }, ` · ${o.category}`),
      o.notes ? h("div", { class: "small muted" }, o.notes) : null),
    h("div", { class: "owned-actions" }, statusControls(o, () => { saveCtx(); renderOwned(); }),
      h("button", { type: "button", class: "icon", title: "Remove", "aria-label": `Remove ${o.brand} ${o.model}`, onclick: () => { ctx.owned = ctx.owned.filter((x) => x !== o); saveCtx(); renderOwned(); } }, "🗑"))))
    : [h("li", { class: "muted small empty" }, "Nothing yet. Add what a new purchase must work with: Hue bridge, boiler, TV, air purifier, robot vacuum…")]));
}
function initSetup() {
  $("#owned-form").onsubmit = (e) => {
    e.preventDefault();
    const category = $("#owned-category").value.trim(), brand = $("#owned-brand").value.trim(), model = $("#owned-model").value.trim();
    const id = uniqueId(`${category} ${brand} ${model}`, new Set(ctx.owned.map((o) => o.id)));
    ctx.owned.push({ id, category: slug(category), brand, model, aliases: [`my ${category.toLowerCase()}`], source: "stated", status: "confirmed", confidence: 1 });
    saveCtx();
    track("setup_add");
    e.target.reset();
    renderOwned();
  };
  $("#fact-form").onsubmit = (e) => {
    e.preventDefault();
    const id = $("#fact-id").value.trim(), value = $("#fact-value").value.trim();
    ctx.facts = ctx.facts.filter((f) => f.id !== id);
    ctx.facts.push({ id, value, source: "stated", status: "confirmed", confidence: 1 });
    saveCtx();
    e.target.reset();
    renderFacts();
  };
  renderFacts();
  renderOwned();
}

// ------------------------------------------------------------------ AI settings
function saveAi(next) {
  ai = next;
  const { key, ...rest } = ai;
  store.set(KEYS.ai, rest);
  store.del(KEYS.key);
  if (session) store.del(KEYS.key, session);
  if (key && ai.remember) store.set(KEYS.key, key);
  if (key && !ai.remember && session) store.set(KEYS.key, key, session);
  renderAi();
}
function refreshAi() {
  const saved = store.get(KEYS.ai) || {};
  const storedKey = store.get(KEYS.key) || (session && store.get(KEYS.key, session)) || "";
  const provider = PROVIDERS[saved.provider] ? saved.provider : "openrouter";
  ai.provider = provider;
  ai.model = saved.model || PROVIDERS[provider].defaultModel;
  ai.baseUrl = saved.baseUrl || "";
  ai.remember = !!saved.remember;
  ai.key = typeof storedKey === "string" ? storedKey : "";
}
function byoReady() {
  return providerReady(ai, { chatgptSignedIn: !!local?.chatgpt?.signed_in });
}
function aiIsReady() {
  return byoReady() || !!account?.signedIn;
}
function advisorClient() {
  if (account?.signedIn && !byoReady()) return builtinClient();
  return client(ai);
}
function draftFromForm() {
  const provider = $("#ai-provider").value;
  const spec = PROVIDERS[provider] || PROVIDERS.openrouter;
  return {
    provider,
    model: $("#ai-model").value.trim() || spec.defaultModel || "",
    baseUrl: $("#ai-base").value.trim() || spec.defaultBase || "",
    key: $("#ai-key").value.trim(),
    remember: $("#ai-remember").checked,
  };
}
function showAiNote(text, ok) {
  const status = $("#ai-status");
  status.className = ok ? "small ok" : "small error";
  status.textContent = text;
}
function syncConnection() {
  refreshAi();
  const ready = aiIsReady();
  const provider = PROVIDERS[ai.provider];
  const step = $("#ai-connected");
  if (step) {
    step.className = `small ${ready ? "ok" : "muted"}`;
    const who = account?.provider === "github" ? "GitHub" : "Google";
    const name = account?.displayName && !account.displayName.includes("@") ? account.displayName : "";
    step.textContent = byoReady()
      ? `Step 1 done. Connected: ${provider?.label || ai.provider}${ai.model ? ` · ${ai.model}` : ""}` +
        (ai.provider === "chatgpt" && local?.chatgpt?.email ? ` (${local.chatgpt.email})` : "")
      : account?.signedIn
        ? `Step 1 done. Signed in with ${who}${name ? ` as ${name}` : ""}. Built-in AI is ready.`
        : "Step 1: sign in for the free AI, or open “Use your own AI”.";
  }
  $("#ai")?.classList.toggle("is-ready", ready);
  const card = $("#gmail");
  const button = $("#gm-connect");
  const since = $("#gm-since");
  const status = $("#gm-status");
  if (!card || !button || !status) return;
  if (gmailRunning) {
    card.dataset.locked = "false";
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
    if (since) since.disabled = true;
    return;
  }
  const googleReady = !!CONFIG.googleClientId;
  const locked = !ready || !googleReady;
  card.dataset.locked = locked ? "true" : "false";
  button.disabled = locked;
  button.setAttribute("aria-disabled", locked ? "true" : "false");
  if (since) since.disabled = locked;
  if (status.dataset.gate === "result" && ready && googleReady) return;
  hideImportProgress();
  if (!ready) {
    status.dataset.gate = "locked";
    status.className = "small step-hint";
    status.replaceChildren("Finish ", h("a", { href: "#ai" }, "step 1"), " before importing receipts.");
  } else if (!googleReady) {
    status.dataset.gate = "locked";
    status.className = "small step-hint";
    status.textContent = "Gmail import is awaiting Google setup. You can add purchases under Your setup.";
  } else {
    delete status.dataset.gate;
    status.className = "small";
    status.replaceChildren();
  }
}
function renderAccount() {
  const signedIn = !!account?.signedIn;
  const out = $("#account-signed-out");
  const inn = $("#account-signed-in");
  if (out) out.hidden = signedIn;
  if (inn) inn.hidden = !signedIn;
  if (!signedIn) return;
  const who = account.provider === "github" ? "GitHub" : "Google";
  const name = account.displayName && !account.displayName.includes("@") ? account.displayName : "";
  const whoEl = $("#account-who");
  if (whoEl) whoEl.textContent = `Signed in with ${who}${name ? ` as ${name}` : ""}.`;
  const allowance = $("#ai-allowance");
  const left = account.allowance;
  if (allowance) allowance.textContent = left
    ? `${left.remaining} of ${left.limit} free answers left today. Resets at 00:00 UTC.`
    : "";
}
async function loadAccount() {
  account = { signedIn: false };
  try {
    const response = await fetch("/auth/session", { headers: { accept: "application/json" }, credentials: "same-origin" });
    if (response.ok) {
      const data = await response.json();
      if (data && typeof data.signedIn === "boolean") account = data;
    }
  } catch { /* a static preview has no account API */ }
  renderAccount();
  renderConnected();
  await considerSync();
}
async function considerSync() {
  const panel = $("#sync-panel");
  if (panel) panel.hidden = !account?.signedIn;
  const toggle = $("#sync-toggle");
  if (!account?.signedIn) { syncOn = false; if (toggle) toggle.checked = false; return; }
  let remote = null;
  try {
    const response = await fetch("/api/state", { credentials: "same-origin", headers: { accept: "application/json" } });
    if (response.ok) remote = await response.json();
  } catch { remote = null; }
  const server = remote?.state;
  if (server && contextEmpty()) {
    applyServer(server);
    syncOn = true;
    store.set(KEYS.sync, true);
  } else if (server && !contextEmpty()) showConflict(server);
  else syncOn = store.get(KEYS.sync) === true;
  if (toggle) toggle.checked = syncOn;
}
function renderConnected() {
  syncConnection();
  renderConnectProgress();
  $("#cg-signin").hidden = !local || !!local.chatgpt?.signed_in;
  $("#cg-signout").hidden = !local?.chatgpt?.signed_in;
  $("#cg-note").hidden = !!local;
}
function renderAi(settings = ai) {
  const sel = $("#ai-provider");
  sel.replaceChildren(...Object.entries(PROVIDERS).filter(([, p]) => !p.local || local)
    .map(([k, p]) => h("option", { value: k, selected: settings.provider === k }, p.label)));
  const p = PROVIDERS[settings.provider] || PROVIDERS.openrouter;
  $("#ai-models").replaceChildren(...p.models.map((m) => h("option", { value: m })));
  $("#ai-model").value = settings.model || p.defaultModel || "";
  $("#ai-model").placeholder = p.localOnly ? "model name from ollama list" : "model id";
  $("#ai-base").value = settings.baseUrl || "";
  $("#ai-base").placeholder = p.defaultBase || "https://example.com/v1";
  $("#ai-base-wrap").hidden = !(p.needsBase || p.localOnly);
  $("#ai-key").value = settings.key || "";
  $("#ai-key").placeholder = p.needsKey === false ? "Optional" : "Paste your key";
  $("#ai-key-wrap").hidden = settings.provider === "ollama" || settings.provider === "chatgpt";
  $("#ai-remember").checked = !!settings.remember;
  $("#ai-help").textContent = p.help || "";
  $("#or-signin").hidden = settings.provider !== "openrouter";
  const ready = providerReady(settings, { chatgptSignedIn: !!local?.chatgpt?.signed_in });
  $("#ai-status").className = "small muted";
  $("#ai-status").textContent = ready
    ? `Saved: ${p.label}${settings.model ? ` · ${settings.model}` : ""}`
    : (settings.provider === "chatgpt" ? "Sign in with ChatGPT on this computer" : "Not connected yet");
  if (settings.provider === "chatgpt") loadChatgptModels(settings);
  renderConnected();
}
async function loadChatgptModels(settings) {
  if (!local?.chatgpt?.signed_in) return;
  try {
    const r = await fetch("/api/chatgpt/models");
    const data = await r.json();
    const ids = (data.models || []).map((m) => m.id);
    $("#ai-models").replaceChildren(...ids.map((m) => h("option", { value: m })));
    if (!$("#ai-model").value && ids[0]) $("#ai-model").value = ids[0];
    if (settings === ai && !ai.model && ids[0]) saveAi({ ...ai, model: ids[0] });
  } catch { /* models list is a convenience */ }
}
function initAi() {
  $("#ai-provider").onchange = (e) => {
    const provider = e.target.value;
    renderAi(provider === ai.provider ? ai : { provider, model: PROVIDERS[provider].defaultModel });
    if (provider !== ai.provider) $("#ai-status").textContent = "Save to switch providers";
  };
  $("#ai-form").onsubmit = (e) => {
    e.preventDefault();
    const draft = draftFromForm();
    const hint = connectionHint(draft);
    if (hint) { showAiNote(hint, false); return; }
    saveAi(draft);
    track("ai_connect");
    showAiNote(`Connected: ${PROVIDERS[draft.provider].label}`, true);
    toast("AI settings saved");
  };
  $("#ai-test").onclick = async () => {
    const draft = draftFromForm();
    const hint = connectionHint(draft);
    if (hint) { showAiNote(hint, false); return; }
    const button = $("#ai-test");
    button.disabled = true;
    showAiNote("Testing the connection…", true);
    try {
      const message = await testConnection(draft);
      saveAi(draft);
      track("ai_connect");
      showAiNote(message, true);
    } catch (error) {
      showAiNote(error.message, false);
    } finally {
      button.disabled = false;
    }
  };
  $("#ai-forget").onclick = () => {
    ai.key = "";
    store.del(KEYS.key);
    if (session) store.del(KEYS.key, session);
    renderAi();
    toast("Key forgotten");
  };
  renderAi();
}

// ------------------------------------------------------------------ one-click connections
function useOpenRouterKey(key) {
  const model = ai.provider === "openrouter" && ai.model ? ai.model : PROVIDERS.openrouter.defaultModel;
  saveAi({ provider: "openrouter", model, baseUrl: "", key, remember: ai.remember });
  track("ai_connect");
  toast("Connected to OpenRouter");
}
async function initConnect() {
  $("#sync-toggle").onchange = async () => {
    if ($("#sync-toggle").checked) {
      syncOn = true;
      store.set(KEYS.sync, true);
      await putSync();
      return;
    }
    syncOn = false;
    store.set(KEYS.sync, false);
    const remove = window.confirm("Delete the setup saved in your account? The copy on this device stays.");
    if (remove) await fetch("/api/state", { method: "DELETE", credentials: "same-origin" }).catch(() => {});
  };
  $("#sync-keep-device").onclick = async () => {
    $("#sync-conflict").hidden = true;
    syncOn = true;
    store.set(KEYS.sync, true);
    $("#sync-toggle").checked = true;
    await putSync();
  };
  $("#sync-keep-account").onclick = () => {
    if (serverSetup) applyServer(serverSetup);
    $("#sync-conflict").hidden = true;
    syncOn = true;
    store.set(KEYS.sync, true);
    $("#sync-toggle").checked = true;
  };
  $("#sync-keep-newer").onclick = async () => {
    const remoteTime = Date.parse(serverSetup?.updated_at) || 0;
    if (remoteTime > (Date.parse(ctx.updated_at) || 0)) applyServer(serverSetup);
    $("#sync-conflict").hidden = true;
    syncOn = true;
    store.set(KEYS.sync, true);
    $("#sync-toggle").checked = true;
    if (remoteTime <= (Date.parse(ctx.updated_at) || 0)) await putSync();
  };
  $("#account-signout").onclick = async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    account = { signedIn: false };
    renderAccount();
    renderConnected();
    toast("Signed out");
  };
  $("#account-delete").onclick = async () => {
    if (!window.confirm("Delete your DealFactory account on this site? The shopping setup saved in this browser stays until you delete it separately.")) return;
    const response = await fetch("/auth/account", { method: "DELETE", credentials: "same-origin" }).catch(() => null);
    if (!response?.ok) { toast("The account could not be deleted."); return; }
    account = { signedIn: false };
    renderAccount();
    renderConnected();
    toast("Account deleted");
  };
  $("#or-signin").onclick = async () => {
    try { useOpenRouterKey((await openRouterSignIn()).key); }
    catch (e) { toast(e.message); }
  };
  $("#cg-signin").onclick = () => {
    saveAi({ ...ai, provider: "chatgpt", model: ai.provider === "chatgpt" ? ai.model : "", key: "" });
    location.assign("/auth/chatgpt/start");
  };
  $("#cg-signout").onclick = async () => {
    await fetch("/auth/chatgpt/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
    local = await localServer();
    renderAi();
    toast("Signed out of ChatGPT");
  };
  $("#gm-connect").hidden = false;
  $("#gm-connect").onclick = () => connectGmail();
  $("#gm-cancel").onclick = () => gmailRun?.abort();
  $("#gm-forget").onclick = () => {
    imported = { refs: [], purchases: [] };
    store.del(KEYS.purchases);
    applyImports();
    toast("Imported purchases deleted");
  };
  renderImports();

  // Coming back from a sign-in that had to use a full-page redirect (popup blocked).
  const err = new URLSearchParams(location.search).get("chatgpt_error");
  if (err) { toast(err); history.replaceState(null, "", location.pathname + location.hash); }
  const provider = pendingProvider();
  const pending = pendingResult();
  if (pending && provider === "openrouter") {
    try { useOpenRouterKey((await finishOpenRouter(pending)).key); }
    catch (e) { toast(e.message); }
  } else if (pending && provider === "google") {
    try { connectGmail(finishGoogle(pending)); } catch (e) { toast(e.message); }
  }

  await loadAccount();
  local = await localServer();
  if (local?.chatgpt?.signed_in && ai.provider !== "chatgpt" && !ai.key) saveAi({ ...ai, provider: "chatgpt", model: "", key: "" });
  renderAi();
}

// ------------------------------------------------------------------ Gmail import
function applyImports() {
  // Replace earlier imported items, keeping whatever the user already confirmed or rejected.
  const decided = new Map([...ctx.owned, ...ctx.facts].filter((x) => x.status !== "unconfirmed").map((x) => [x.id, x.status]));
  const keepOwned = ctx.owned.filter((o) => !String(o.id).startsWith("imp-") || decided.has(o.id));
  const keepFacts = ctx.facts.filter((f) => !/^habits\./.test(f.id) || f.source !== "email" || decided.has(f.id));
  const { owned, facts } = contextFromPurchases(imported.purchases, keepOwned);
  const has = new Set([...keepOwned, ...keepFacts].map((x) => x.id));
  ctx.owned = [...keepOwned, ...owned.filter((o) => !has.has(o.id))];
  ctx.facts = [...keepFacts, ...facts.filter((f) => !has.has(f.id))];
  saveCtx();
  renderFacts();
  renderOwned();
  renderImports();
}
const PRESETS = {
  "apple-opentherm": {
    label: "Apple Home + OpenTherm",
    need: "Matter smart thermostat with OpenTherm for Apple Home",
    owned: [
      { category: "smart-home-hub", brand: "Apple", model: "HomePod mini", notes: "Starter preset: Thread border router. Edit if this is not yours." },
      { category: "boiler", brand: "OpenTherm", model: "Modulating boiler", notes: "Starter preset: confirm the brand on the boiler plate." },
    ],
  },
  "ha-zigbee": {
    label: "Home Assistant + Zigbee/Matter",
    need: "Matter smart plug that also works on Zigbee with Home Assistant",
    owned: [
      { category: "smart-home-hub", brand: "Home Assistant", model: "Zigbee and Thread dongle", notes: "Starter preset: edit the dongle model you actually use." },
    ],
  },
};

function renderConnectProgress() {
  const el = $("#connect-progress");
  if (!el) return;
  const aiReady = aiIsReady();
  const gmailDone = imported.purchases.some((p) => p.status !== "rejected");
  el.className = `small ${aiReady ? "ok" : "muted"}`;
  el.textContent = !aiReady
    ? "Step 1 of 2: connect an AI when you want a live search. A starter preset and a copied brief need no API key."
    : gmailDone
      ? "Step 2 done: Gmail purchases are in your setup as unconfirmed until you approve them."
      : "Step 1 done. Step 2 is optional: import Gmail receipts, or skip it and keep the devices you added.";
}

function applyPreset(id, needText) {
  const preset = PRESETS[id];
  const status = $("#preset-status");
  if (!preset) {
    if (status) { status.className = "small error"; status.textContent = "That starter preset is not available."; }
    return;
  }
  let added = 0;
  for (const item of preset.owned) {
    const exists = ctx.owned.some((o) => o.status !== "rejected" && o.brand === item.brand && o.model === item.model);
    if (exists) continue;
    ctx.owned.push({
      id: uniqueId(`${item.category} ${item.brand} ${item.model}`, new Set(ctx.owned.map((o) => o.id))),
      category: slug(item.category), brand: item.brand, model: item.model, notes: item.notes,
      aliases: [`my ${item.category.replace(/-/g, " ")}`], source: "stated", status: "confirmed", confidence: 1,
    });
    added++;
  }
  if (added) track("setup_add");
  saveCtx();
  renderOwned();
  const need = (needText || "").trim() || preset.need;
  const field = $("#need-text");
  if (field && need) field.value = need;
  if (status) {
    status.className = "small ok";
    status.textContent = `${preset.label} is in your setup${added ? "" : " already"}. No API key needed — copy a brief, or connect an AI for a live search.`;
  }
  renderConnectProgress();
}

function initDeepLink() {
  const params = new URLSearchParams(location.search);
  const preset = params.get("preset");
  const need = params.get("need");
  if (preset) applyPreset(preset, need);
  else if (need && $("#need-text")) $("#need-text").value = need;
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => applyPreset(button.dataset.preset));
  });
}

function renderImports() {
  const items = imported.purchases.filter((p) => p.status !== "rejected");
  $("#gm-list-wrap").hidden = !items.length;
  $("#gm-summary").textContent = `${items.length} imported purchase${items.length === 1 ? "" : "s"}`;
  $("#gm-list").replaceChildren(...items.slice(-200).reverse().map((p) => h("li", {},
    h("div", {}, h("strong", {}, p.productName), h("span", { class: "small muted" },
      ` · ${[p.merchant, p.orderDate, p.unitPrice != null ? money(p.unitPrice, p.currency) : null, p.kind].filter(Boolean).join(" · ")}`)),
    h("div", { class: "owned-actions" }, h("button", { type: "button", class: "icon", title: "Delete", "aria-label": `Delete ${p.productName}`,
      onclick: () => { p.status = "rejected"; store.set(KEYS.purchases, imported); applyImports(); } }, "🗑")))));
  renderConnectProgress();
}
function sinceLabel(value) {
  const option = [...($("#gm-since")?.options || [])].find((item) => item.value === value);
  return option?.textContent?.trim() || "2 years";
}
function setImportProgress(value, max) {
  const box = $("#gm-progress");
  const bar = $("#gm-bar");
  const fill = $("#gm-bar-fill");
  if (!box || !bar || !fill) return;
  box.hidden = false;
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((Number(value) / Number(max)) * 100))) : 0;
  bar.setAttribute("aria-valuenow", String(pct));
  bar.setAttribute("aria-valuetext", `${pct}%`);
  fill.style.width = `${pct}%`;
}
function hideImportProgress() {
  const box = $("#gm-progress");
  if (box) box.hidden = true;
}
function keepPurchases(rep) {
  if (!rep) return 0;
  imported.refs = [...new Set([...imported.refs, ...(rep.refs || [])])];
  imported.purchases.push(...(rep.purchases || []));
  if (!store.set(KEYS.purchases, imported)) toast("Couldn't save imports in this browser (storage full or blocked)");
  applyImports();
  return rep.purchases?.length || 0;
}
function importDone(count, skipped) {
  const status = $("#gm-status");
  status.className = "small ok";
  status.replaceChildren(
    `Done: ${count} item${count === 1 ? "" : "s"} added as `,
    h("span", { class: "tag warn" }, "UNCONFIRMED"),
    ". Review them in ",
    h("a", { href: "#setup" }, "Your setup"),
    ".",
    skipped ? ` ${skipped} message${skipped === 1 ? "" : "s"} skipped.` : ""
  );
}
async function connectGmail(grant) {
  const st = $("#gm-status");
  if (!aiIsReady() || gmailRunning) {
    syncConnection();
    if (!aiIsReady()) document.getElementById("ai")?.scrollIntoView({ block: "start" });
    return;
  }
  let llm;
  try { llm = advisorClient(); } catch (e) {
    st.dataset.gate = "result";
    st.className = "small error";
    st.textContent = e.message;
    return;
  }
  const ctrl = new AbortController();
  gmailRun = ctrl;
  gmailRunning = true;
  $("#gmail")?.setAttribute("aria-busy", "true");
  $("#gm-cancel").hidden = false;
  syncConnection();
  st.dataset.gate = "run";
  st.className = "small";
  st.textContent = "Signing in to Gmail";
  setImportProgress(0, 1);
  try {
    try {
      grant = grant || await googleSignIn(CONFIG.googleClientId);
    } catch (e) {
      st.dataset.gate = "result";
      st.className = "small error";
      st.textContent = e.message;
      hideImportProgress();
      return;
    }
    track("gmail_import_start");
    const rep = await importGmail({
      token: grant.token, llm, since: $("#gm-since").value, max: 150, seenRefs: new Set(imported.refs),
      providerLabel: PROVIDERS[ai.provider]?.label || "your AI", signal: ctrl.signal,
      onStep: (update) => {
        st.className = "small";
        st.textContent = update.text;
        setImportProgress(update.value, update.max);
      },
    });
    keepPurchases(rep);
    track("gmail_import");
    st.dataset.gate = "result";
    if (rep.listed === 0) {
      st.className = "small";
      st.textContent = `No receipts found in the last ${sinceLabel($("#gm-since").value)}.`;
    } else importDone(rep.purchases.length, rep.failed);
    setImportProgress(1, 1);
  } catch (e) {
    st.dataset.gate = "result";
    if (e.name === "AbortError") {
      const kept = keepPurchases(e.partial);
      track("gmail_import_cancel");
      st.className = "small";
      if (kept) {
        st.replaceChildren(
          `Stopped. ${kept} item${kept === 1 ? "" : "s"} already added as `,
          h("span", { class: "tag warn" }, "UNCONFIRMED"),
          ". Review them in ",
          h("a", { href: "#setup" }, "Your setup"),
          "."
        );
      } else st.textContent = "Stopped.";
    } else {
      st.className = "small error";
      st.textContent = e.message;
      hideImportProgress();
    }
  } finally {
    gmailRunning = false;
    gmailRun = null;
    $("#gmail")?.setAttribute("aria-busy", "false");
    $("#gm-cancel").hidden = true;
    syncConnection();
  }
}

// ------------------------------------------------------------------ open in the user's own chat
const CHAT_URLS = { claude: "https://claude.ai/new?q=", chatgpt: "https://chatgpt.com/?q=" };
function openInChat(which, needText = null) {
  const prompt = exportPrompt(ctx, needText);
  if (prompt.length > 7000) {
    copy(prompt, "Prompt (too long for a link)");
    window.open(CHAT_URLS[which].replace(/[?]q=$/, ""), "_blank", "noopener");
    return;
  }
  window.open(CHAT_URLS[which] + encodeURIComponent(prompt), "_blank", "noopener");
}

// ------------------------------------------------------------------ needs + results
function cancelRun() {
  const current = running;
  running = null;
  current?.controller.abort();
}

function renderChips() {
  const box = $("#need-chips");
  const active = ctx.needs.filter((n) => n.status === "active");
  box.replaceChildren(...active.map((n) => h("span", { class: "chip" },
    h("button", { type: "button", class: "chip-main", onclick: () => run(n) }, n.text + (n.budget_max ? ` · ≤ ${money(n.budget_max, n.currency)}` : "")),
    h("button", { type: "button", class: "chip-x", title: "Remove", "aria-label": `Remove ${n.text}`, onclick: () => { if (running?.needId === n.id) cancelRun();
      ctx.needs = ctx.needs.filter((x) => x.id !== n.id);
      delete results[n.id];
      delete audits[n.id];
      saveCtx();
      saveResults();
      renderChips();
      if (!running) renderResults(); } }, "×"))));
}

function noAiPanel(need, message) {
  return h("div", { class: "card notice-card" },
    h("h3", {}, "Connect an AI to search live deals"),
    h("p", { class: "muted" }, message),
    h("p", {}, "DealFactory uses your own AI. Sign in with OpenRouter in one click, or take this search to the Claude or ChatGPT you already use: it opens with your setup and the honesty rules filled in."),
    h("div", { class: "row" },
      h("button", { type: "button", class: "primary", onclick: () => $("#or-signin").click() }, "Sign in with OpenRouter"),
      h("button", { type: "button", class: "secondary", onclick: () => openInChat("claude", need.text) }, "Open in Claude"),
      h("button", { type: "button", class: "secondary", onclick: () => openInChat("chatgpt", need.text) }, "Open in ChatGPT")),
    h("div", { class: "row" },
      h("button", { type: "button", class: "primary", onclick: () => {
        const budget = money(need.budget_max, need.currency);
        track("brief_export");
        copy(exportPrompt(ctx, budget ? `${need.text} (budget ${budget})` : need.text), "Prompt");
      } }, "Copy prompt for my chat"),
      h("a", { class: "button secondary", href: "#connect" }, "Other ways to connect")));
}

async function run(need) {
  cancelRun();
  need = { ...need };
  let llm;
  try {
    llm = advisorClient();
    track("search_run");
  } catch (e) {
    results[need.id] = { kind: "noai", need, message: e.message };
    renderResults(need.id);
    return;
  }
  const ctrl = new AbortController();
  running = { controller: ctrl, needId: need.id };
  const started = Date.now();
  const status = h("p", { class: "step" }, "Starting…");
  const timer = h("span", { class: "muted small" });
  const tick = setInterval(() => { timer.textContent = ` ${Math.round((Date.now() - started) / 1000)} s`; }, 1000);
  $("#results").replaceChildren(h("div", { class: "card running" }, h("h2", {}, need.text),
    h("div", { class: "spinner", "aria-hidden": "true" }), status, timer,
    h("button", { type: "button", class: "secondary", onclick: () => ctrl.abort() }, "Stop")));
  $("#results").scrollIntoView({ block: "start" });
  try {
    const res = await findDeals(llm, structuredClone(ctx), need, { onStep: (s) => { status.textContent = s; }, signal: ctrl.signal });
    if (running?.controller !== ctrl) return;
    ctrl.signal.throwIfAborted();
    audits[need.id] = res.audit;
    results[need.id] = res;
    saveResults();
    renderResults(need.id);
  } catch (e) {
    if (running?.controller !== ctrl) return;
    $("#results").replaceChildren(h("div", { class: "card error-card" }, h("h3", {}, e.name === "AbortError" ? "Stopped." : "Something went wrong"),
      e.name === "AbortError" ? null : h("p", {}, e instanceof LLMError ? e.message : `${e.message}`),
      h("button", { type: "button", class: "secondary", onclick: () => run(need) }, "Try again")));
  } finally {
    clearInterval(tick);
    if (running?.controller === ctrl) running = null;
  }
}

function sourceLink(url, label) {
  return h("a", { href: url, target: "_blank", rel: "noopener noreferrer nofollow", class: "src" }, label || host(url));
}
function verif(v) {
  return v === "cited" ? h("span", { class: "cited", title: "Cited from a search result; the page itself wasn't read" }, "*") : null;
}

const ROLE = { top: "Top pick", budget: "Budget pick", premium: "Premium pick", alternative: "Alternative" };

function renderPick(p) {
  const ownedName = (id) => { const o = ctx.owned.find((x) => x.id === id); return o ? `${o.brand} ${o.model}` : id; };
  const best = p.offers.find((o) => o.price != null);
  return h("article", { class: `card pick ${p.role}` },
    h("div", { class: "pick-head" }, h("span", { class: "role" }, ROLE[p.role] || p.role), tag("judgement", "AI judgement")),
    h("h3", { class: "name" }, p.product),
    (p.brand || p.model) ? h("div", { class: "small muted" }, [p.brand, p.model].filter(Boolean).join(" · ")) : null,
    best ? h("div", { class: "price" }, tag("fact", best.priceVerification === "verified" ? "Quote matched" : "Cited price"), h("strong", {}, money(best.price, best.currency)), verif(best.priceVerification),
      h("span", { class: "small" }, " at ", sourceLink(best.url, best.retailer)), h("span", { class: "small muted" }, ` · read ${when(best.retrievedAt)}`))
      : h("div", { class: "price" }, h("span", { class: "cell-unknown" }, "price unknown"), p.offers[0] ? h("span", { class: "small" }, " · ", sourceLink(p.offers[0].url, p.offers[0].retailer)) : null),
    h("p", { class: "why" }, p.whyItFits),
    p.compat.length ? h("ul", { class: "compat" }, p.compat.map((c) => h("li", {},
      c.status === "compatible" ? h("span", { class: "ok" }, "✓ ") : c.status === "incompatible" ? h("span", { class: "bad" }, "✕ ") : h("span", { class: "cell-unknown" }, "? "),
      `${c.status === "unknown" ? "Fit with" : c.status === "compatible" ? "May fit" : "May not fit"} ${ownedName(c.ownedId)}`,
      c.status === "unknown" ? h("span", { class: "cell-unknown" }, ": unknown") : [" ", tag("judgement", "AI assessment"), verif(c.verification), " ", sourceLink(c.url),
        c.quote ? h("div", { class: "quote" }, `“${c.quote}”`) : null]))) : null,
    p.specs.length ? h("details", {}, h("summary", {}, `Specs (${p.specs.filter((s) => s.status === "known").length}/${p.specs.length} sourced)`),
      h("dl", { class: "specs" }, p.specs.map((s) => [h("dt", {}, s.name), h("dd", {}, s.status === "known"
        ? [s.value, verif(s.verification), " ", sourceLink(s.url)] : h("span", { class: "cell-unknown" }, "unknown"))]))) : null,
    p.offers.length > 1 ? h("details", {}, h("summary", {}, `${p.offers.length} offers`),
      h("table", { class: "offers" }, h("tbody", {}, p.offers.map((o) => h("tr", {},
        h("td", {}, sourceLink(o.url, o.retailer)),
        h("td", { class: "num" }, o.price != null ? [money(o.price, o.currency), verif(o.priceVerification)] : h("span", { class: "cell-unknown" }, "unknown"))))))) : null,
    p.tradeoffs.length ? h("div", { class: "tradeoffs" }, h("span", { class: "small muted" }, "Trade-offs: "), p.tradeoffs.join(" · ")) : null);
}

function renderResult(res) {
  const n = res.need;
  if (res.kind === "noai") return noAiPanel(n, res.message);
  const head = h("div", { class: "result-head" }, h("h2", {}, n.text),
    h("div", { class: "small muted" }, [res.location?.city, res.location?.country].filter(Boolean).join(", "),
      res.finishedAt ? ` · ${when(res.finishedAt)}` : "",
      " · ", h("button", { type: "button", class: "link", onclick: () => run(n) }, "Refresh"),
      audits[n.id] ? [" · ", h("button", { type: "button", class: "link", onclick: () => download(`dealfactory-run-${n.id}.json`, { ...res, audit: audits[n.id] }) }, "Download audit")] : null));
  if (res.kind === "checklist") {
    const c = res.checklist;
    const gl = (res.location.country || "").toLowerCase();
    const list = (title, items) => items?.length ? [h("h3", {}, title), h("ul", {}, items.map((i) => h("li", {}, typeof i === "string" ? i : i.check)))] : null;
    return h("div", {}, head, h("div", { class: "card judgement-panel" }, tag("judgement", "AI judgement · no live data"),
      list("Must have", c.must_have), list("Nice to have", c.nice_to_have), list("Avoid", c.avoid),
      list("Check against what you own", c.compatibility_checks), list("Questions to answer first", c.questions_for_you),
      c.search_terms?.length ? [h("h3", {}, "Search"), h("div", { class: "row wrap-row" }, c.search_terms.map((t) =>
        sourceLink(`https://www.google.com/search?tbm=shop&gl=${gl}&q=${encodeURIComponent(t)}`, `${t} ↗`)))] : null));
  }
  const top = res.picks.find((p) => p.role === "top");
  const rest = res.picks.filter((p) => p !== top);
  return h("div", {}, head,
    res.warnings?.length ? h("div", { class: "notice warn" }, res.warnings.map((w) => h("div", {}, `⚠ ${w}`))) : null,
    !res.picks.length ? h("div", { class: "card" }, h("p", {}, "No product survived the source checks. Your AI didn't find pages that back up its suggestions. Try again, give more detail, or switch to a model with web search.")) : null,
    top ? renderPick(top) : null,
    rest.length ? h("div", { class: "grid picks" }, rest.map(renderPick)) : null,
    res.caveats?.length ? h("div", { class: "card small judgement-panel" }, tag("judgement", "AI judgement"), h("ul", {}, res.caveats.map((c) => h("li", {}, c)))) : null,
    res.notRecommended?.length ? h("details", { class: "card small" }, h("summary", {}, "Not recommended"),
      h("ul", {}, res.notRecommended.map((x) => h("li", {}, h("strong", {}, x.product_name), `: ${x.reason}`)))) : null,
    res.dropped?.length ? h("details", { class: "card small" }, h("summary", {}, `${res.dropped.length} suggestion(s) dropped: no source`),
      h("ul", {}, res.dropped.map((d) => h("li", {}, `${d.product}: ${d.reason}`)))) : null,
    res.sources?.length ? h("details", { class: "card small" }, h("summary", {}, `${res.sources.length} sources`),
      h("ol", { class: "sources" }, res.sources.map((s) => h("li", {}, sourceLink(s.url, s.title || s.url), h("span", { class: "muted" }, ` · ${s.hasPage ? "page read" : "search result"}`))))) : null);
}

function renderResults(focusId) {
  const box = $("#results");
  const id = focusId || Object.keys(results).at(-1);
  box.replaceChildren(id && results[id] ? renderResult(results[id]) : "");
}

function initNeeds() {
  $("#need-form").onsubmit = (e) => {
    e.preventDefault();
    const text = $("#need-text").value.trim();
    if (!text) return;
    const budget = $("#need-budget").value ? Number($("#need-budget").value) : null;
    let need = ctx.needs.find((n) => n.status === "active" && n.text.toLowerCase() === text.toLowerCase());
    if (!need) {
      need = { id: uniqueId(text, new Set(ctx.needs.map((n) => n.id))), text, status: "active", budget_max: budget,
               currency: budget ? ctx.location.currency || null : null };
      ctx.needs.push(need);
    } else if (budget != null) {
      need.budget_max = budget;
      need.currency = ctx.location.currency || null;
    }
    saveCtx();
    renderChips();
    $("#need-text").value = "";
    $("#need-budget").value = "";
    run(need);
  };
  renderChips();
  renderResults();
}

// ------------------------------------------------------------------ portability
function renderMcp() {
  if (CONFIG.connectorUrl) { $("#connector-line").hidden = false; $("#connector-url").textContent = new URL(CONFIG.connectorUrl, location.origin).href; }
  const cfg = { mcpServers: { dealfactory: { command: "dealfactory", args: ["mcp", "--context", "/path/to/shopping-context.json"] } } };
  $("#mcp-snippet").textContent = `# install once (needs Python + uv):\n#   uv tool install git+https://github.com/jaspreetsingh0792/dealfactory\n${JSON.stringify(cfg, null, 2)}`;
}
function initPortability() {
  $("#export-copy").onclick = () => { track("brief_export"); copy(exportPrompt(ctx), "Prompt"); };
  $("#open-claude").onclick = () => openInChat("claude");
  $("#open-chatgpt").onclick = () => openInChat("chatgpt");
  $("#export-download").onclick = () => { track("brief_export"); download("shopping-context.json", shareable(ctx)); };
  $("#import-prompt").onclick = () => copy(IMPORT_PROMPT, "Request");
  const apply = (text, fromAssistant) => {
    const st = $("#import-status");
    try {
      const incoming = normalizeContext(parseAssistantReply(text), { fromAssistant });
      const { context, changes } = mergeContext(ctx, incoming);
      ctx = context;
      saveCtx();
      renderLocation(); renderFacts(); renderOwned(); renderChips();
      st.className = "small ok";
      st.textContent = `Imported ${changes.owned} owned item(s), ${changes.facts} fact(s), ${changes.needs} need(s)` +
        (fromAssistant ? ". Please confirm or reject them under Your setup." : ".");
      $("#import-text").value = "";
    } catch (e) {
      st.className = "small error";
      st.textContent = `Couldn't import: ${e.message}`;
    }
  };
  $("#import-apply").onclick = () => apply($("#import-text").value, true);
  $("#import-file").onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    let raw = null;
    try { raw = JSON.parse(text); } catch { /* handled by apply */ }
    // A file written by DealFactory keeps its provenance; anything else counts as an assistant's guess.
    apply(text, !(raw && /^dealfactory/.test(raw.generator || "")));
    e.target.value = "";
  };
  $("#mcp-copy").onclick = () => copy($("#mcp-snippet").textContent.split("\n").filter((l) => !l.startsWith("#")).join("\n"), "MCP config");
  $("#wipe").onclick = () => {
    if (!window.confirm("Delete your shopping setup, imported purchases, searches, results and API key from this browser?")) return;
    cancelRun();
    for (const id of Object.keys(audits)) delete audits[id];
    for (const k of [...Object.values(KEYS), legacyResultsKey]) { store.del(k); if (session) store.del(k, session); }
    ctx = emptyContext(); results = {}; imported = { refs: [], purchases: [] }; renderImports(); ai = { provider: "openrouter", model: PROVIDERS.openrouter.defaultModel, baseUrl: "", remember: false, key: "" };
    renderLocation(); renderFacts(); renderOwned(); renderChips(); renderResults(); renderAi();
    toast("Everything stored in this browser was deleted");
  };
}

refreshAi();
window.addEventListener("storage", (event) => {
  if (event.key && event.key !== KEYS.ai && event.key !== KEYS.key) return;
  refreshAi();
  renderAi();
});
window.addEventListener("pageshow", () => { refreshAi(); renderAi(); });
initLocation();
initSetup();
initDeepLink();
initAi();
initNeeds();
initPortability();
initConnect();
