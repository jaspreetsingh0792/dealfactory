import assert from "node:assert/strict";
import test from "node:test";

import account, { authorizeUrl, GOOGLE_SCOPES, quotaDecision } from "../../ops/account.js";

function memoryAuth() {
  const tables = { oauth_states: [], users: [], sessions: [], ai_usage: [], ai_usage_global: [] };
  return {
    prepare(sql) {
      return { bind(...args) {
        return {
          async run() {
            if (sql.startsWith("INSERT INTO oauth_states")) {
              tables.oauth_states.push({ state: args[0], provider: args[1], verifier: args[2], created_at: args[3], expires_at: args[4] });
            } else if (sql.startsWith("DELETE FROM oauth_states")) {
              tables.oauth_states = tables.oauth_states.filter((row) => row.state !== args[0]);
            } else if (sql.startsWith("INSERT INTO users")) {
              const existing = tables.users.find((row) => row.provider === args[1] && row.provider_sub === args[2]);
              if (existing) { existing.email = args[3]; existing.display_name = args[4]; }
              else tables.users.push({ id: args[0], provider: args[1], provider_sub: args[2], email: args[3], display_name: args[4], created_at: args[5] });
            } else if (sql.startsWith("INSERT INTO sessions")) {
              tables.sessions.push({ id_hash: args[0], user_id: args[1], created_at: args[2], expires_at: args[3] });
            } else if (sql.startsWith("DELETE FROM sessions WHERE id_hash")) {
              tables.sessions = tables.sessions.filter((row) => row.id_hash !== args[0]);
            } else if (sql.startsWith("DELETE FROM sessions WHERE user_id")) {
              tables.sessions = tables.sessions.filter((row) => row.user_id !== args[0]);
            } else if (sql.startsWith("DELETE FROM ai_usage")) {
              tables.ai_usage = tables.ai_usage.filter((row) => row.user_id !== args[0]);
            } else if (sql.startsWith("DELETE FROM users")) {
              tables.users = tables.users.filter((row) => row.id !== args[0]);
            } else if (sql.startsWith("INSERT INTO ai_usage_global")) {
              const row = tables.ai_usage_global.find((item) => item.day === args[0]);
              if (row) { row.neurons += args[1]; row.requests += 1; }
              else tables.ai_usage_global.push({ day: args[0], neurons: args[1], requests: 1 });
            } else if (sql.startsWith("INSERT INTO ai_usage ")) {
              const row = tables.ai_usage.find((item) => item.user_id === args[0] && item.day === args[1]);
              if (row) { row.requests += 1; row.last_request_at = args[2]; }
              else tables.ai_usage.push({ user_id: args[0], day: args[1], requests: 1, last_request_at: args[2] });
            }
          },
          async first() {
            if (sql.includes("oauth_states")) return tables.oauth_states.find((row) => row.state === args[0]) || null;
            if (sql.includes("ai_usage_global")) return tables.ai_usage_global.find((row) => row.day === args[0]) || null;
            if (sql.includes("FROM ai_usage")) return tables.ai_usage.find((row) => row.user_id === args[0] && row.day === args[1]) || null;
            if (sql.includes("FROM sessions")) return tables.sessions.find((row) => row.id_hash === args[0]) || null;
            if (sql.includes("provider_sub")) return tables.users.find((row) => row.provider === args[0] && row.provider_sub === args[1]) || null;
            if (sql.includes("FROM users")) return tables.users.find((row) => row.id === args[0]) || null;
            return null;
          },
        };
      } };
    },
  };
}

const env = {
  AUTH: memoryAuth(),
  GOOGLE_AUTH_CLIENT_ID: "test-google-client",
  GOOGLE_AUTH_CLIENT_SECRET: "test-google-secret",
  AI_DAILY_USER_LIMIT: "20",
  AI_DAILY_NEURON_CEILING: "8000",
  AI_NEURONS_PER_REQUEST: "20",
};

test("Google sign-in asks only for identity and keeps a session", async () => {
  const start = await account.fetch(new Request("https://deals.agentsealteam.com/auth/login/google"), env);
  const location = new URL(start.headers.get("location"));
  assert.equal(location.origin, "https://accounts.google.com");
  assert.equal(location.searchParams.get("scope"), GOOGLE_SCOPES);
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(location.searchParams.get("redirect_uri"), "https://deals.agentsealteam.com/auth/callback/google");
  assert.equal(location.href.includes("gmail"), false);
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(String(url));
    if (String(url).endsWith("/token")) {
      const body = String(options.body);
      assert.equal(body.includes("code_verifier="), true);
      assert.equal(body.includes("gmail"), false);
      return Response.json({ access_token: "token" });
    }
    return Response.json({ sub: "google-sub", email: "ada@example.com", name: "Ada" });
  };
  const callback = await account.fetch(new Request(
    `https://deals.agentsealteam.com/auth/callback/google?code=abc&state=${location.searchParams.get("state")}`
  ), env, fetchImpl);
  const cookie = callback.headers.get("set-cookie");
  assert.match(cookie, /df_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.deepEqual(seen, ["https://oauth2.googleapis.com/token", "https://openidconnect.googleapis.com/v1/userinfo"]);
  const token = cookie.split(";", 1)[0].split("=")[1];
  const session = await account.fetch(new Request("https://deals.agentsealteam.com/auth/session", {
    headers: { cookie: `df_session=${token}` },
  }), env);
  const me = await session.json();
  assert.equal(me.signedIn, true);
  assert.equal(me.provider, "google");
  assert.equal(me.displayName, "Ada");
  assert.equal(me.email, undefined);
  assert.equal(me.allowance.remaining, 20);
  let sent = "";
  env.AI = { run: async (_model, payload) => { sent = JSON.stringify(payload); return { response: "{\"ok\":true}" }; } };
  const answer = await account.fetch(new Request("https://deals.agentsealteam.com/api/ai", {
    method: "POST",
    headers: { cookie: `df_session=${token}`, "content-type": "application/json" },
    body: JSON.stringify({ system: "Be brief.", prompt: "Email ada@example.com about a filter." }),
  }), env);
  assert.equal(answer.status, 200);
  assert.equal(sent.includes("ada@example.com"), false);
  assert.match(sent, /\[name\]/);
  const limited = await account.fetch(new Request("https://deals.agentsealteam.com/api/ai", {
    method: "POST",
    headers: { cookie: `df_session=${token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "again" }),
  }), env);
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.match(body.message, /wait a moment/);
  assert.match(body.resetsAt, /T00:00:00.000Z$/);
  const removed = await account.fetch(new Request("https://deals.agentsealteam.com/auth/account", {
    method: "DELETE", headers: { cookie: `df_session=${token}` },
  }), env);
  assert.equal(removed.status, 200);
  const after = await account.fetch(new Request("https://deals.agentsealteam.com/auth/session", {
    headers: { cookie: `df_session=${token}` },
  }), env);
  assert.equal((await after.json()).signedIn, false);
});

test("the free allowance stops at the personal and site ceilings", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  const personal = quotaDecision({ used: 20, now, globalNeurons: 0, limit: 20, ceiling: 8000, perRequest: 20 });
  assert.equal(personal.ok, false);
  assert.match(personal.message, /20 free answers/);
  assert.equal(personal.resetsAt, "2026-11-28T00:00:00.000Z");
  const site = quotaDecision({ used: 1, now, globalNeurons: 7990, limit: 20, ceiling: 8000, perRequest: 20 });
  assert.equal(site.ok, false);
  assert.match(site.message, /site limit/);
});

test("GitHub authorize URL stays on the identity scopes", () => {
  const url = new URL(authorizeUrl("github", {
    clientId: "test-github-client", redirectUri: "https://deals.agentsealteam.com/auth/callback/github",
    state: "state", challenge: "challenge",
  }));
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.searchParams.get("scope"), "read:user user:email");
  assert.equal(url.href.includes("gmail"), false);
});
