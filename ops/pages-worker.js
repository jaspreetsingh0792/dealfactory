import connector from "./connector/src/index.js";
import traffic from "./ops/events-worker.js";
import account from "./ops/account.js";

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/mcp") return await connector.fetch(request);
      if (path.startsWith("/auth/") || path === "/api/ai" || path === "/api/state") return await account.fetch(request, env);
      if (path === "/events" && env.TRAFFIC) return await traffic.fetch(request, env);
      return await env.ASSETS.fetch(request);
    } catch {
      return new Response("This part of DealFactory is not available yet. You can still use your own AI.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
  }
};
