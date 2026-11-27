// Hosted sign-in and the free built-in model. Secrets stay in Worker env vars.
// Login scopes are identity only. Gmail import is a separate browser consent.

import { redact } from "../web/lib/purchases.js";

export const GOOGLE_SCOPES = "openid email profile";
export const GITHUB_SCOPES = "read:user user:email";
export const BUILTIN_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
export const SESSION_COOKIE = "df_session";
const SESSION_DAYS = 30;
const STATE_MINUTES = 10;
const MIN_GAP_MS = 3000;
const MAX_PROMPT_CHARS = 6000;
const MAX_BODY_CHARS = 20000;

const PROVIDERS = {
  google: {
    clientId: "GOOGLE_AUTH_CLIENT_ID",
    secret: "GOOGLE_AUTH_CLIENT_SECRET",
    scopes: GOOGLE_SCOPES,
  },
  github: {
    clientId: "GITHUB_CLIENT_ID",
    secret: "GITHUB_CLIENT_SECRET",
    scopes: GITHUB_SCOPES,
  },
};

function numberEnv(env, name, fallback) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function limits(env) {
  return {
    userLimit: numberEnv(env, "AI_DAILY_USER_LIMIT", 20),
    neuronCeiling: numberEnv(env, "AI_DAILY_NEURON_CEILING", 8000),
    neuronsPerRequest: numberEnv(env, "AI_NEURONS_PER_REQUEST", 20),
  };
}

export function resetsAt(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.toISOString();
}

export function quotaDecision({ used = 0, lastRequestAt = null, now = new Date(), globalNeurons = 0, limit, ceiling, perRequest }) {
  const reset = resetsAt(now);
  if (lastRequestAt && now.getTime() - Date.parse(lastRequestAt) < MIN_GAP_MS) {
    return { ok: false, status: 429, message: "Please wait a moment before the next answer.", resetsAt: reset };
  }
  if (used >= limit) {
    return { ok: false, status: 429, message: `You've used today's ${limit} free answers. The allowance resets at 00:00 UTC.`, resetsAt: reset };
  }
  if (globalNeurons + perRequest > ceiling) {
    return { ok: false, status: 429, message: "The free built-in AI is at today's site limit. It resets at 00:00 UTC, or use your own AI.", resetsAt: reset };
  }
  return { ok: true, resetsAt: reset };
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(size = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(size)));
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

export function authorizeUrl(provider, { clientId, redirectUri, state, challenge }) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error("Unknown sign-in provider.");
  if (provider === "google") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: spec.scopes,
      state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
    }).toString();
    return url.href;
  }
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, scope: spec.scopes, state,
    code_challenge: challenge, code_challenge_method: "S256",
  }).toString();
  return url.href;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

function redirect(location, cookies = []) {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export function sessionCookie(token, { maxAge = SESSION_DAYS * 86400, secure = true } = {}) {
  const parts = [`${SESSION_COOKIE}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure = true) {
  return sessionCookie("", { maxAge: 0, secure });
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function originOf(request) {
  return new URL(request.url).origin;
}

function secureRequest(request) {
  return new URL(request.url).protocol === "https:";
}

async function dbFirst(env, sql, ...args) {
  return env.AUTH.prepare(sql).bind(...args).first();
}

async function dbRun(env, sql, ...args) {
  return env.AUTH.prepare(sql).bind(...args).run();
}

function configured(env, provider) {
  const spec = PROVIDERS[provider];
  return spec && env?.[spec.clientId] && env?.[spec.secret];
}

function setupMessage() {
  return "Sign-in is not set up on this site yet.";
}

async function startLogin(request, env, provider) {
  if (!env?.AUTH || !configured(env, provider)) return json({ message: setupMessage() }, 503);
  const verifier = randomToken(48);
  const state = randomToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + STATE_MINUTES * 60000).toISOString();
  await dbRun(env,
    "INSERT INTO oauth_states (state, provider, verifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    state, provider, verifier, now.toISOString(), expires);
  const redirectUri = `${originOf(request)}/auth/callback/${provider}`;
  const url = authorizeUrl(provider, {
    clientId: env[PROVIDERS[provider].clientId],
    redirectUri,
    state,
    challenge: await codeChallenge(verifier),
  });
  if (provider === "google" && /gmail/i.test(new URL(url).searchParams.get("scope") || "")) {
    return json({ message: "Sign-in refused a Gmail scope." }, 500);
  }
  return redirect(url);
}

async function exchange(provider, env, code, verifier, redirectUri, fetchImpl) {
  if (provider === "google") {
    const body = new URLSearchParams({
      code, client_id: env.GOOGLE_AUTH_CLIENT_ID, client_secret: env.GOOGLE_AUTH_CLIENT_SECRET,
      redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier,
    });
    const token = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
    });
    const tokenBody = await token.json().catch(() => ({}));
    if (!token.ok || !tokenBody.access_token) throw new Error("Google did not return a sign-in token.");
    const profile = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${tokenBody.access_token}` },
    });
    const user = await profile.json().catch(() => ({}));
    if (!profile.ok || !user.sub) throw new Error("Google did not return an account id.");
    return { sub: String(user.sub), email: user.email || null, name: user.name || user.email || "Google" };
  }
  const token = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "DealFactory" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
      code, redirect_uri: redirectUri, code_verifier: verifier,
    }),
  });
  const tokenBody = await token.json().catch(() => ({}));
  if (!token.ok || !tokenBody.access_token) throw new Error("GitHub did not return a sign-in token.");
  const profile = await fetchImpl("https://api.github.com/user", {
    headers: { authorization: `Bearer ${tokenBody.access_token}`, accept: "application/vnd.github+json", "user-agent": "DealFactory" },
  });
  const user = await profile.json().catch(() => ({}));
  if (!profile.ok || user.id == null) throw new Error("GitHub did not return an account id.");
  let email = user.email || null;
  if (!email) {
    const emails = await fetchImpl("https://api.github.com/user/emails", {
      headers: { authorization: `Bearer ${tokenBody.access_token}`, accept: "application/vnd.github+json", "user-agent": "DealFactory" },
    });
    const list = emails.ok ? await emails.json().catch(() => []) : [];
    const primary = Array.isArray(list) ? list.find((item) => item.primary && item.verified) : null;
    email = primary?.email || null;
  }
  return { sub: String(user.id), email, name: user.name || user.login || "GitHub" };
}

async function finishLogin(request, env, provider, fetchImpl) {
  if (!env?.AUTH || !configured(env, provider)) return json({ message: setupMessage() }, 503);
  const query = new URL(request.url).searchParams;
  const state = query.get("state") || "";
  const code = query.get("code") || "";
  if (!state || !code || query.get("error")) return redirect(`${originOf(request)}/advisor/#connect`);
  const saved = await dbFirst(env, "SELECT provider, verifier, expires_at FROM oauth_states WHERE state = ?", state);
  await dbRun(env, "DELETE FROM oauth_states WHERE state = ?", state);
  if (!saved || saved.provider !== provider || Date.parse(saved.expires_at) < Date.now()) {
    return redirect(`${originOf(request)}/advisor/#connect`);
  }
  let profile;
  try {
    profile = await exchange(provider, env, code, saved.verifier, `${originOf(request)}/auth/callback/${provider}`, fetchImpl);
  } catch {
    return redirect(`${originOf(request)}/advisor/#connect`);
  }
  const now = new Date().toISOString();
  await dbRun(env,
    "INSERT INTO users (id, provider, provider_sub, email, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(provider, provider_sub) DO UPDATE SET email = excluded.email, display_name = excluded.display_name",
    crypto.randomUUID(), provider, profile.sub, profile.email, String(profile.name || "").slice(0, 80), now);
  const user = await dbFirst(env, "SELECT id FROM users WHERE provider = ? AND provider_sub = ?", provider, profile.sub);
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await dbRun(env, "INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    await sha256(token), user.id, now, expires);
  return redirect(`${originOf(request)}/advisor/#connect`, [sessionCookie(token, { secure: secureRequest(request) })]);
}

async function userFromRequest(request, env) {
  if (!env?.AUTH) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const session = await dbFirst(env, "SELECT user_id, expires_at FROM sessions WHERE id_hash = ?", await sha256(token));
  if (!session || Date.parse(session.expires_at) < Date.now()) return null;
  return dbFirst(env, "SELECT id, provider, email, display_name, created_at FROM users WHERE id = ?", session.user_id);
}

async function allowanceFor(env, userId, now = new Date()) {
  const { userLimit } = limits(env);
  const day = now.toISOString().slice(0, 10);
  const row = await dbFirst(env, "SELECT requests FROM ai_usage WHERE user_id = ? AND day = ?", userId, day);
  const used = row?.requests || 0;
  return { limit: userLimit, used, remaining: Math.max(0, userLimit - used), resetsAt: resetsAt(now) };
}

async function sessionResponse(request, env) {
  if (!env?.AUTH) return json({ signedIn: false });
  const user = await userFromRequest(request, env);
  if (!user) return json({ signedIn: false });
  return json({
    signedIn: true,
    provider: user.provider,
    displayName: user.display_name || "",
    allowance: await allowanceFor(env, user.id),
  });
}

async function logout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (env?.AUTH && token) await dbRun(env, "DELETE FROM sessions WHERE id_hash = ?", await sha256(token));
  return json({ signedIn: false }, 200, { "set-cookie": clearSessionCookie(secureRequest(request)) });
}

async function deleteAccount(request, env) {
  if (!env?.AUTH) return json({ message: setupMessage() }, 503);
  const user = await userFromRequest(request, env);
  if (!user) return json({ message: "Sign in first." }, 401);
  await dbRun(env, "DELETE FROM sessions WHERE user_id = ?", user.id);
  await dbRun(env, "DELETE FROM ai_usage WHERE user_id = ?", user.id);
  await dbRun(env, "DELETE FROM users WHERE id = ?", user.id);
  return json({ deleted: true }, 200, { "set-cookie": clearSessionCookie(secureRequest(request)) });
}

function extraTerms(user) {
  const terms = [];
  const email = user?.email || "";
  if (email.includes("@")) terms.push(email, email.split("@")[0]);
  const name = user?.display_name || "";
  if (name && !name.includes("@") && name.length >= 3) terms.push(name);
  return terms.filter((term) => term && term.length >= 3);
}

async function answer(request, env, fetchImpl) {
  if (!env?.AUTH) return json({ message: "Built-in AI is not set up yet. You can still use your own AI." }, 503);
  const user = await userFromRequest(request, env);
  if (!user) return json({ message: "Sign in to use the free built-in AI." }, 401);
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return json({ message: "That request is too long." }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ message: "Send a JSON request." }, 400); }
  const system = redact(String(body.system || ""), extraTerms(user)).slice(0, MAX_PROMPT_CHARS);
  const prompt = redact(String(body.prompt || ""), extraTerms(user)).slice(0, MAX_PROMPT_CHARS);
  if (!prompt) return json({ message: "The request was empty." }, 400);
  if (!env.AI) return json({ message: "Built-in AI is not set up yet. You can still use your own AI." }, 503);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const cap = limits(env);
  const usage = await dbFirst(env, "SELECT requests, last_request_at FROM ai_usage WHERE user_id = ? AND day = ?", user.id, day);
  const global = await dbFirst(env, "SELECT neurons FROM ai_usage_global WHERE day = ?", day);
  const decision = quotaDecision({
    used: usage?.requests || 0,
    lastRequestAt: usage?.last_request_at || null,
    now,
    globalNeurons: global?.neurons || 0,
    limit: cap.userLimit,
    ceiling: cap.neuronCeiling,
    perRequest: cap.neuronsPerRequest,
  });
  if (!decision.ok) return json({ message: decision.message, resetsAt: decision.resetsAt }, decision.status);
  let result;
  try {
    result = await env.AI.run(BUILTIN_MODEL, {
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      max_tokens: 600,
    });
  } catch {
    return json({ message: "The built-in AI did not answer. Try again, or use your own AI." }, 502);
  }
  const text = String(result?.response || result?.result || "");
  if (!text) return json({ message: "The built-in AI returned an empty answer." }, 502);
  await dbRun(env,
    "INSERT INTO ai_usage (user_id, day, requests, last_request_at) VALUES (?, ?, 1, ?) " +
    "ON CONFLICT(user_id, day) DO UPDATE SET requests = requests + 1, last_request_at = excluded.last_request_at",
    user.id, day, now.toISOString());
  await dbRun(env,
    "INSERT INTO ai_usage_global (day, neurons, requests) VALUES (?, ?, 1) " +
    "ON CONFLICT(day) DO UPDATE SET neurons = neurons + excluded.neurons, requests = requests + 1",
    day, cap.neuronsPerRequest);
  const allowance = await allowanceFor(env, user.id, now);
  return json({ text, allowance });
}

export default {
  async fetch(request, env, fetchImpl = globalThis.fetch) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/auth/login/google" && request.method === "GET") return startLogin(request, env, "google");
    if (path === "/auth/login/github" && request.method === "GET") return startLogin(request, env, "github");
    if (path === "/auth/callback/google" && request.method === "GET") return finishLogin(request, env, "google", fetchImpl);
    if (path === "/auth/callback/github" && request.method === "GET") return finishLogin(request, env, "github", fetchImpl);
    if (path === "/auth/session" && request.method === "GET") return sessionResponse(request, env);
    if (path === "/auth/logout" && request.method === "POST") return logout(request, env);
    if (path === "/auth/account" && request.method === "DELETE") return deleteAccount(request, env);
    if (path === "/api/ai" && request.method === "POST") return answer(request, env, fetchImpl);
    return json({ message: "Not found." }, 404);
  },
};
