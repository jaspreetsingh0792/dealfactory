import assert from "node:assert/strict";
import test from "node:test";

import { allowedBaseUrl, connectionHint, PROVIDERS, providerReady } from "../lib/llm.js";

test("custom provider addresses are https, or http on localhost only", () => {
  assert.equal(allowedBaseUrl("https://llm.example/v1").ok, true);
  assert.equal(allowedBaseUrl("https://llm.example/v1").href, "https://llm.example/v1");
  assert.equal(allowedBaseUrl("http://127.0.0.1:11434/v1").ok, true);
  assert.equal(allowedBaseUrl("http://localhost:11434/v1", { localOnly: true }).ok, true);
  assert.equal(allowedBaseUrl("http://llm.example/v1").ok, false);
  assert.equal(allowedBaseUrl("https://user:secret@llm.example/v1").ok, false);
  assert.equal(allowedBaseUrl("https://llm.example/v1", { localOnly: true }).ok, false);
  assert.equal(allowedBaseUrl("not a url").ok, false);
});

test("a provider is connected only when the browser can call it", () => {
  assert.equal(providerReady({ provider: "openrouter", model: "openrouter/auto", key: "" }), false);
  assert.equal(providerReady({ provider: "openrouter", model: "openrouter/auto", key: "sk" }), true);
  assert.equal(providerReady({ provider: "gemini", model: "gemini-2.5-flash", key: "gk" }), true);
  assert.equal(providerReady({ provider: "ollama", model: "", baseUrl: "" }), false);
  assert.equal(providerReady({ provider: "ollama", model: "llama3.2", baseUrl: "" }), true);
  assert.equal(providerReady({ provider: "compatible", model: "local", baseUrl: "http://evil.example/v1" }), false);
  assert.equal(providerReady({ provider: "compatible", model: "local", baseUrl: "https://llm.example/v1" }), true);
  assert.equal(providerReady({ provider: "chatgpt", model: "", key: "" }), false);
  assert.equal(providerReady({ provider: "chatgpt", model: "", key: "" }, { chatgptSignedIn: true }), true);
  assert.match(connectionHint({ provider: "gemini", model: "gemini-2.5-flash", key: "" }), /API key/);
  for (const id of ["openrouter", "gemini", "openai", "anthropic", "mistral", "groq", "compatible", "ollama"]) {
    assert.ok(PROVIDERS[id].help, id);
  }
  assert.match(PROVIDERS.gemini.help, /free tier/);
  assert.equal(PROVIDERS.openai.browser, undefined);
});
