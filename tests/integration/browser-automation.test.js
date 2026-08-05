// GAP 4 — real browser automation against a LOCAL fixture page.
//
// The fixture is served by the test itself, so this suite never depends on live
// internet. Every assertion checks real DOM state before/after the action, not
// merely that no exception was thrown.

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  CdpBrowserAdapter,
  boundBrowserText,
  normalizeBrowserElement,
  resolveTargetSurface,
  BROWSER_TARGET_KIND,
  DESKTOP_TARGET_KIND,
  MAX_BROWSER_TEXT_BYTES
} from "../../os-adapters/browser/src/cdp-browser-adapter.js";
import { RiskEngine } from "../../packages/risk-engine/src/index.js";
import { PolicyEngine } from "../../packages/policy-engine/src/index.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";

const FIXTURE_HTML = `<!doctype html>
<html><head><title>SYSCORA fixture</title></head>
<body style="margin:0">
  <h1 id="heading">Fixture ready</h1>
  <main><article data-result><a href="/fare-one">Delhi to Mumbai fare</a><p>Nonstop itinerary INR 5,000</p></article></main>
  <p id="status">Not clicked</p>
  <button id="go" onclick="document.getElementById('status').textContent='Clicked once'">Continue</button>
  <form id="payment" onsubmit="event.preventDefault();document.getElementById('status').textContent='Submitted'">
    <input id="card-name" name="cardName" type="text" />
    <button id="pay" type="submit">Place order</button>
  </form>
  <p id="release">Fixture release version 4.12.9</p>
  <div style="height:4000px">tall spacer</div>
  <p id="bottom">Bottom of page</p>
</body></html>`;

describe("Browser automation against a local fixture", { skip: process.platform !== "win32" }, () => {
  let server;
  let fixtureUrl;
  let browser;
  let priorSandboxFlag;

  before(async () => {
    server = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

    priorSandboxFlag = process.env.SYSCORA_BROWSER_DISABLE_SANDBOX;
    // The test runner is itself sandboxed. Production does not set this.
    process.env.SYSCORA_BROWSER_DISABLE_SANDBOX = "1";
    browser = new CdpBrowserAdapter({ requestTimeoutMs: 15000 });
    await browser.launch({ headless: true, url: "about:blank" });
  });

  after(async () => {
    browser?.close();
    if (priorSandboxFlag == null) delete process.env.SYSCORA_BROWSER_DISABLE_SANDBOX;
    else process.env.SYSCORA_BROWSER_DISABLE_SANDBOX = priorSandboxFlag;
    await new Promise((resolve) => server.close(resolve));
  });

  it("uses a dedicated automation profile, never the real user profile", () => {
    const profile = browser.userDataDir;
    assert.ok(profile, "an explicit automation profile directory is required");
    assert.ok(
      profile.startsWith(path.join(os.tmpdir(), "syscora-cdp-")),
      `automation profile must live in an isolated temp dir, got ${profile}`
    );
    assert.ok(fs.existsSync(profile));
    // Prove by PATH that it is not the user's real Edge/Chrome profile.
    const realProfiles = [
      path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "User Data"),
      path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data")
    ];
    for (const real of realProfiles) {
      assert.notEqual(path.resolve(profile), path.resolve(real));
      assert.ok(!path.resolve(profile).startsWith(path.resolve(real)));
    }
  });

  it("navigates to the fixture and reads real page state", async () => {
    const state = await browser.navigate({ url: fixtureUrl });
    assert.equal(state.title, "SYSCORA fixture");
    assert.equal(state.readyState, "complete");
    const heading = await browser.read({ selector: "#heading" });
    assert.deepEqual(heading, { found: true, text: "Fixture ready" });
  });

  it("finds an element by text and clicks it, changing real DOM state", async () => {
    await browser.navigate({ url: fixtureUrl });
    const before = await browser.read({ selector: "#status" });
    assert.equal(before.text, "Not clicked");

    const found = await browser.find({ text: "Continue" });
    assert.equal(found.found, true);
    // Shared element shape, so browser and desktop grounding look alike.
    assert.equal(typeof found.target.id, "string");
    assert.equal(found.target.role, "button");
    assert.equal(found.target.text, "Continue");
    assert.equal(found.target.clickable, true);
    assert.ok(found.target.bbox.width > 0 && found.target.bbox.height > 0);
    assert.equal(found.target.targetKind, BROWSER_TARGET_KIND);

    const clicked = await browser.click({ target: found.target });
    assert.equal(clicked.performed, true);

    const after = await browser.read({ selector: "#status" });
    assert.equal(after.text, "Clicked once", "the click must change real DOM state");
  });

  it("types into a grounded field and the value is really set", async () => {
    await browser.navigate({ url: fixtureUrl });
    const field = await browser.find({ selector: "#card-name" });
    assert.equal(field.found, true);
    await browser.type({ target: field.target, text: "Ada Lovelace" });
    const value = await browser.read({ selector: "#card-name" });
    assert.equal(value.text, "Ada Lovelace");
  });

  it("scrolls the real viewport and reports the position change", async () => {
    await browser.navigate({ url: fixtureUrl });
    const scrolled = await browser.scroll({ y: 1200 });
    assert.equal(scrolled.performed, true);
    assert.equal(scrolled.scrollBefore.y, 0);
    assert.ok(
      scrolled.scrollAfter.y > scrolled.scrollBefore.y,
      `scroll position must change: before=${scrolled.scrollBefore.y} after=${scrolled.scrollAfter.y}`
    );
    assert.equal(scrolled.moved, true);
  });

  it("inspects the page as bounded, shared-shape elements", async () => {
    await browser.navigate({ url: fixtureUrl });
    const elements = await browser.inspect({ limit: 50 });
    assert.ok(Array.isArray(elements) && elements.length > 0);
    for (const element of elements) {
      assert.equal(typeof element.id, "string");
      assert.ok("role" in element && "text" in element && "bbox" in element && "clickable" in element);
    }
    assert.ok(elements.some((element) => element.text === "Continue" && element.clickable === true));
    assert.ok(elements.some((element) => element.text === "Fixture ready" && element.clickable === false));
  });

  it("extracts a typed scalar from real page text", async () => {
    await browser.navigate({ url: fixtureUrl });
    const extracted = await browser.extract({ kind: "version", query: "Fixture release", selector: "body" });
    assert.equal(extracted.found, true);
    assert.equal(extracted.value, "4.12.9");
  });

  it("extracts bounded sourced research without clicking or submitting", async () => {
    await browser.navigate({ url: fixtureUrl });
    const before = await browser.read({ selector: "#status" });
    const result = await browser.researchState({ limit: 5 });
    const after = await browser.read({ selector: "#status" });
    assert.equal(result.found, true);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, "Delhi to Mumbai fare");
    assert.match(result.items[0].snippet, /INR 5,000/);
    assert.match(result.items[0].url, /\/fare-one$/);
    assert.equal(before.text, "Not clicked");
    assert.equal(after.text, "Not clicked", "research must not click or submit anything");
    assert.ok(!Number.isNaN(Date.parse(result.observedAt)));
  });

  it("refuses a fabricated target that perception never returned", async () => {
    await browser.navigate({ url: fixtureUrl });
    const found = await browser.find({ text: "Continue" });
    await assert.rejects(
      browser.click({ target: { ...found.target, targetId: "fabricated" } }),
      /runtime-observed DOM target/
    );
  });
});

describe("Browser extraction is bounded", () => {
  it("truncates page text to the model observation ceiling", () => {
    const huge = "x".repeat(MAX_BROWSER_TEXT_BYTES * 3);
    const bounded = boundBrowserText(huge);
    assert.equal(bounded.truncated, true);
    assert.ok(Buffer.byteLength(bounded.text, "utf8") <= MAX_BROWSER_TEXT_BYTES);
    assert.equal(bounded.originalBytes, MAX_BROWSER_TEXT_BYTES * 3);
    // Content that already fits is passed through untouched.
    assert.deepEqual(boundBrowserText("short"), { text: "short", truncated: false });
  });
});

describe("Browser target surface routing", () => {
  it("discriminates a DOM target from a desktop window target", () => {
    const dom = normalizeBrowserElement({ tag: "button", text: "Continue", targetId: "t1", selector: "[data-x]" });
    assert.equal(resolveTargetSurface(dom), BROWSER_TARGET_KIND);
    assert.equal(
      resolveTargetSurface({ source: "UIA", automationId: "129", name: "Save", windowId: "42" }),
      DESKTOP_TARGET_KIND
    );
    assert.equal(resolveTargetSurface(null), DESKTOP_TARGET_KIND);
  });
});

describe("Browser risk tiering", () => {
  const registry = createDefaultCapabilityRegistry({});
  const riskEngine = new RiskEngine({ capabilityRegistry: registry });
  const policyEngine = new PolicyEngine();

  const assess = (task) => {
    const plan = { taskGraph: { tasks: [task] } };
    const assessment = riskEngine.assess(plan, {}, { evaluatedAt: Date.now() });
    const decision = policyEngine.decide(assessment, plan, {
      capabilities: [registry.get(task.capability)]
    });
    return { assessment, decision };
  };

  // NOTE: this runtime already rates every browser capability that reaches the
  // network at HIGH, via blastRadius=EXTERNAL_SYSTEM. That is stricter than a
  // "MEDIUM for read-only navigation" tiering would be, so these tests assert
  // the existing floor is preserved rather than lowering it. The verb-based
  // classification below adds the finer, auditable signal on top.
  it("keeps read-only extraction non-mutating and never marks it irreversible", () => {
    for (const capability of ["browser.read", "browser.extract", "browser.inspect"]) {
      const { assessment } = assess({ capability, inputs: { selector: "body", kind: "text" } });
      assert.equal(assessment.dimensions.mutationImpact, "READ_ONLY", `${capability} must stay read-only`);
      assert.equal(assessment.dimensions.externalEffect, "NETWORK_READ");
      assert.ok(
        !assessment.reasons.some((reason) => /consequential control/i.test(reason.why ?? "")),
        `${capability} must not be flagged as a consequential interaction`
      );
    }
  });

  it("never lowers the external-effect floor for network-reaching navigation", () => {
    const { assessment } = assess({ capability: "browser.navigate", inputs: { url: "https://example.com" } });
    assert.equal(assessment.dimensions.blastRadius, "EXTERNAL_SYSTEM");
    assert.equal(assessment.overallRisk, "HIGH");
  });

  it("escalates a consequential page interaction and stops it at approval", () => {
    const { assessment, decision } = assess({
      capability: "browser.click",
      inputs: { target: { targetKind: BROWSER_TARGET_KIND, tag: "button", text: "Place order", type: "submit" } }
    });
    assert.equal(assessment.overallRisk, "HIGH");
    // The distinguishing signal: "Place order" is a financial external effect,
    // not the plain NETWORK_READ that an ordinary click carries.
    assert.equal(assessment.dimensions.externalEffect, "FINANCIAL_OR_SECURITY");
    assert.notEqual(decision.effect, "ALLOW", "a purchase-like click must not auto-execute");
    assert.ok(
      assessment.reasons.some((reason) => /consequential control/i.test(reason.why ?? "")),
      "the assessment must say why it was raised"
    );
  });

  it("does not apply the consequential escalation to a benign control", () => {
    const { assessment } = assess({
      capability: "browser.click",
      inputs: { target: { targetKind: BROWSER_TARGET_KIND, tag: "button", text: "Continue" } }
    });
    assert.equal(assessment.dimensions.externalEffect, "NETWORK_READ");
    assert.ok(!assessment.reasons.some((reason) => /consequential control/i.test(reason.why ?? "")));
  });

  // Proving the tier in isolation is not enough: the done bar is that the REAL
  // runtime authorization gate — the same one OS-level HIGH-risk actions go
  // through — refuses to auto-execute a consequential browser interaction.
  it("stops a consequential browser interaction at the runtime authorization gate", async () => {
    const basePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "syscora-browser-gate-"));
    try {
      const runtime = createRuntime(basePath);
      const session = runtime._createSession({ autoApprove: false });
      const plan = {
        planId: "plan_browser_gate",
        planVersion: 1,
        goal: "submit the payment form",
        summary: "Click the Place order control",
        finalSuccessCriteria: ["the order is placed"],
        taskGraph: {
          graphId: "graph_browser_gate",
          tasks: [{
            taskId: "task_place_order",
            goal: "Click Place order",
            description: "Click the grounded Place order control",
            dependencies: [],
            capability: "browser.click",
            inputs: {
              target: {
                targetId: "t1", source: "DOM", selector: "[data-syscora-target=\"t1\"]",
                targetKind: BROWSER_TARGET_KIND, tag: "button", text: "Place order", type: "submit"
              }
            },
            expectedStateChanges: [],
            affectedEntities: [],
            riskHints: "HIGH",
            verificationCriteria: ["the order confirmation is visible"],
            completionCriteria: ["the order is placed"],
            rollbackRequired: false,
            timeout: 20000,
            retryBudget: 0,
            idempotency: false
          }]
        }
      };

      const gate = await runtime._authorizePlan(session, plan, { phase: "INITIAL", autoApprove: false });

      assert.equal(gate.authorized, false, "a purchase-like browser click must not be authorized unattended");
      assert.equal(session.riskAssessment.overallRisk, "HIGH");
      assert.equal(session.riskAssessment.dimensions.externalEffect, "FINANCIAL_OR_SECURITY");
      assert.notEqual(session.policyDecision.effect, "ALLOW");
      assert.ok(
        ["AWAITING_APPROVAL", "DENIED", "PLAN_REJECTED"].includes(session.finalResponse.status),
        `expected the gate to hold the plan, got ${session.finalResponse.status}`
      );
    } finally {
      await fs.promises.rm(basePath, { recursive: true, force: true });
    }
  });

  it("declares browser writes as unsupported for rollback rather than omitting it", () => {
    for (const name of ["browser.click", "browser.type", "browser.select", "browser.download"]) {
      const capability = registry.get(name);
      assert.equal(capability.rollback.supported, false, `${name} must declare rollback explicitly`);
      assert.notEqual(capability.reversibility, "ROLLBACK_SUPPORTED");
      assert.ok(capability.rollback.reason);
    }
  });
});
