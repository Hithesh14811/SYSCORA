// THE BUG THIS EXISTS FOR, IN ONE SENTENCE: the floating pill sent every request
// without `x-syscora-token`, so the first thing anybody typed into it came back
// "Unauthorized: missing or invalid x-syscora-token header."
//
// The chat had wrapped `window.fetch` to attach the header since it was written.
// The overlay reproduced the fetch CALLS and not the wrapper — which is what a
// copied behaviour that was never a shared function eventually costs. It is a
// function now, and this is what stops the next surface forgetting it.

import test from "node:test";
import assert from "node:assert/strict";
import { withApiToken } from "../../apps/desktop/api-fetch.js";

function spy() {
  const calls = [];
  const impl = async (input, init) => { calls.push({ input, init }); return { ok: true }; };
  return { calls, impl };
}

const header = (call) => call.init?.headers?.["x-syscora-token"];

test("an /api request carries the token", async () => {
  const { calls, impl } = spy();
  await withApiToken(impl, "tok")("/api/intents", { method: "POST" });
  assert.equal(header(calls[0]), "tok");
  assert.equal(calls[0].init.method, "POST", "the caller's own options must survive");
});

test("a loopback request carries it too", async () => {
  const { calls, impl } = spy();
  await withApiToken(impl, "tok")("http://127.0.0.1:4317/api/health");
  assert.equal(header(calls[0]), "tok");
});

// Static assets are served unauthenticated on purpose, precisely so the token is
// never in the HTML. Sending it there would be putting the credential where it
// is not needed.
test("a static asset does not", async () => {
  const { calls, impl } = spy();
  await withApiToken(impl, "tok")("/overlay.css");
  assert.equal(header(calls[0]), undefined);
});

// A missing token is not an error: it means this page has not been given one.
// The request goes out bare so the daemon can answer 401 and the surface can say
// so, rather than the wrapper inventing a failure of its own.
test("no token means the request still goes, bare", async () => {
  const { calls, impl } = spy();
  const response = await withApiToken(impl, null)("/api/intents", { method: "POST" });
  assert.equal(response.ok, true);
  assert.equal(header(calls[0]), undefined);
});

test("existing headers are kept", async () => {
  const { calls, impl } = spy();
  await withApiToken(impl, "tok")("/api/intents", { headers: { "content-type": "application/json" } });
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(header(calls[0]), "tok");
});

// The wrapper's token wins, which is what `demo.js` has always done. Pinned so
// the two surfaces cannot start disagreeing about which credential goes out —
// that would be far worse than the case this forecloses, and no caller sets its
// own token anyway.
test("the wrapper's token wins over a caller's, as it does in the chat", async () => {
  const { calls, impl } = spy();
  await withApiToken(impl, "tok")("/api/intents", { headers: { "x-syscora-token": "mine" } });
  assert.equal(header(calls[0]), "tok");
});

test("a Request object is understood, not just a string", async () => {
  const { calls, impl } = spy();
  await withApiToken(impl, "tok")({ url: "/api/intents" });
  assert.equal(header(calls[0]), "tok");
});
