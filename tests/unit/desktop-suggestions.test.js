// Regression guard for the desktop suggested-prompt wiring (Phase 1).
//
// The investor demo's one-click suggestions broke because demo.html buttons
// carried `data-text` while demo.js listened for `data-prompt` — clicks did
// nothing. This test locks the attribute name on BOTH sides so they can never
// drift apart again. It is a static source check (no DOM/browser needed).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const html = fs.readFileSync(path.join(repoRoot, "apps/desktop/demo.html"), "utf8");
const js = fs.readFileSync(path.join(repoRoot, "apps/desktop/demo.js"), "utf8");

test("every suggestion button declares a data-text prompt", () => {
  const buttons = [...html.matchAll(/<button class="suggestion"([^>]*)>/g)];
  assert.ok(buttons.length >= 5, `expected the demo suggestions, found ${buttons.length}`);
  for (const [, attrs] of buttons) {
    assert.match(attrs, /data-text="[^"]+"/, `suggestion button missing data-text: ${attrs}`);
  }
});

test("demo.js reads the SAME attribute the buttons declare (no data-prompt drift)", () => {
  // The click handler must key off data-text and must NOT reference data-prompt.
  assert.match(js, /button\[data-text\]/, "handler must select buttons by data-text");
  assert.match(js, /getAttribute\("data-text"\)/, "handler must read data-text");
  assert.doesNotMatch(js, /data-prompt/, "stale data-prompt reference must be gone");
});

test("suggested prompts submit through the normal chat path (no bypass)", () => {
  // The handler calls submit(text) — the same function the chat form uses — so a
  // suggestion is not a special execution route.
  const handlerRegion = js.slice(js.indexOf("suggestions.addEventListener"));
  assert.match(handlerRegion, /submit\(text\)/, "suggestion must call submit(text)");
});
