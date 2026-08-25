// A CAPABILITY THE AGENT WROTE FOR ITSELF.
//
// The user's proposal: if it needs something it has no tool for, let it write
// one, save it, and reuse it — never able to change the source, never able to
// delete, only add.
//
// The version built is DATA, not code: a description of an https GET and how to
// read the answer. So the tests that matter are not "does it run JavaScript
// safely" — nothing here runs JavaScript — but "can a saved file be talked into
// pointing somewhere else", which is the same threat content-boundary.js exists
// for, one layer down: what the agent READ must never redirect what it DOES.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  describeCapabilities,
  fillTemplate,
  listCapabilities,
  renderResponse,
  runCapability,
  saveCapability,
  validateCapability,
  capabilitiesDirectory
} from "../../packages/fast-agent/src/capabilities.js";

let root;
test.before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-capabilities-")); });
test.after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {}); });

const WEATHER = {
  id: "weather-now",
  title: "Current weather",
  when: "the user asks what the weather is somewhere",
  url: "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m",
  parameters: [{ name: "lat" }, { name: "lon" }],
  render: ["current.temperature_2m", "timezone"]
};

const respond = (body, { status = 200, url, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url: url ?? "https://api.open-meteo.com/v1/forecast",
  headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body))
});

test("a well-formed capability saves, and comes back through the loader a later run uses", async () => {
  const saved = await saveCapability(root, WEATHER);
  assert.equal(saved.ok, true, JSON.stringify(saved.problems));
  assert.equal(saved.capability.host, "api.open-meteo.com", "the host is pinned at save time");
  assert.equal(saved.capability.method, "GET");

  const all = await listCapabilities(root);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "weather-now");

  // The file is the user's, in their own state directory, and readable.
  const onDisk = JSON.parse(await fs.readFile(path.join(capabilitiesDirectory(root), "weather-now.json"), "utf8"));
  assert.equal(onDisk.when, WEATHER.when);
});

test("what may not be saved, and why, in words the model can act on", async () => {
  const cases = [
    [{ ...WEATHER, url: "http://api.open-meteo.com/v1/forecast" }, /https/],
    [{ ...WEATHER, method: "POST" }, /only GET/],
    [{ ...WEATHER, id: "Weather Now!" }, /file name/],
    [{ ...WEATHER, when: "" }, /when.*required|required.*when/i],
    [{ ...WEATHER, url: "https://x.example/{missing}", parameters: [{ name: "lat" }, { name: "lon" }] }, /\{missing\}/],
    // A credential in a saved file is a credential in the transcript the next
    // time the file is read back. This project has leaked a live key that way.
    [{ ...WEATHER, headers: { authorization: "Bearer sk-live-123" } }, /credential/]
  ];
  for (const [candidate, expected] of cases) {
    const check = validateCapability(candidate);
    assert.equal(check.ok, false, `should have been refused: ${JSON.stringify(candidate).slice(0, 90)}`);
    assert.ok(check.problems.some((problem) => expected.test(problem)),
      `refused for the wrong reason: ${check.problems.join("; ")}`);
  }
});

// THE CENTRAL SECURITY TEST. A capability is saved once and replayed for months,
// and in between the agent reads pages and messages written by other people.
test("no argument can move a capability off the host it was saved for", async () => {
  const capability = { ...WEATHER, host: "api.open-meteo.com" };
  for (const attack of [
    "1&x=../../evil.com",
    "1#@evil.com",
    "1/../../..//evil.com",
    "https://evil.com/",
    "1%2F%2Fevil.com"
  ]) {
    const filled = fillTemplate(capability, { lat: attack, lon: "2" });
    if (!filled.ok) continue;
    assert.equal(new URL(filled.url).hostname, "api.open-meteo.com",
      `an argument reached a different host: ${attack} → ${filled.url}`);
  }

  // And the direct attempt, which must be refused by name rather than silently.
  const moved = fillTemplate({ ...capability, url: "https://{lat}/x" , parameters: [{ name: "lat" }] }, { lat: "evil.com" });
  assert.equal(moved.ok, false);
  assert.match(moved.reason, /refused/);
});

// `redirect: "follow"` is convenient and it is also the other way off the pinned
// host — so where it LANDED is what gets checked.
test("a redirect to another host is refused after the fact", async () => {
  await saveCapability(root, WEATHER);
  const result = await runCapability(root, "weather-now", { lat: "12", lon: "77" }, {
    fetchImpl: async () => respond({ ok: true }, { url: "https://evil.example/collected" })
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /redirected to evil\.example/);
  assert.match(result.reason, /nothing was read/i);
});

test("a run pulls out the fields it said it wanted, and counts itself", async () => {
  // Its own id: the tests above share a temp root on purpose (that is what
  // proves the tally survives), so counting runs of `weather-now` here would be
  // counting the redirect refusal as well.
  await saveCapability(root, { ...WEATHER, id: "weather-run" });
  const body = { timezone: "Asia/Kolkata", current: { temperature_2m: 28.4, wind: 3 } };
  const result = await runCapability(root, "weather-run", { lat: "12.9", lon: "77.6" }, {
    fetchImpl: async (url) => {
      assert.match(String(url), /latitude=12\.9&longitude=77\.6/, "the arguments must reach the url, encoded");
      return respond(body, { headers: { "content-type": "application/json" } });
    }
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /current\.temperature_2m: 28\.4/);
  assert.match(result.text, /timezone: Asia\/Kolkata/);
  assert.ok(!result.text.includes("wind"), "a render that returns everything is not a render");

  const after = (await listCapabilities(root)).find((entry) => entry.id === "weather-run");
  assert.equal(after.runs, 1);
  assert.equal(after.failures, 0);
});

test("a failure is counted too, and reported rather than thrown", async () => {
  await saveCapability(root, { ...WEATHER, id: "flaky-one" });
  const result = await runCapability(root, "flaky-one", { lat: "1", lon: "2" }, {
    fetchImpl: async () => respond("nope", { status: 500, url: "https://api.open-meteo.com/v1/forecast" })
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /HTTP 500/);
  const saved = (await listCapabilities(root)).find((entry) => entry.id === "flaky-one");
  assert.equal(saved.failures, 1);
});

// ADDITIVE ONLY, as the user asked: the module has no delete at all, and saving
// the same id again updates in place while keeping the tally and the birthday.
test("there is no way to delete a capability, and re-saving keeps its history", async () => {
  const module = await import("../../packages/fast-agent/src/capabilities.js");
  for (const name of Object.keys(module)) {
    assert.ok(!/delete|remove|forget|destroy/i.test(name), `capabilities.js exports ${name} — it must not be able to delete`);
  }
  await saveCapability(root, { ...WEATHER, id: "keeps-history" });
  await runCapability(root, "keeps-history", { lat: "1", lon: "2" }, { fetchImpl: async () => respond({}) });
  const first = (await listCapabilities(root)).find((entry) => entry.id === "keeps-history");

  const again = await saveCapability(root, { ...WEATHER, id: "keeps-history", title: "Renamed" });
  assert.equal(again.replaced, true);
  assert.equal(again.capability.runs, first.runs, "re-saving must not reset the tally");
  assert.equal(again.capability.createdAt, first.createdAt);
});

// The index is the entire discovery mechanism, and the reason the dispatcher
// tool's description never has to grow. It must cost nothing when empty.
test("the index is empty until something is saved, and warns about an unreliable one", () => {
  assert.equal(describeCapabilities([]), "", "an unused feature must not appear in the prompt at all");

  const text = describeCapabilities([
    { id: "weather-now", when: "the user asks the weather", parameters: [{ name: "lat" }, { name: "lon" }], runs: 0, failures: 0 },
    { id: "broken", when: "something", parameters: [], runs: 6, failures: 5 }
  ]);
  assert.match(text, /weather-now\(lat, lon\) — the user asks the weather/);
  assert.match(text, /broken.*unreliable lately/);
});

test("a file the user edited into nonsense is skipped, not fatal", async () => {
  await fs.mkdir(capabilitiesDirectory(root), { recursive: true });
  await fs.writeFile(path.join(capabilitiesDirectory(root), "broken-json.json"), "{ this is not json", "utf8");
  const all = await listCapabilities(root);
  assert.ok(Array.isArray(all), "one bad file must not take the whole list down — the user is invited to edit these");
  assert.ok(!all.some((entry) => entry.id === "broken-json"));
});

test("a response that is not JSON comes back as its text", () => {
  const capability = { render: ["a.b"] };
  assert.equal(renderResponse(capability, "plain words", "text/plain"), "plain words");
});
