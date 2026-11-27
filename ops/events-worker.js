const pages = new Set(["home", "smarthome", "deals", "footmuffs", "advisor"]);
const channels = new Set(["rss", "reader", "campaign", "internal", "search", "referral", "direct"]);
const events = new Set(["view", "outbound", "share", "setup_add", "ai_connect", "gmail_import_start", "gmail_import", "gmail_import_cancel", "brief_export", "search_run"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/events") return env.ASSETS.fetch(request);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (request.headers.get("Origin") !== url.origin) return new Response(null, { status: 403 });
    const page = url.searchParams.get("page");
    const event = url.searchParams.get("event");
    const channel = url.searchParams.get("channel") || "direct";
    if (!pages.has(page) || !events.has(event) || !channels.has(channel)) return new Response(null, { status: 400 });
    if (request.headers.get("Sec-GPC") !== "1" && request.headers.get("DNT") !== "1") {
      const day = new Date().toISOString().slice(0, 10);
      try {
        await env.TRAFFIC.prepare(
          "INSERT INTO daily_events(day,event,page,total) VALUES(?,?,?,1) " +
          "ON CONFLICT(day,event,page) DO UPDATE SET total=total+1"
        ).bind(day, `${event}/${channel}`, page).run();
      } catch {
        // D1 is optional. A missing binding must not fail the request or record any payload.
      }
    }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
};
