import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../ops/events-worker.js";

const origin = "https://dealfactory.example";

test("counts only allowlisted events and respects privacy signals", async () => {
  const writes = [];
  const env = {TRAFFIC: {prepare: () => ({bind: (...values) => ({
    run: async () => writes.push(values)
  })})}};
  const endpoint = origin + "/events?page=footmuffs&event=outbound";
  const send = (url, headers) => worker.fetch(new Request(url, {
    headers, method: "POST"
  }), env);
  assert.equal((await send(endpoint, {Origin: origin})).status, 204);
  assert.equal((await send(endpoint, {Origin: origin, DNT: "1"})).status, 204);
  assert.equal((await send(endpoint, {Origin: "https://elsewhere.example"})).status, 403);
  assert.equal((await send(endpoint.replace("outbound", "unknown"), {Origin: origin})).status, 400);
  assert.equal((await send(endpoint + "&channel=unexpected", {Origin: origin})).status, 400);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].slice(1), ["outbound/direct", "footmuffs"]);
  const advisor = await send(origin + "/events?page=advisor&event=search_run", {Origin: origin});
  assert.equal(advisor.status, 204);
  assert.equal(writes.at(-1)[2], "advisor");
  const unbound = await worker.fetch(new Request(origin + "/events?page=advisor&event=gmail_import", {
    method: "POST", headers: {Origin: origin}
  }), {});
  assert.equal(unbound.status, 204);
});
