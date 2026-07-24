import test from "node:test";
import assert from "node:assert/strict";
import { CdpBrowserAdapter } from "../../os-adapters/browser/src/cdp-browser-adapter.js";

test("structured browser adapter inspects, grounds, interacts with, and reads DOM state", {
  skip: process.platform !== "win32"
}, async () => {
  const prior = process.env.SYSCORA_BROWSER_DISABLE_SANDBOX;
  // The test runner is itself sandboxed. Production does not set this flag.
  process.env.SYSCORA_BROWSER_DISABLE_SANDBOX = "1";
  const browser = new CdpBrowserAdapter({ requestTimeoutMs: 10000 });
  try {
    await browser.launch({
      headless: true,
      url: "data:text/html,<title>DOM proof</title><button id=\"go\" onclick=\"document.querySelector('p').textContent='Clicked'\">Continue</button><p>Ready</p><p>Python release version 3.14.6</p>"
    });
    const state = await browser.currentState();
    assert.equal(state.title, "DOM proof");
    const found = await browser.find({ text: "Continue" });
    assert.equal(found.found, true);
    assert.equal(found.target.source, "DOM");
    const action = await browser.click({ target: found.target });
    assert.equal(action.performed, true);
    const read = await browser.read({ selector: "p" });
    assert.deepEqual(read, { found: true, text: "Clicked" });
    const extracted = await browser.extract({ kind: "version", query: "Python", selector: "body" });
    assert.equal(extracted.found, true);
    assert.equal(extracted.value, "3.14.6");
    await assert.rejects(
      browser.click({ target: { ...found.target, targetId: "fabricated" } }),
      /runtime-observed DOM target/
    );
  } finally {
    browser.close();
    if (prior == null) delete process.env.SYSCORA_BROWSER_DISABLE_SANDBOX;
    else process.env.SYSCORA_BROWSER_DISABLE_SANDBOX = prior;
  }
});
