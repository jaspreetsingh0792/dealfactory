const pages = new Set(["home", "footmuffs"]);
const events = new Set(["view", "outbound", "share"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/events") return env.ASSETS.fetch(request);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (request.headers.get("Origin") !== url.origin) return new Response(null, { status: 403 });
    const page = url.searchParams.get("page");
    const event = url.searchParams.get("event");
    if (!pages.has(page) || !events.has(event)) return new Response(null, { status: 400 });
    if (request.headers.get("Sec-GPC") !== "1" && request.headers.get("DNT") !== "1") {
      const day = new Date().toISOString().slice(0, 10);
      await env.TRAFFIC.prepare(
        "INSERT INTO daily_events(day,event,page,total) VALUES(?,?,?,1) " +
        "ON CONFLICT(day,event,page) DO UPDATE SET total=total+1"
      ).bind(day, event, page).run();
    }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
};
