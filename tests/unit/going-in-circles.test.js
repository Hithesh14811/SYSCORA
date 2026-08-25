// THE RUN THAT WENT ROUND IN CIRCLES ON YOUTUBE.
//
// Live, 24 Aug 2026, twice. "Play the most viewed video of <channel>": the agent
// opened the channel's /videos page in the controlled browser, could not see the
// list, re-read it, clicked "Popular", re-read, opened a sort URL, re-read,
// clicked "Popular" by label, then by element index, then by coordinate, then
// focused the window and clicked again. 31 steps, 153,747 billed tokens, stopped
// by the cost ceiling with a random video playing.
//
// Three separate things were missing, and none of them is the model being
// stupid — each is something the machine knew and never said:
//
//   1. YouTube cannot be read this way. Measured: youtube.com over HTTP returns
//      173 characters, all footer, so `readable` is false; the controlled
//      browser then renders a fragment. Nothing said so, so it was rediscovered
//      the expensive way.
//   2. Re-reading an unchanged page returns the same characters. The repeat
//      guard in index.js counts ARGUMENTS, and the arguments differed each time.
//   3. A click in a browser does not move focus, so every one of those clicks
//      was reported "nothing confirms it acted" — the ordinary answer inside a
//      browser, read as a failure and retried four times.
//
// All three are fixed the way this codebase fixes this class: in the RESULT,
// where it is read at the moment it matters and costs nothing the rest of the
// time. No new gate, nothing refused.

import test from "node:test";
import assert from "node:assert/strict";
import { buildToolset, slowSiteNotice } from "../../packages/fast-agent/src/tools.js";

// A toolset over a stubbed browser, in the same shape tool-evidence.test.js
// uses — so what is asserted below is what the model would actually be handed,
// not what the source looks like it would produce. The first version of this
// check stubbed the browser wrongly, every reading came back "the controlled
// browser has no page open", and two of the four assertions passed for that
// reason. Build the real thing and read the real output.
function browserAt(url, { title = "", text = "", elements = [] } = {}) {
  const capabilities = {
    "browser.launch": async () => ({ launched: true }),
    "browser.wait": async () => ({ waited: true }),
    "browser.currentState": async () => ({ url, title, readyState: "complete" }),
    "browser.inspect": async () => elements,
    "browser.read": async () => ({ found: Boolean(text), text })
  };
  return buildToolset({
    registry: { get: (name) => (capabilities[name] ? { execute: capabilities[name] } : null) },
    adapter: {
      executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      listWindows: async () => [],
      listProcessParents: async () => new Map()
    },
    basePath: "C:\\work"
  });
}

test("a YouTube page says what cannot be read here, and names the route that works", () => {
  for (const url of [
    "https://www.youtube.com/@SlayyPointOfficial/videos?view=0&sort=p&flow=grid",
    "https://youtube.com/watch?v=HJ52GhzFsV4",
    "https://m.youtube.com/results?search_query=angry+prash",
    "https://youtu.be/HJ52GhzFsV4"
  ]) {
    const notice = slowSiteNotice(url);
    assert.ok(notice, `no notice for ${url}`);
    // The two halves that matter: what will not work, and what will.
    assert.match(notice, /re-reading or clicking again will not change that/i);
    assert.match(notice, /`search`/, "it must name the tool that answers the question");
    assert.match(notice, /open_url/, "it must name the tool that plays the video");
  }
});

// A LIST OF DIFFICULT SITES IS WRONG THE WEEK AFTER IT IS WRITTEN. This one has
// a single entry, put there by a measurement, and it must not creep.
test("nothing else is branded unreadable", () => {
  for (const url of [
    "https://en.wikipedia.org/wiki/Node.js",
    "https://github.com/nodejs/node",
    "https://news.ycombinator.com/",
    "https://www.google.com/search?q=x",
    "not a url",
    ""
  ]) {
    assert.equal(slowSiteNotice(url), null, `${url} should carry no notice`);
  }
});

// THE READING THE MODEL IS ACTUALLY HANDED. The channel page renders as nothing
// here, and the empty-page branch returned BEFORE the advice was reached — so
// the one case that matters was telling it to "try web_read once more", which is
// the loop this exists to stop.
test("a YouTube page that renders nothing carries the advice, not an invitation to retry", async () => {
  const toolset = browserAt("https://www.youtube.com/@SlayyPointOfficial/videos", {
    title: "Slayy Point - YouTube"
  });
  const reading = await toolset.execute("web_read", {});
  assert.match(reading.text, /YouTube is a JavaScript application/);
  assert.match(reading.text, /open_url/);
  assert.ok(!/Try web_read once more/.test(reading.text),
    "the empty branch must not ask for the retry that produced this loop");
});

test("a YouTube page that renders something still says what cannot be read here", async () => {
  const toolset = browserAt("https://www.youtube.com/@SlayyPointOfficial/videos", {
    title: "Slayy Point - YouTube",
    text: "Slayy Point Videos Latest Popular Oldest",
    elements: [{ controlType: "a", text: "Popular", clickable: true, href: "https://www.youtube.com/@x/videos" }]
  });
  const reading = await toolset.execute("web_read", {});
  assert.match(reading.text, /YouTube is a JavaScript application/);
  assert.match(reading.text, /Popular/, "the fragment it CAN see must still be shown");
});

// THE REPEAT GUARD COUNTS ARGUMENTS; THIS COUNTS CHARACTERS. Live, the arguments
// differed every time — a different URL had been opened in between — so nothing
// ever said the obvious thing: you already have this reading.
test("reading the same page twice says so the second time, not the first", async () => {
  const toolset = browserAt("https://www.youtube.com/@x/videos", {
    title: "x - YouTube",
    text: "Latest Popular Oldest",
    elements: [{ controlType: "a", text: "Popular", clickable: true, href: "https://www.youtube.com/@x/videos" }]
  });
  const first = await toolset.execute("web_read", {});
  const second = await toolset.execute("web_read", {});
  assert.ok(!/CHARACTER-FOR-CHARACTER/.test(first.text), "a first reading is new information");
  assert.match(second.text, /CHARACTER-FOR-CHARACTER/);
  assert.match(second.text, /Reading it again will return this again/);
});

// The notices must not follow the model onto every site it visits.
test("an ordinary page is rendered exactly as before", async () => {
  const toolset = browserAt("https://en.wikipedia.org/wiki/Node.js", {
    title: "Node.js - Wikipedia",
    text: "Node.js is a cross-platform runtime environment."
  });
  const reading = await toolset.execute("web_read", {});
  assert.match(reading.text, /Node\.js is a cross-platform runtime environment\./);
  assert.ok(!/YouTube is a JavaScript application/.test(reading.text));
  assert.ok(!/CHARACTER-FOR-CHARACTER/.test(reading.text));
});

// A CLICK IN A BROWSER DOES NOT MOVE FOCUS, AND THAT IS NOT A FAILURE.
//
// Live: "Clicked 'Popular' at 439,1230 — but nothing confirms it acted: focus is
// on 'Angry Prash - YouTube'" — the window's own title, because a Chromium page
// keeps focus on the document. Read as a failed click, it was retried by label,
// by element index, by coordinate, and again after focusing the window.
//
// This is checked through the toolset because the first version of the test read
// three fields off the CLICK result — `application`, `processName`,
// `windowTitle` — none of which exist on it. It could never have fired, and
// nothing would have said so.
test("an unconfirmed click in a browser says that is normal, and says not to click again", async () => {
  const elements = [
    { role: "button", text: "Popular", clickable: true, bounds: { x: 400, y: 1200, width: 80, height: 30 } }
  ];
  const capabilities = {
    "screen.read": async () => ({
      read: true, windowId: "7", application: "AvastBrowser",
      title: "Angry Prash - YouTube - Avast Secure Browser", visibleText: "Latest Popular Oldest", elements
    }),
    "pointer.clickAt": async (inputs) => ({ performed: true, x: inputs.x, y: inputs.y })
  };
  const toolset = buildToolset({
    registry: { get: (name) => (capabilities[name] ? { execute: capabilities[name] } : null) },
    adapter: {
      executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      listWindows: async () => [{ WindowHandle: 7, ProcessName: "AvastBrowser", MainWindowTitle: "Angry Prash - YouTube" }],
      listProcessParents: async () => new Map(),
      // Focus stays on the document, which is what a browser does and what made
      // every one of those clicks look like a failure.
      focusedElement: async () => ({ found: true, name: "Angry Prash - YouTube", value: "" }),
      invokeControl: async () => ({ performed: false, reason: "unavailable" }),
      getForegroundWindow: async () => ({ windowId: "7", processName: "AvastBrowser", title: "Angry Prash - YouTube" })
    },
    basePath: "C:\work"
  });

  await toolset.execute("screen", { application: "AvastBrowser" });
  const clicked = await toolset.execute("click", { text: "Popular" });

  assert.match(clicked.text, /nothing confirms it acted/, "the honest half must stay — it did not verify");
  assert.match(clicked.text, /normal in a browser/, "and it must say that is ordinary here, not a fault");
  assert.match(clicked.text, /do not click it again/i, "the retry loop is the thing being stopped");
});
