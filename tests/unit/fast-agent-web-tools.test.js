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

// The HTTP reader is stubbed to refuse by default. web_open tries an HTTP read
// before spending a browser on the page, and without this stub these tests would
// reach the real internet — one of them opens `https://example.com/`, which
// exists. A suite that quietly depends on a network fails on an aeroplane and
// passes on review.
const NO_HTTP = async (url) => ({ ok: false, url, title: "", text: "", links: [], reason: "stubbed off" });

// The same, for search: three indexes per query and up to eight queries a call,
// so an unstubbed suite would spend somebody else's rate limit on every run.
const NO_SEARCH = async (queries) => queries.map((query) => ({
  ok: false, query, results: [], provider: null, reason: "stubbed off"
}));

function toolsetOver(adapter, { readPageOverHttp = NO_HTTP, searchTheWeb = NO_SEARCH } = {}) {
  return buildToolset({
    registry: createDefaultCapabilityRegistry(adapter), adapter, basePath: "C:\\work", readPageOverHttp, searchTheWeb
  });
}

// A toolset whose browser answers like a real page.
function webToolset({ page = {}, elements = [], best = null, field = null, afterClick = null, typeResult = null, clickResult = null, readPageOverHttp = NO_HTTP } = {}) {
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
        case "click": return clickResult ?? { performed: true, target: params.target };
        case "type": return typeResult ?? { performed: true, landed: String(params.text ?? ""), length: String(params.text ?? "").length };
        case "pressKey": return { performed: true, key: "Enter" };
        case "scroll": return { performed: true, moved: true, scrollBefore: { x: 0, y: 0 }, scrollAfter: { x: 0, y: 600 } };
        default: return {};
      }
    }
  };
  return { toolset: toolsetOver(adapter, { readPageOverHttp }), calls, adapter };
}

// A page that reads perfectly well over HTTP — the case that must NOT cost a
// browser. Long enough to clear the readability threshold, which is what the
// decision is actually made on.
const httpPage = (overrides = {}) => async (url) => ({
  ok: true,
  url,
  requestedUrl: url,
  status: 200,
  title: "The Story",
  text: `Body of the story. ${"Something worth reading. ".repeat(30)}`,
  links: [{ label: "Read more", href: "https://news.example/more" }],
  readable: true,
  reason: null,
  ...overrides
});

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

// ---- reading without a browser ----------------------------------------------

test("a page that reads over HTTP does not cost a browser", async () => {
  // Measured on 23 Aug 2026: nodejs.org came back complete in 490ms and
  // Wikipedia in 670ms, against several seconds, a leftover Chromium process and
  // a window on the user's screen for the same words.
  const { toolset, calls } = webToolset({ readPageOverHttp: httpPage() });
  const result = await toolset.execute("web_open", { url: "https://news.example/story" });
  assert.equal(result.ok, true);
  assert.match(result.text, /The Story/);
  assert.match(result.text, /Body of the story/);
  assert.match(result.text, /"Read more"/, "the page's links have to survive the cheaper route");
  assert.ok(!calls.some((entry) => entry.operation === "launch"), "a browser was launched for a page that did not need one");
});

test("a page that does NOT read over HTTP still falls back to the browser", async () => {
  // A framework-rendered application sends an empty shell. The decision is a
  // MEASUREMENT of what arrived — a list of domains believed to need a browser
  // would be wrong the week after it was written, and wrong silently.
  const { toolset, calls } = webToolset({
    page: { url: "https://app.example/", title: "Dashboard", text: "Rendered by the browser." },
    readPageOverHttp: httpPage({ text: "", readable: false })
  });
  const result = await toolset.execute("web_open", { url: "https://app.example/" });
  assert.equal(result.ok, true);
  assert.match(result.text, /Rendered by the browser/);
  assert.ok(calls.some((entry) => entry.operation === "launch"));
});

test("asking to reject a cookie banner means asking for a browser", async () => {
  // A banner is a thing you PRESS. Answering over HTTP would succeed and quietly
  // ignore the one instruction that was given.
  const { toolset, calls } = webToolset({ readPageOverHttp: httpPage() });
  await toolset.execute("web_open", { url: "https://news.example/story", rejectCookies: true });
  assert.ok(calls.some((entry) => entry.operation === "launch"));
  assert.ok(calls.some((entry) => entry.operation === "dismissCookieNotice"));
});

test("clicking after an HTTP read puts the browser on that page first", async () => {
  // "The page" and "the controlled browser's page" stop being the same thing the
  // moment web_open can answer without a browser — and a click acts on the
  // SECOND one. Without this, a click lands on whatever the browser had open
  // from an earlier turn and reports, perfectly truthfully, that it clicked
  // something.
  const { toolset, calls } = webToolset({
    best: domTarget("Read more"),
    readPageOverHttp: httpPage()
  });
  await toolset.execute("web_open", { url: "https://news.example/story" });
  assert.ok(!calls.some((entry) => entry.operation === "launch"));
  await toolset.execute("web_click", { text: "Read more" });
  assert.ok(
    calls.some((entry) => entry.operation === "launch" && entry.params.url === "https://news.example/story"),
    "the browser was never sent to the page that was read"
  );
});

test("scrolling a page read over HTTP moves through text already in hand", async () => {
  // Observed live 23 Aug 2026, and it cost eleven seconds and three wasted
  // calls: a fetched page arrives WHOLE — Tom's Guide came back as 69,000
  // characters — and the renderer shows 2,500 of it. The model correctly
  // concluded the rest was further down and called web_scroll, which escalated
  // to the controlled browser, threw away all the text already held, and landed
  // on a DIFFERENT page (the last one fetched, not the one it meant).
  const long = Array.from({ length: 400 }, (whole, index) => `Paragraph ${index} of the article about laptops.`).join("\n");
  const { toolset, calls } = webToolset({ readPageOverHttp: httpPage({ text: long }) });

  const opened = await toolset.execute("web_open", { url: "https://news.example/long" });
  assert.match(opened.text, /Showing characters 0/, "the model was not told there is more of the page");
  assert.match(opened.text, /Paragraph 0 /);

  const scrolled = await toolset.execute("web_scroll", { y: 600 });
  assert.equal(scrolled.ok, true);
  assert.ok(!calls.some((entry) => entry.operation === "launch"),
    "a browser was launched to scroll a page that was already downloaded");
  // The new part comes BACK, rather than the model being told to go and read it.
  // That saves a whole round trip through the model for every scroll.
  assert.ok(!/Paragraph 0 /.test(scrolled.text), "the same window was returned again");
  assert.match(scrolled.text, /Paragraph \d+ of the article/);
});

test("scrolling past the end of a fetched page says so instead of pretending", async () => {
  const { toolset } = webToolset({ readPageOverHttp: httpPage({ text: "Short but readable. ".repeat(40) }) });
  await toolset.execute("web_open", { url: "https://news.example/short" });
  const scrolled = await toolset.execute("web_scroll", { y: 5000 });
  assert.match(scrolled.text, /end of the page/);
});

test("re-reading a page fetched over HTTP costs no second fetch", async () => {
  let fetches = 0;
  const { toolset } = webToolset({
    readPageOverHttp: async (url) => {
      fetches += 1;
      return (await httpPage()(url));
    }
  });
  await toolset.execute("web_open", { url: "https://news.example/story" });
  await toolset.execute("web_read", {});
  await toolset.execute("web_read", {});
  assert.equal(fetches, 1, "the same article was downloaded again to re-read it");
});

test("driving a search engine through the browser is refused, and named", async () => {
  // Observed live: handed a lookup, the model called `search`, disliked the
  // results and then opened google.com/search in the controlled browser — which
  // answered "unusual traffic" — then duckduckgo.com, which was blocked too.
  // Three navigations to arrive back where it started, and to the user every one
  // of them looked like the product failing to search.
  const { toolset, calls } = webToolset({ readPageOverHttp: httpPage() });
  const result = await toolset.execute("web_open", { url: "https://www.google.com/search?q=best+laptops+2026" });
  assert.equal(result.ok, false);
  assert.match(result.text, /search\(\{ queries: \["best laptops 2026"\] \}\)/, "the way out has to be the exact call to make");
  assert.ok(!calls.some((entry) => entry.operation === "launch"), "it went to the browser anyway");
});

test("a batch of urls is not a way around the search-engine refusal", async () => {
  // A refusal with a way around it teaches the model the way around rather than
  // the rule. The check used to live inside the single-page path, so putting the
  // same URL in `urls` walked straight past it.
  const { toolset, calls } = webToolset({ readPageOverHttp: httpPage() });
  const result = await toolset.execute("web_open", {
    urls: ["https://news.example/story", "https://duckduckgo.com/?q=best+laptops+2026"]
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /Do not drive duckduckgo/);
  assert.ok(!calls.some((entry) => entry.operation === "launch"));
});

test("an ordinary page on a search engine's domain is still just a page", async () => {
  // Pinning the refusal to the DOMAIN would refuse google.com/maps and
  // news.google.com/rss/search as well, which this tool is exactly right for.
  const { toolset } = webToolset({ readPageOverHttp: httpPage() });
  for (const url of ["https://www.google.com/maps?q=coffee", "https://developers.google.com/search/docs"]) {
    const result = await toolset.execute("web_open", { url });
    assert.equal(result.ok, true, `${url} was refused, and it is not a search`);
  }
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

// AN UNCHANGED PAGE MUST NOT BE PAID FOR TWICE.
//
// The identical-reading notice used to be appended AFTER the whole reading, so
// re-reading a page that had not moved sent the entire page again and then said
// it was identical -- the most expensive possible way to say "nothing changed".
// `screen` has always answered an unchanged window with one line.
//
// It became much worse on 28 Aug 2026, when `web_read` was added to
// `isUiObservation` so that reading a form back would stop tripping the
// no-progress guard. That change is correct, but the guard had been the only
// thing capping the repeat at three, and removing it uncapped a full-price one.
// Measured live the same day on a flight search: six near-identical Google
// Flights readings in one request, each ~2,500 characters of text plus sixty
// footer links, and the run hit its 150,000-token ceiling having found nothing.
test("re-reading an unchanged page returns a sentence, not the page again", async () => {
  const body = "Departure Return Search ".repeat(60);
  const { toolset } = webToolset({ readPageOverHttp: httpPage({ text: body }) });
  await toolset.execute("web_open", { url: "https://flights.example/search" });

  const first = await toolset.execute("web_read", {});
  const second = await toolset.execute("web_read", {});

  assert.ok(first.text.includes("Departure"), "the first read must carry the page");
  assert.match(second.text, /IDENTICAL/, "the second must say the page did not move");
  assert.ok(
    !second.text.includes("Departure Return Search Departure"),
    "the second must NOT repeat the page body"
  );
  // The size is the whole point of this test, so it is asserted directly rather
  // than implied: a repeat that is not dramatically smaller has not been fixed.
  assert.ok(
    second.text.length < first.text.length / 4,
    `an unchanged re-read cost ${second.text.length} chars against ${first.text.length} for the real one`
  );
});

test("a page that really changed is still returned in full", async () => {
  // The counter-case. Suppressing a CHANGED reading would be a far worse bug
  // than the one being fixed, so it is held here.
  let call = 0;
  const { toolset } = webToolset({
    readPageOverHttp: async (url) => {
      call += 1;
      return (await httpPage({ text: `Results page ${call}. ${"row ".repeat(50)}` })(url));
    }
  });
  await toolset.execute("web_open", { url: "https://flights.example/a" });
  const first = await toolset.execute("web_read", {});
  await toolset.execute("web_open", { url: "https://flights.example/b" });
  const second = await toolset.execute("web_read", {});
  assert.doesNotMatch(second.text, /IDENTICAL/, "a genuinely different page must not be called identical");
  assert.ok(second.text.length > first.text.length / 2, "and must be returned in full");
});

// A CONTROL THE DOM WILL NOT CLICK IS USUALLY ONE THE ACCESSIBILITY TREE WILL.
//
// Measured live, 29 Aug 2026, on Google Flights: its trip-type and cabin
// controls are bare divs that CDP will not fire, so web_click refused six times
// across "One way", "Round trip" and "Departure", and one call even reached for
// the desktop click tool with a browser element index -- eleven wasted calls.
// The agent then solved it in four: windows -> screen chrome -> click "Change
// ticket type. Round trip" -> click "One way", both landing first time, because
// Chromium publishes those divs to UIA as named comboboxes.
//
// Tokens SENT grow with the square of the step count, so those eleven calls are
// most of why that run sent 1.2M. The refusal now carries the way out.
test("an unclickable element sends the model to the window, not to another label", async () => {
  const { toolset } = webToolset({
    best: { found: true, target: { name: "Round trip", targetId: "t1" }, matchScore: 1, runnerUp: null, alternatives: [] },
    clickResult: { performed: false, reason: "the element could not be clicked" }
  });
  const result = await toolset.execute("web_click", { text: "Round trip", saw: "the form", say: "switching to one way" });

  assert.equal(result.ok, false, "a click that did not land must not report success");
  // The route out, named exactly, because a refusal without one is what the
  // model spent eleven calls working around.
  assert.match(result.text, /windows/, "must name the windows tool");
  assert.match(result.text, /screen/, "must name the screen tool");
  // And it must say NOT to keep trying labels, which is what actually happened.
  assert.match(result.text, /another label|refuse the same way/i);
});

// ---- one step, several questions ---------------------------------------------
//
// The expensive unit here is the STEP, not the request. Prefix caching on this
// endpoint is quantised into 8,192-token blocks, so every round trip re-buys its
// tail block — about 4,000 billed tokens — before it has looked at anything,
// while a search result set costs about 700 and an HTTP page read about 300.
//
// Measured live on 29 Aug 2026: a request for fifteen internships issued twenty
// searches ONE AT A TIME across eighteen steps, spent 154,590 fresh tokens, and
// hit its ceiling with the answer unfinished. About 14,000 of those tokens were
// the results. The rest was the asking.

test("several pages are read in one call, and the ones that failed are still reported", async () => {
  const pages = {
    "https://a.example/": { title: "Page A", text: `Alpha applies here. ${"Filler. ".repeat(60)}`, links: [{ label: "Apply now", href: "https://a.example/apply" }] },
    "https://b.example/": { title: "Page B", text: `Beta applies too. ${"Filler. ".repeat(60)}`, links: [{ label: "Apply", href: "https://b.example/apply" }] }
  };
  const { toolset, calls } = webToolset({
    readPageOverHttp: async (url) => (pages[url]
      ? { ok: true, url, status: 200, readable: true, reason: null, links: [], ...pages[url] }
      : { ok: false, url, title: "", text: "", links: [], reason: "the site answered HTTP 404" })
  });

  const result = await toolset.execute("web_open", { urls: ["https://a.example/", "https://b.example/", "https://gone.example/"] });
  assert.equal(result.ok, true);
  assert.match(result.text, /Read 2 of 3 pages/);
  assert.match(result.text, /Page A/);
  assert.match(result.text, /Page B/);
  // FOUR URLS IN AND THREE PAGES OUT is how a confident answer gets written
  // about a page nobody looked at. Every URL gets a line whatever happened.
  assert.match(result.text, /https:\/\/gone\.example\/[\s\S]*COULD NOT READ[\s\S]*404/);
  assert.ok(!calls.some((entry) => entry.operation === "launch"), "a batch read must not spend a browser");
});

test("a batch of pages does not become 'the page' that clicking acts on", async () => {
  // The batch is read-only on purpose. web_click, web_type and web_scroll all
  // act on ONE page, and quietly picking which of three that is would be the
  // "whose window is this" defect with a browser in place of a window.
  const { toolset, calls } = webToolset({
    best: domTarget("Read more"),
    readPageOverHttp: httpPage()
  });
  await toolset.execute("web_open", { url: "https://news.example/story" });
  await toolset.execute("web_open", { urls: ["https://other.example/one", "https://other.example/two"] });
  await toolset.execute("web_click", { text: "Read more" });

  const launched = calls.filter((entry) => entry.operation === "launch").map((entry) => entry.params.url);
  assert.deepEqual(launched, ["https://news.example/story"],
    "the click followed the batch instead of the page that was actually open");
});

test("asking a page a question returns the lines and links about it, not the page", async () => {
  // bestPassages was written for exactly this on 23 Aug 2026 and then never
  // called by anything for six days, while pages kept arriving as thousands of
  // characters of navigation wrapped around the two sentences that mattered.
  const { toolset } = webToolset({
    readPageOverHttp: httpPage({
      title: "Internship",
      text: [
        "Cookie preferences and privacy settings for this website.",
        "Follow us on social media for updates about our company.",
        "This internship pays a stipend of $9,000 per month and we sponsor visas.",
        "Our offices are open Monday to Friday between nine and five."
      ].join("\n"),
      links: [
        { label: "Cookie policy", href: "https://x.example/cookies" },
        { label: "Apply for this internship", href: "https://x.example/apply" },
        { label: "About us", href: "https://x.example/about" }
      ]
    })
  });
  const result = await toolset.execute("web_open", { url: "https://x.example/job", find: "stipend visa sponsorship apply" });

  assert.equal(result.ok, true);
  assert.match(result.text, /stipend of \$9,000 per month/);
  assert.match(result.text, /https:\/\/x\.example\/apply/);
  // The page furniture is what this exists to leave behind.
  assert.ok(!/Follow us on social media/.test(result.text), "an unrelated line was returned anyway");
  assert.ok(!/x\.example\/cookies/.test(result.text), "an unrelated link was returned anyway");
  // How much was actually searched, so the model can tell a thin page from a
  // thin answer.
  assert.match(result.text, /Searched all [\d,]+ characters/);
});

test("a page that does not mention what was asked says so, and shows what it is instead", async () => {
  // Silence here is indistinguishable from a page that failed to load, and the
  // recoveries are opposite: look somewhere else, versus look again.
  const { toolset } = webToolset({
    readPageOverHttp: httpPage({ title: "Recipes", text: `How to poach an egg. ${"Stir gently. ".repeat(40)}`, links: [] })
  });
  const result = await toolset.execute("web_open", { url: "https://x.example/", find: "quarterly dividend yield" });
  assert.match(result.text, /Nothing on this page mentions "quarterly dividend yield"/);
  assert.match(result.text, /poach an egg/, "the opening has to come back so the wrong page is visible as one");
});

test("a find that the browser route cannot honour says so rather than being ignored", async () => {
  // A request that is silently dropped is one the model has no way to stop
  // making. The browser hands back an already-clipped reading, so searching it
  // would report "nothing mentions it" about text further down the page.
  const { toolset } = webToolset({
    page: { url: "https://app.example/", title: "Dashboard", text: "Rendered by the browser." },
    readPageOverHttp: httpPage({ text: "", readable: false })
  });
  const result = await toolset.execute("web_open", { url: "https://app.example/", find: "pricing" });
  assert.match(result.text, /`find` was not applied/);
});

test("too many pages at once is refused with the number that would work", async () => {
  const { toolset } = webToolset({ readPageOverHttp: httpPage() });
  const many = Array.from({ length: 9 }, (unused, index) => `https://x.example/${index}`);
  const result = await toolset.execute("web_open", { urls: many });
  assert.equal(result.ok, false);
  assert.match(result.text, /too many/i);
  assert.match(result.text, /at most 6/);
});

test("a url list written as a single JSON string is understood rather than refused", async () => {
  // The same model that is given `urls: string[]` sends the array as text. There
  // is exactly one sensible reading of that, so refusing it buys nothing and
  // costs a round trip — and a round trip is the expensive unit here.
  const { toolset } = webToolset({ readPageOverHttp: httpPage() });
  const result = await toolset.execute("web_open", { urls: '["https://a.example/", "https://b.example/"]' });
  assert.equal(result.ok, true);
  assert.match(result.text, /Read 2 of 2 pages/);
});

test("all the questions go out in one call, and each one's results are labelled", async () => {
  const asked = [];
  const toolset = toolsetOver(baseAdapter(), {
    searchTheWeb: async (queries) => {
      asked.push(queries);
      return queries.map((query) => ({
        ok: true, query, provider: "duckduckgo+yahoo+bing", cached: false,
        results: [{ title: `${query} — a page`, url: `https://example.com/${encodeURIComponent(query)}`, snippet: "" }]
      }));
    }
  });

  const result = await toolset.execute("search", { queries: ["nvidia intern", "stripe intern", "meta intern"] });
  assert.equal(result.ok, true);
  assert.equal(asked.length, 1, "three questions must not be three calls");
  assert.deepEqual(asked[0], ["nvidia intern", "stripe intern", "meta intern"]);
  for (const query of ["nvidia intern", "stripe intern", "meta intern"]) {
    assert.match(result.text, new RegExp(`results? for "${query}"`));
  }
  // Numbered continuously across the batch, so a result can be referred to by a
  // number that means one thing in the whole reply rather than something
  // different under every heading.
  assert.match(result.text, /1\. nvidia intern/);
  assert.match(result.text, /2\. stripe intern/);
  assert.match(result.text, /3\. meta intern/);
});

test("a single query still behaves exactly as it did", async () => {
  const toolset = toolsetOver(baseAdapter(), {
    searchTheWeb: async (queries) => queries.map((query) => ({
      ok: true, query, provider: "duckduckgo", cached: false,
      results: [{ title: "Only result", url: "https://example.com/one", snippet: "A snippet." }]
    }))
  });
  const result = await toolset.execute("search", { query: "one thing" });
  assert.equal(result.ok, true);
  assert.match(result.text, /1 result for "one thing" \(duckduckgo\)/);
  assert.match(result.text, /1\. Only result/);
  assert.match(result.text, /https:\/\/example\.com\/one/);
});

test("a batch where some queries came back empty is still a success for the ones that did not", async () => {
  const toolset = toolsetOver(baseAdapter(), {
    searchTheWeb: async (queries) => queries.map((query, index) => (index === 0
      ? { ok: false, query, results: [], provider: null, reason: "duckduckgo-lite: declined the request (HTTP 202)" }
      : { ok: true, query, provider: "bing", cached: false, results: [{ title: "Found", url: "https://example.com/", snippet: "" }] }))
  });
  const result = await toolset.execute("search", { queries: ["refused", "answered"] });
  assert.equal(result.ok, true, "one refused index must not fail the whole batch");
  assert.match(result.text, /No results for "refused"/);
  assert.match(result.text, /1\. Found/);
});

test("every query being refused is a failure that names the engines' own words", async () => {
  const toolset = toolsetOver(baseAdapter(), {
    searchTheWeb: async (queries) => queries.map((query) => ({
      ok: false, query, results: [], provider: null, reason: "duckduckgo-lite: declined the request (HTTP 202)"
    }))
  });
  const result = await toolset.execute("search", { queries: ["a", "b"] });
  assert.equal(result.ok, false);
  assert.match(result.text, /None of the 2 searches returned anything/);
  // Rate-limited and "nothing matched" lead opposite ways, so they must not
  // collapse into one sentence.
  assert.match(result.text, /refusing requests from this machine/);
});

test("too many queries at once is refused with the number that would work", async () => {
  // Truncating silently would lose questions the model believes it asked, and it
  // would then report on results it never got — the exact false-success shape the
  // evidence layer exists to prevent.
  const toolset = toolsetOver(baseAdapter(), {
    searchTheWeb: async () => assert.fail("a batch over the cap must never reach the engines")
  });
  const result = await toolset.execute("search", { queries: Array.from({ length: 12 }, (unused, i) => `q${i}`) });
  assert.equal(result.ok, false);
  assert.match(result.text, /too many/i);
  assert.match(result.text, /at most 8/);
});

test("the same question written twice in one batch is asked once", async () => {
  let seen = null;
  const toolset = toolsetOver(baseAdapter(), {
    searchTheWeb: async (queries) => {
      seen = queries;
      return queries.map((query) => ({ ok: true, query, provider: "bing", results: [], cached: false }));
    }
  });
  await toolset.execute("search", { queries: ["same thing", "same thing", "other"] });
  assert.deepEqual(seen, ["same thing", "other"]);
});

// ---- watching something finish, in one step ---------------------------------
//
// `wait` took `{ms}` and nothing else, so "wait until it is done" had only one
// shape: sleep, look, sleep, look — and every look is a model round trip costing
// ~7,000 billed tokens whatever it finds.
//
// Measured live, 29 Aug 2026, installing a 190 MB app from the Store:
// wait 3s -> screen -> wait 8s -> screen -> wait 20s -> screen -> wait 8s. Seven
// round trips to read a progress bar, ~50,000 tokens. The six `wait` calls in
// that run produced 191 tokens of output between them.
//
// The machinery already existed and the loop could not reach it: waitForUiTarget
// polls in 250ms slices and wakes on UI Automation change events. It was never
// registered as a capability, so no tool could call it.

const waitToolset = (waitForUiTarget) => {
  const adapter = { ...baseAdapter(), waitForUiTarget };
  return toolsetOver(adapter);
};

test("a blind sleep still behaves exactly as it did", async () => {
  // Everything that worked before must keep working, and must not start
  // reaching for a window that was never named.
  let asked = 0;
  const toolset = waitToolset(async () => { asked += 1; return { matched: true }; });
  const result = await toolset.execute("wait", { ms: 10 });
  assert.equal(result.ok, true);
  assert.match(result.text, /Waited 10ms/);
  assert.equal(asked, 0, "a blind sleep must not watch a window");
});

test("waiting for a label to go returns the moment it goes, in one call", async () => {
  const seen = [];
  const toolset = waitToolset(async (request) => {
    seen.push(request);
    return { matched: true, elapsedMs: 1200, polls: 5, eventWakeups: 3 };
  });
  const result = await toolset.execute("wait", {
    until: "gone", text: "Almost done", application: "Microsoft Store"
  });
  assert.equal(result.ok, true);
  assert.equal(seen.length, 1, "a satisfied condition must not be asked twice");
  assert.equal(seen[0].condition, "absent", "\"gone\" has to become an absent condition, not a present one");
  assert.equal(seen[0].selector.nameContains, "Almost done");
  assert.equal(seen[0].application, "Microsoft Store");
  assert.match(result.text, /"Almost done" is gone/);
});

test("waiting for a label to appear asks for a present condition", async () => {
  const seen = [];
  const toolset = waitToolset(async (request) => { seen.push(request); return { matched: true }; });
  await toolset.execute("wait", { until: "appears", text: "Open", application: "Microsoft Store" });
  assert.equal(seen[0].condition, "present");
});

test("a wait that runs out is UNCONFIRMED, not a failure", async () => {
  // A download may still be running. "Could not check in time" and "it failed"
  // lead opposite ways, so they must not collapse into one verdict.
  const toolset = waitToolset(async () => ({ matched: false, reason: "ui-wait-timeout" }));
  const result = await toolset.execute("wait", {
    until: "gone", text: "Downloading", application: "Microsoft Store", timeoutMs: 1000
  });
  assert.match(result.text, /UNCONFIRMED|still there/i);
  assert.match(result.text, /read the screen/, "a timeout has to say what to do instead of waiting again");
});

test("a long wait keeps asking rather than giving up at the host's 20-second clamp", async () => {
  // The host clamps one wait to 20s. A 190 MB download takes longer, and the
  // whole point is that it stays ONE step.
  let calls = 0;
  const toolset = waitToolset(async () => {
    calls += 1;
    return calls < 3 ? { matched: false, reason: "ui-wait-timeout" } : { matched: true };
  });
  const result = await toolset.execute("wait", {
    until: "gone", text: "Downloading", application: "Microsoft Store", timeoutMs: 60000
  });
  assert.equal(result.ok, true);
  assert.ok(calls >= 3, `the wait gave up after ${calls} slices instead of continuing to the deadline`);
  assert.match(result.text, /is gone/);
});

test("a missing automation host stops immediately instead of spinning to the deadline", async () => {
  // A host that is not there will not become there by being asked again, and
  // spinning for two minutes to discover that would be the most expensive
  // possible way to report it.
  let calls = 0;
  const toolset = waitToolset(async () => {
    calls += 1;
    return { matched: false, reason: "automation-host-unavailable" };
  });
  const result = await toolset.execute("wait", {
    until: "gone", text: "Downloading", timeoutMs: 60000
  });
  assert.equal(calls, 1);
  assert.match(result.text, /automation-host-unavailable/);
});
