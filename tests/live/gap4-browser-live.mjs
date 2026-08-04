/**
 * GAP 4 live reproduction.
 *
 * Drives the REAL capability path (registry -> adapter -> CDP) to prove browser
 * automation is a real controlled browser session, not a `cmd start` URL open:
 * a visible Chromium window opens on an isolated automation profile, navigates,
 * finds and clicks a real element, and the interaction is reflected in a
 * follow-up browser.read.
 *
 * Uses DuckDuckGo's HTML endpoint (stable, no JS-app shell, no consent wall).
 * Set SYSCORA_LIVE_HEADLESS=1 to run without a visible window.
 */
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

const QUERY = process.env.SYSCORA_LIVE_QUERY ?? "wikipedia";
const HEADLESS = process.env.SYSCORA_LIVE_HEADLESS === "1";

const adapter = new WindowsAdapter();
// createDefaultCapabilityRegistry takes the adapter positionally.
const registry = createDefaultCapabilityRegistry(adapter);
const run = async (name, inputs) => {
  const capability = registry.get(name);
  if (!capability) throw new Error(`capability not registered: ${name}`);
  const result = await capability.execute(inputs);
  return result;
};

console.log("=== GAP 4 LIVE REPRODUCTION ===");
console.log("query:", QUERY, "| headless:", HEADLESS);

let passed = false;
try {
  const launched = await run("browser.launch", {
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(QUERY)}`,
    headless: HEADLESS
  });
  console.log("\nbrowser.launch ->", JSON.stringify({
    launched: launched.launched,
    executable: launched.executable,
    lifecycle: launched.lifecycle?.state
  }));
  console.log("automation profile (isolated):", adapter.browserAutomation.userDataDir);

  await run("browser.wait", { condition: "document.readyState", value: "complete", timeoutMs: 20000 });
  const state = await run("browser.currentState", {});
  console.log("browser.currentState ->", JSON.stringify({ url: state.url?.slice(0, 90), title: state.title }));

  const elements = await run("browser.inspect", { limit: 200 });
  console.log(`browser.inspect -> ${elements.length} elements in shared shape`);
  const clickableWithText = elements.filter((element) =>
    element.clickable && element.text.length > 3 && typeof element.href === "string" && /^https?:/.test(element.href)
  );
  console.log(`  clickable links with text: ${clickableWithText.length}`);
  console.log("  sample:", JSON.stringify(clickableWithText[0] ?? elements[0]).slice(0, 220));

  // Ground the first organic result. DuckDuckGo's HTML endpoint marks these
  // with .result__a; fall back to the first substantive link if the markup
  // changes, so the proof does not hinge on one site's class names.
  let found = await run("browser.find", { selector: "a.result__a" });
  if (!found.found && clickableWithText[0]) {
    found = await run("browser.find", { selector: `a[href="${clickableWithText[0].href}"]` });
  }
  if (!found.found) throw new Error("no result link could be grounded on the results page");
  console.log("grounded first result ->", JSON.stringify({
    id: found.target.id, role: found.target.role, text: found.target.text.slice(0, 60),
    bbox: found.target.bbox, clickable: found.target.clickable, targetKind: found.target.targetKind
  }));

  const beforeUrl = (await run("browser.currentState", {})).url;
  const clicked = await run("browser.click", { target: found.target });
  console.log("browser.click ->", JSON.stringify({ performed: clicked.performed }));

  await run("browser.wait", { condition: "document.readyState", value: "complete", timeoutMs: 20000 });
  const afterState = await run("browser.currentState", {});
  const readBack = await run("browser.read", { selector: "body" });
  if (!readBack.text) {
    const diagnostic = await adapter.browserAutomation._evaluate(`(() => ({
      readyState: document.readyState,
      hasBody: Boolean(document.body),
      childCount: document.body ? document.body.childElementCount : -1,
      innerTextLen: (document.body && document.body.innerText || "").length,
      textContentLen: (document.body && document.body.textContent || "").length,
      visibility: document.visibilityState,
      url: location.href
    }))()`).catch((error) => ({ evaluateError: error.message }));
    console.log("  DIAGNOSTIC (empty read):", JSON.stringify(diagnostic));
  }

  console.log("\nafter click:");
  console.log("  url before:", String(beforeUrl).slice(0, 90));
  console.log("  url after :", String(afterState.url).slice(0, 90));
  console.log("  title after:", afterState.title);
  console.log("  browser.read bytes:", Buffer.byteLength(readBack.text ?? "", "utf8"), "truncated:", Boolean(readBack.truncated));
  console.log("  body starts:", (readBack.text ?? "").replace(/\s+/g, " ").slice(0, 140));

  const navigated = beforeUrl !== afterState.url;
  const readReflects = Boolean(readBack.found && (readBack.text ?? "").length > 0);
  const boundedRead = Buffer.byteLength(readBack.text ?? "", "utf8") <= 4000;
  const isolatedProfile = /syscora-cdp-/.test(String(adapter.browserAutomation.userDataDir));

  console.log("\n--- gate ---");
  console.log("real controlled browser launched:", launched.launched === true);
  console.log("isolated automation profile (not the user's):", isolatedProfile);
  console.log("clicked a real grounded element:", clicked.performed === true);
  console.log("interaction changed the page (navigated):", navigated);
  console.log("follow-up browser.read reflects it:", readReflects);
  console.log("read output bounded:", boundedRead);

  passed = launched.launched === true && isolatedProfile && clicked.performed === true
    && navigated && readReflects && boundedRead;
} catch (error) {
  console.error("\nERROR:", error.message);
} finally {
  adapter.browserAutomation?.close?.();
}

console.log(passed ? "\nGAP 4 LIVE: PASS" : "\nGAP 4 LIVE: FAIL");
process.exit(passed ? 0 : 1);
