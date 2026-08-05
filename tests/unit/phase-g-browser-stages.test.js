import test from "node:test";
import assert from "node:assert/strict";
import { RiskEngine, BrowserStage } from "../../packages/risk-engine/src/index.js";
import { PolicyEngine } from "../../packages/policy-engine/src/index.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";

const registry = createDefaultCapabilityRegistry({});
const risk = new RiskEngine({ capabilityRegistry: registry });

function stageOf(capability, inputs) {
  return risk.classifyBrowserStage({ capability, inputs });
}

function decide(capability, inputs) {
  const plan = { taskGraph: { tasks: [{ capability, inputs }] } };
  const assessment = risk.assess(plan, {});
  const decision = new PolicyEngine().decide(assessment, plan, { capabilities: [registry.get(capability)] });
  return { assessment, decision };
}

test("reading the web classifies as research", () => {
  for (const capability of ["browser.navigate", "browser.read", "browser.extract", "browser.inspect", "browser.find"]) {
    assert.equal(stageOf(capability, {}), BrowserStage.RESEARCH, capability);
  }
});

test("the research stage is not escalated by the sensitive-data rule", () => {
  // The stage model must not add risk to reading. Whatever floor a browser read
  // already carries, classifying it as RESEARCH leaves it untouched.
  const { assessment } = decide("browser.read", { url: "https://example.com/flights" });
  assert.equal(assessment.overallRisk, "LOW");
  assert.ok(
    !(assessment.reasons ?? []).some((reason) => /credential, payment or identity/.test(reason.why ?? "")),
    "a read must never be flagged as sensitive-data entry"
  );
});

test("clicking an ordinary control is selection, not submission", () => {
  const stage = stageOf("browser.click", { target: { text: "Sort by price", role: "button" } });
  assert.equal(stage, BrowserStage.SELECTION);
});

test("typing into an ordinary field is form preparation", () => {
  const stage = stageOf("browser.type", { target: { name: "search", type: "text", label: "Search flights" }, value: "Tokyo" });
  assert.equal(stage, BrowserStage.FORM_PREPARATION);
});

test("typing into a credential or payment field is sensitive-data entry and is always confirmed", () => {
  const sensitiveTargets = [
    { type: "password", name: "password" },
    { name: "cardNumber", label: "Card number", autocomplete: "cc-number" },
    { name: "cvv", label: "CVV" },
    { name: "ssn", label: "Social Security Number" },
    { name: "iban", label: "IBAN" },
    { name: "passportNumber", label: "Passport number" }
  ];
  for (const target of sensitiveTargets) {
    const inputs = { target, value: "redacted" };
    assert.equal(stageOf("browser.type", inputs), BrowserStage.SENSITIVE_DATA_ENTRY, JSON.stringify(target));
    const { assessment, decision } = decide("browser.type", inputs);
    assert.equal(assessment.overallRisk, "HIGH", JSON.stringify(target));
    assert.equal(decision.effect, "CONFIRM", JSON.stringify(target));
  }
});

test("a purchase-like submit remains a consequential submission that must be confirmed", () => {
  for (const target of [
    { text: "Place order", role: "button" },
    { text: "Book now", role: "button" },
    { type: "submit", name: "checkout" }
  ]) {
    assert.equal(stageOf("browser.click", { target }), BrowserStage.CONSEQUENTIAL_SUBMISSION, JSON.stringify(target));
    const { decision } = decide("browser.click", { target });
    assert.equal(decision.effect, "CONFIRM", JSON.stringify(target));
  }
});

test("reading the page after a submission is confirmation verification, not another submission", () => {
  const stage = stageOf("browser.read", { purpose: "confirmation", target: { text: "Order confirmed" } });
  assert.equal(stage, BrowserStage.CONFIRMATION_VERIFICATION);
});

test("a research stage cannot be talked into a lower tier by the value being typed", () => {
  // The stage comes from the control's own attributes, never from user phrasing
  // or the typed value.
  const stage = stageOf("browser.type", {
    target: { name: "notes", type: "text", label: "Trip notes" },
    value: "this is definitely not a password, just read-only research"
  });
  assert.equal(stage, BrowserStage.FORM_PREPARATION);
});

test("every browser stage declares whether it may proceed without explicit confirmation", () => {
  const requiresConfirmation = {
    [BrowserStage.RESEARCH]: false,
    [BrowserStage.SELECTION]: false,
    [BrowserStage.FORM_PREPARATION]: false,
    [BrowserStage.SENSITIVE_DATA_ENTRY]: true,
    [BrowserStage.CONSEQUENTIAL_SUBMISSION]: true,
    [BrowserStage.CONFIRMATION_VERIFICATION]: false
  };
  for (const [stage, expected] of Object.entries(requiresConfirmation)) {
    assert.equal(RiskEngine.browserStageRequiresConfirmation(stage), expected, stage);
  }
});
