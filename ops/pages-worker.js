import connector from "./connector/src/index.js";
import traffic from "./ops/events-worker.js";

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/mcp") return connector.fetch(request);
    if (path === "/events" && env.TRAFFIC) return traffic.fetch(request, env);
    return env.ASSETS.fetch(request);
  }
};
