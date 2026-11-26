// Sign-in flows that work without a DealFactory server.
//
//   Google (Gmail, read-only)  OAuth 2.0 token flow for browser apps. The token lives in memory only
//                              (about 1 hour) and is used for nothing but reading purchase emails.
//   OpenRouter                 OAuth PKCE. Gives the visitor a key on their own OpenRouter account
//                              (Claude, GPT and other models). Stored like a pasted key.
//
// Both open a popup on this site's oauth.html, which passes the result back with postMessage
// (same origin only) and closes. If popups are blocked, the whole page redirects instead.

import { CONFIG } from "../config.js";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const PENDING = "dealfactory.oauth.pending";
const FLOW = "dealfactory.oauth.flow";

export const callbackUrl = () => new URL(CONFIG.callbackPath, location.href).href;

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function pkceChallenge(verifier) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function saveFlow(flow) { try { sessionStorage.setItem(FLOW, JSON.stringify(flow)); } catch { /* popup still works */ } }
function takeFlow() {
  try { const f = JSON.parse(sessionStorage.getItem(FLOW)); sessionStorage.removeItem(FLOW); return f; } catch { return null; }
}

// Open `url` in a popup and wait for oauth.html to post back. Falls back to a full redirect.
function popup(url, flow) {
  saveFlow({ ...flow, returnPath: location.pathname });
  const w = window.open(url, "dealfactory-auth", "popup,width=520,height=720");
  if (!w) {
    location.assign(url);
    return new Promise(() => {});
  }
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      if (e.source !== w || e.origin !== location.origin || e.data?.type !== "dealfactory-oauth") return;
      cleanup();
      resolve(e.data);
    };
    const timer = setInterval(() => { if (w.closed) { cleanup(); reject(new Error("Sign-in window was closed.")); } }, 700);
    const cleanup = () => { clearInterval(timer); window.removeEventListener("message", onMsg); takeFlow(); };
    window.addEventListener("message", onMsg);
  });
}

// After a full-page redirect (popup blocked), oauth.html stores the result and sends us back here.
export function pendingResult() {
  try {
    const raw = sessionStorage.getItem(PENDING);
    sessionStorage.removeItem(PENDING);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function params(result) {
  const p = new URLSearchParams(result.search || "");
  for (const [k, v] of new URLSearchParams((result.hash || "").replace(/^#/, ""))) p.set(k, v);
  return p;
}

// ------------------------------------------------------------------ Google
export async function googleSignIn(clientId) {
  if (!clientId) throw new Error("Gmail import isn't set up on this site yet (no Google client ID in config.js).");
  const state = randomString(16);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl(), response_type: "token",
    scope: GMAIL_SCOPE, include_granted_scopes: "false", state, prompt: "consent" }).toString();
  return finishGoogle(await popup(url.href, { provider: "google", state }), state);
}

export function finishGoogle(result, state = takeFlow()?.state) {
  const p = params(result);
  if (p.get("error")) throw new Error(p.get("error") === "access_denied" ? "Gmail access was not granted." : `Google said: ${p.get("error")}`);
  if (!state || p.get("state") !== state) throw new Error("Sign-in response didn't match this session. Try again.");
  const scopes = (p.get("scope") || "").split(/\s+/).filter(Boolean);
  if (!scopes.includes(GMAIL_SCOPE) || scopes.some((s) => s !== GMAIL_SCOPE)) throw new Error("Google did not grant the requested read-only Gmail permission.");
  if (!p.get("access_token")) throw new Error("Google didn't return a token.");
  return { token: p.get("access_token"), expiresAt: Date.now() + (Number(p.get("expires_in")) || 3600) * 1000 };
}

// ------------------------------------------------------------------ OpenRouter
export async function openRouterSignIn() {
  const verifier = randomString(48);
  const state = randomString(16);
  const url = new URL("https://openrouter.ai/auth");
  url.search = new URLSearchParams({ callback_url: callbackUrl(), code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256", state, key_label: "DealFactory" }).toString();
  return finishOpenRouter(await popup(url.href, { provider: "openrouter", state, verifier }), { state, verifier });
}

export async function finishOpenRouter(result, flow = takeFlow()) {
  const p = params(result);
  if (!flow?.verifier || (p.get("state") && p.get("state") !== flow.state)) throw new Error("Sign-in response didn't match this session. Try again.");
  const code = p.get("code");
  if (!code) throw new Error("OpenRouter didn't return a code.");
  const r = await fetch("https://openrouter.ai/api/v1/auth/keys", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: flow.verifier, code_challenge_method: "S256" }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.key) throw new Error(`OpenRouter said ${r.status}: ${data?.error?.message || "no key returned"}`);
  return { key: data.key };
}

export function pendingProvider() {
  try { return JSON.parse(sessionStorage.getItem(FLOW))?.provider || null; } catch { return null; }
}
