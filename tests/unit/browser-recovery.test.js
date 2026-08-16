// THE BROWSER BELONGS TO THE USER, AND THEY WILL CLOSE IT.
//
// `this.process` is a ChildProcess object and stays truthy forever: a dead
// browser leaves it set exactly as a live one does, and so does `this.connection`
// whose socket closed along with the browser. The reuse branch in `launch()` saw
// two truthy fields and tried to talk down a socket to a process that no longer
// existed — "CDP connection failed", permanently, for the life of the daemon.
//
// Live, that cost one session 46 steps and 803,000 tokens: with web_open dead the
// agent fell back to scraping search engines through CAPTCHAs, and still got the
// right answer, which is why nobody noticed it was broken.

import test from "node:test";
import assert from "node:assert/strict";

const { CdpBrowserAdapter } = await import("../../os-adapters/browser/src/cdp-browser-adapter.js");

// A browser that is alive until something kills it, without spawning Chrome.
function fakeBrowser({ killed = false, exitCode = null } = {}) {
  const adapter = new CdpBrowserAdapter();
  adapter.process = {
    killed,
    exitCode,
    signalCode: null,
    kill() { this.killed = true; },
    unref() {},
    stderr: { removeAllListeners() {}, destroy() {} }
  };
  adapter.connection = {
    socket: { readyState: WebSocket.OPEN },
    close() { this.socket.readyState = WebSocket.CLOSED; }
  };
  return adapter;
}

test("a live browser is reused", () => {
  assert.equal(fakeBrowser()._isAlive(), true);
});

test("a browser the user closed is not mistaken for a live one", () => {
  const killed = fakeBrowser();
  killed.process.kill();
  assert.equal(killed._isAlive(), false, "killed by the user");

  const exited = fakeBrowser({ exitCode: 0 });
  assert.equal(exited._isAlive(), false, "exited on its own");

  const crashed = fakeBrowser();
  crashed.process.signalCode = "SIGTERM";
  assert.equal(crashed._isAlive(), false, "killed by a signal");
});

// The process can outlive its debugging socket — a crashed target, a sleeping
// machine, a network blip on loopback. Reusing that connection is the same
// failure by a different route.
test("a live process with a dead socket is not a usable browser", () => {
  const adapter = fakeBrowser();
  adapter.connection.socket.readyState = WebSocket.CLOSED;
  assert.equal(adapter._isAlive(), false);

  const closing = fakeBrowser();
  closing.connection.socket.readyState = WebSocket.CLOSING;
  assert.equal(closing._isAlive(), false);
});

test("with nothing launched at all there is nothing to reuse", () => {
  const adapter = new CdpBrowserAdapter();
  assert.equal(adapter._isAlive(), false);
});

// The whole point: a dead browser must be replaced, not reported as a failure.
test("launching after the browser died starts a new one instead of failing", async () => {
  const adapter = fakeBrowser();
  adapter.process.kill();

  let launched = 0;
  // Stand in for the real spawn: record that a FRESH launch was attempted
  // rather than the dead session being reused.
  adapter._findExecutable = () => {
    launched += 1;
    throw Object.assign(new Error("no browser on this machine"), { code: "NO_BROWSER" });
  };

  await assert.rejects(() => adapter.launch({ url: "https://example.com" }));
  assert.equal(launched, 1, "it must try to start a new browser, not reuse the dead one");
  assert.equal(adapter.process, null, "and the dead handles must be cleared");
  assert.equal(adapter.connection, null);
});
