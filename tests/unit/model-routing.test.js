// Model selection, and the rule that decides whether an attachment can be sent
// at all.
//
// The behaviour that matters: a model that cannot see images must never be
// handed one. The failure mode being designed out is the quiet one — the file
// goes, the model cannot read it, and the answer is confidently about nothing.

import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO, MODELS, checkAttachments, chooseModel, modelById, requirementsFor, selectableModels
} from "../../apps/desktop/models.js";

const anImage = { kind: "image", name: "screenshot.png", dataUrl: "data:image/png;base64,AAA" };
const aDocument = (chars = 500) => ({ kind: "document", name: "resume.pdf", text: "x".repeat(chars) });

test("the catalogue is well formed — routing is only as good as this", () => {
  for (const model of MODELS) {
    assert.ok(model.id && model.label, "every model needs an id and a label");
    assert.equal(typeof model.capabilities.images, "boolean", `${model.id} must state whether it can see`);
    assert.equal(typeof model.capabilities.contextTokens, "number");
    assert.ok(model.costPerMTok > 0, "cost is what Auto orders by");
  }
  assert.ok(selectableModels().length >= 1, "at least one model has to be selectable");
});

test("requirements come from the attachments, not from the wording", () => {
  assert.equal(requirementsFor({ attachments: [anImage] }).needsImages, true);
  assert.equal(requirementsFor({ attachments: [aDocument()] }).needsImages, false);
  assert.equal(requirementsFor({ attachments: [] }).needsImages, false);
});

test("a long document is measured, so it can be routed on size", () => {
  const requirements = requirementsFor({ attachments: [aDocument(40_000)] });
  assert.equal(requirements.approxTokens, 10_000);
});

test("Auto picks a model and always gives a reason", () => {
  const { model, reason } = chooseModel(requirementsFor({ attachments: [] }));
  assert.ok(model, "Auto must choose something when a capable model exists");
  assert.match(reason, /Auto chose/, "a picker that chooses silently is one nobody trusts");
});

test("Auto refuses rather than picking something blind for an image", () => {
  // No configured model can see today, which is exactly the case that must not
  // fail silently.
  const anyCanSee = MODELS.some((model) => model.capabilities.images);
  const { model, reason } = chooseModel({ needsImages: true });
  if (anyCanSee) {
    assert.ok(model?.capabilities.images, "the chosen model has to be one that can actually see");
  } else {
    assert.equal(model, null);
    assert.match(reason, /not pictures|cannot read images/i);
  }
});

test("a refusal names a way out that actually exists", () => {
  const blind = MODELS.find((model) => !model.capabilities.images);
  if (!blind) return; // nothing to prove once every model can see
  const result = checkAttachments(blind.id, [anImage]);
  assert.equal(result.ok, false);

  // A REFUSAL THAT NAMES NO WAY OUT IS A DEAD END, and one that names the WRONG
  // way out is worse — the user follows it and finds nothing there. This used to
  // say "switch to Auto and one will be chosen for you" unconditionally, which
  // is only true when Auto has something to route to. When nothing configured
  // can see, sending them to the router is sending them to a door that is not
  // in the wall.
  const anyCanSee = MODELS.some((model) => model.capabilities.images);
  if (anyCanSee) {
    assert.match(result.reason, /Auto|another model/i);
  } else {
    assert.ok(!/switch to Auto/i.test(result.reason),
      "Auto is being offered as the way out when Auto has nothing to route to");
    // The way out that IS real: SYSCORA runs on the machine the picture is on.
    assert.match(result.reason, /describe|SYSCORA can open|ask SYSCORA/i);
  }
});

test("a document is fine for a model that cannot see — it travels as text", () => {
  const blind = MODELS.find((model) => !model.capabilities.images);
  if (!blind) return;
  assert.equal(checkAttachments(blind.id, [aDocument()]).ok, true);
});

test("an unknown model id is refused rather than defaulted", () => {
  const result = checkAttachments("gpt-9-imaginary", []);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not configured/);
});

test("AUTO is routed, not treated as a model id", () => {
  assert.equal(modelById(AUTO), null, "AUTO must not resolve to a model");
  const result = checkAttachments(AUTO, []);
  assert.equal(result.ok, true);
  assert.ok(result.model, "routing AUTO has to end at a real model");
});
