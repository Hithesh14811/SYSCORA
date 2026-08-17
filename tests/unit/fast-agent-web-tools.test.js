// The web, the volume and closing an application — the capabilities the loop
// could not name.
//
// A complete Chrome DevTools Protocol stack existed in this repo the whole time
// and the agent loop could not reach one operation of it, so every web task was
// OCR of a Chrome window: three seconds a look, the page competing with the
// bookmarks bar for room in the reading, and links unreachable because a link is
// not an accessible control. `system.volume.set` and `application.close` were
// unreachable the same way, so "turn it down" and "close Spotify" had no verb.
//
// These cover the wiring: the tools reach the real capabilities, they act by
// LABEL rather than by a target object the model would have to carry between
// calls, and each one reports what it actually matched rather than what was
// asked for.

import test from "node:test";
import assert from "node:assert/strict";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";

// The parts of the Windows adapter the registry insists on, answering plausibly.
function baseAdapter() {
  return {
    executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    listWindows: async () => [],
    listProcesses: async () => ({ processes: [] }),
    inspectUi: async () => ({ elements: [] }),
    captureScreen: async () => ({ captured: false }),
    readOcr: async () => ({ text: "" }),
    pointerAction: async () => ({ performed: true }),
    pointerStroke: async () => ({ performed: true }),
    keyboardAction: async () => ({ performed: true }),
    getDocumentsPath: () => "C:\\Docs",
    getDesktopPath: () => "C:\\Desktop",
    getDownloadsPath: () => "C:\\Downloads"
  };
}

function toolsetOver(adapter) {
  return buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter, basePath: "C:\\work" });
}

// A toolset whose browser answers like a real page.
function webToolset({ page = {}, elements = [], best = null, field = null, afterClick = null, typeResult = null } = {}) {
  const calls = [];
  const state = {
    url: page.url ?? "https://example.com/",
    title: page.title ?? "Example",
    readyState: "complete"
  };
  const adapter = {
    ...baseAdapter(),
    browserDomAction: async (operation, params = {}) => {
      calls.push({ operation, params });
      switch (operation) {
        case "launch": return { launched: true, target: { url: params.url } };
        case "currentState":
          return calls.some((entry) => entry.operation === "click") && afterClick
            ? { ...state, ...afterClick }
            : state;
        case "inspect": return elements;
        // A read WITH a target is a read of that element — and for an input,
        // that is its value. `web_type` reads the field back through this a tick
        // after writing it, which is what catches a framework putting the old
        // value straight back; a stub that answers with the page's prose would
        // report every successful type as rejected.
        case "read": {
          if (!params.target) return { found: true, text: page.text ?? "Some page text." };
          const typedInto = [...calls].reverse().find((entry) => entry.operation === "type");
          return { found: true, text: String(typedInto?.params?.text ?? "") };
        }
        case "findBest": return best ?? { found: false, reason: "matching-dom-target-not-found" };
        case "findField": return field ?? { found: false, reason: "field-not-found", labels: ["Email", "Password"] };
        case "click": return { performed: true, target: params.target };
        case "type": return typeResult ?? { performed: true, landed: String(params.text ?? ""), length: String(params.text ?? "").length };
        case "pressKey": return { performed: true, key: "Enter" };
        case "scroll": return { performed: true, moved: true, scrollBefore: { x: 0, y: 0 }, scrollAfter: { x: 0, y: 600 } };
        default: return {};
      }
    }
  };
  return { toolset: toolsetOver(adapter), calls, adapter };
}

const domTarget = (name) => ({
  found: true,
  target: { targetId: "t1", source: "DOM", selector: "[data-syscora-target]", name, text: name },
  textCoverage: 1
});

const searchField = { found: true, target: { targetId: "f1", source: "DOM", selector: "#q" }, label: "Search", coverage: 1 };

test("every web tool the model is offered maps to a browser capability that exists", () => {
  const registry = createDefaultCapabilityRegistry(baseAdapter());
  for (const name of [
    "browser.launch", "browser.currentState", "browser.inspect", "browser.read",
    "browser.findBest", "browser.findField", "browser.click", "browser.type",
    "browser.key", "browser.scroll", "browser.dismissCookieNotice"
  ]) {
    assert.ok(registry.get(name), `the web tools delegate to ${name}, which is not registered`);
  }
});

test("the new verbs are actually offered to the model", () => {
  const toolset = toolsetOver(baseAdapter());
  const offered = new Set(toolset.definitions.map((definition) => definition.function.name));
  for (const name of ["web_open", "web_read", "web_click", "web_type", "web_scroll", "volume", "close_app"]) {
    assert.ok(offered.has(name), `${name} is implemented but never offered, which is the same as not existing`);
  }
  // And each still carries the narration the transcript is built from.
  for (const definition of toolset.definitions) {
    assert.ok(definition.function.parameters.required.includes("saw"));
    assert.ok(definition.function.parameters.required.includes("say"));
  }
});

test("opening a page reads it through the DOM, not by taking a picture of a browser", async () => {
  const { toolset, calls } = webToolset({
    page: { url: "https://news.example/story", title: "The Story", text: "Body of the story." },
    elements: [
      { text: "Home", controlType: "a", href: "https://news.example/", clickable: true },
      { text: "Read more", controlType: "button", clickable: true }
    ]
  });
  const result = await toolset.execute("web_open", { saw: "A URL.", say: "Opening it.", url: "https://news.example/story" });
  assert.equal(result.ok, true);
  assert.match(result.text, /The Story/);
  assert.match(result.text, /Body of the story/);
  assert.match(result.text, /"Read more"/, "the page's own controls must be listed, by name");
  assert.ok(!calls.some((entry) => /capture|ocr/i.test(entry.operation)), "nothing should have looked at pixels");
  assert.ok(calls.some((entry) => entry.operation === "launch" && entry.params.url === "https://news.example/story"));
});

test("a page is only opened over http(s)", async () => {
  const { toolset } = webToolset();
  const result = await toolset.execute("web_open", { url: "file:///C:/Windows/System32/config/SAM" });
  assert.equal(result.ok, false);
  assert.match(result.text, /Only http\(s\)/);
});

test("a consent banner is only dismissed when asked, and never by accepting", async () => {
  const { toolset, calls } = webToolset();
  await toolset.execute("web_open", { url: "https://example.com/" });
  assert.ok(!calls.some((entry) => entry.operation === "dismissCookieNotice"), "opening a page must not click things on it");

  await toolset.execute("web_open", { url: "https://example.com/", rejectCookies: true });
  assert.ok(calls.some((entry) => entry.operation === "dismissCookieNotice"));
});

test("clicking on a page names the label it actually matched, not the one asked for", async () => {
  const { toolset } = webToolset({
    best: domTarget("Headlines — Top Hits Unpacked, Episode"),
    afterClick: { url: "https://example.com/episode", title: "An Episode" }
  });
  const result = await toolset.execute("web_click", { text: "Headlines" });
  assert.equal(result.ok, true);
  // The whole point: asked for a song, got a podcast, and can tell.
  assert.match(result.text, /Top Hits Unpacked/);
  assert.match(result.text, /closest thing to "Headlines"/);
  assert.match(result.text, /Check that is what you meant/);
});

test("a click that matched exactly is reported plainly, with where the page went", async () => {
  const { toolset } = webToolset({
    best: domTarget("Sign in"),
    afterClick: { url: "https://example.com/login", title: "Sign in" }
  });
  const result = await toolset.execute("web_click", { text: "Sign in" });
  assert.match(result.text, /Clicked "Sign in"\./);
  assert.match(result.text, /example\.com\/login/);
  assert.ok(!/closest thing/.test(result.text));
});

test("a click that did not navigate says so, instead of implying a new page", async () => {
  const { toolset } = webToolset({ best: domTarget("Show more") });
  const result = await toolset.execute("web_click", { text: "Show more" });
  assert.match(result.text, /URL did not change/);
});

test("a label that is not on the page offers what actually is, rather than a dead end", async () => {
  const { toolset } = webToolset({
    best: { found: false },
    elements: [
      { text: "Accept all", controlType: "button", clickable: true },
      { text: "Reject all", controlType: "button", clickable: true }
    ]
  });
  const result = await toolset.execute("web_click", { text: "Continue" });
  assert.equal(result.ok, false);
  assert.match(result.text, /Nothing on the page is labelled "Continue"/);
  assert.match(result.text, /Reject all/, "a miss must list the real labels, or the model can only guess again");
});

test("text left sitting in a search box is reported as not searched for", async () => {
  const { toolset } = webToolset({ field: searchField });
  const typed = await toolset.execute("web_type", { text: "weather in Chennai" });
  assert.equal(typed.ok, true);
  assert.match(typed.text, /has NOT been submitted/);

  const searched = await toolset.execute("web_type", { text: "weather in Chennai", submit: true });
  assert.match(searched.text, /Pressed Enter/);
});

test("a field that did not keep what was typed is a failure, not a success", async () => {
  // A framework-controlled input that reverts the write — the ordinary case on a
  // React page, and the one that used to return performed: true.
  const { toolset } = webToolset({
    field: searchField,
    typeResult: { performed: false, landed: "", reason: "the field did not keep what was typed" }
  });
  const result = await toolset.execute("web_type", { text: "hello", submit: true });
  assert.match(result.text, /did not take/);
  assert.ok(!/Pressed Enter/.test(result.text), "nothing may be submitted when the text never landed");
});

test("naming a field that is not on the page lists the ones that are", async () => {
  const { toolset } = webToolset({ field: { found: false, labels: ["Email", "Password"] } });
  const result = await toolset.execute("web_type", { text: "x", into: "Card number" });
  assert.equal(result.ok, false);
  assert.match(result.text, /No field on this page matches "Card number"/);
  assert.match(result.text, /Email/);
});

test("scrolling past the end of a page says so rather than reporting progress", async () => {
  const stuck = {
    ...baseAdapter(),
    browserDomAction: async (operation) => (operation === "scroll"
      ? { performed: true, moved: false, scrollBefore: { x: 0, y: 900 }, scrollAfter: { x: 0, y: 900 } }
      : {})
  };
  const result = await toolsetOver(stuck).execute("web_scroll", { y: 600 });
  assert.match(result.text, /did not move/);
});

// ---- Volume and closing -----------------------------------------------------

test("the volume can be read and set, which took the Settings app before", async () => {
  const calls = [];
  const adapter = {
    ...baseAdapter(),
    readSystemVolume: async () => { calls.push("read"); return { available: true, percent: 40, muted: false }; },
    setSystemVolume: async (percent, options) => {
      calls.push(`set:${percent}:${options?.mute}`);
      return { applied: true, percent, muted: options?.mute === true };
    }
  };
  const toolset = toolsetOver(adapter);

  const read = await toolset.execute("volume", {});
  assert.match(read.text, /Volume is 40%/);

  const set = await toolset.execute("volume", { percent: 26 });
  assert.match(set.text, /Volume is 26%/);
  // The capability normalizes an absent mute to null, so setting a level leaves
  // the mute state alone rather than carrying a stray boolean into it.
  assert.ok(calls.includes("set:26:null"), "a named destination must be set, not nudged");

  // Muting must not move the level it is at.
  const muted = await toolset.execute("volume", { mute: true });
  assert.match(muted.text, /muted/);
  assert.ok(calls.some((entry) => entry.startsWith("set:40:true")), "mute alone must keep the current level");
});

test("a volume the endpoint did not accept is not reported as set", async () => {
  const adapter = {
    ...baseAdapter(),
    readSystemVolume: async () => ({ available: true, percent: 40 }),
    setSystemVolume: async () => ({ applied: false, requestedPercent: 26, percent: 40 })
  };
  const result = await toolsetOver(adapter).execute("volume", { percent: 26 });
  assert.match(result.text, /did not take/);
});

test("closing an application checks the process list rather than trusting the request", async () => {
  const stubborn = {
    ...baseAdapter(),
    closeApplication: async () => ({ performed: true }),
    listProcesses: async () => ({ processes: [{ ProcessName: "notepad" }] })
  };
  const result = await toolsetOver(stubborn).execute("close_app", { application: "notepad" });
  assert.match(result.text, /STILL RUNNING/);

  const gone = {
    ...stubborn,
    listProcesses: async () => ({ processes: [{ ProcessName: "explorer" }] })
  };
  const closed = await toolsetOver(gone).execute("close_app", { application: "notepad.exe" });
  assert.match(closed.text, /is closed/);
});
