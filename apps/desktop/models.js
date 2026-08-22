// WHICH MODEL, AND WHO DECIDES.
//
// There is one model family configured today, so a picker is not useful yet —
// but the SHAPE of the decision is what makes adding the second one a data
// change instead of a rewrite. Everything below is driven by the catalogue, and
// the catalogue is the only thing that has to grow.
//
// AUTO IS A ROUTER, NOT A DEFAULT.
//
// "Auto" means: look at what the request actually needs — can it see images, does
// it need a long context, is this a cheap question — and pick the cheapest model
// that can do it. That is a real decision with a real reason, and the reason is
// shown to the user, because a picker that silently chooses for you is a picker
// nobody trusts.

/**
 * The models this build knows about.
 *
 * `capabilities` is the part that matters: file and image handling is decided
 * from here, so a model that cannot see an image can never be handed one.
 * `costPerMTok` is relative and only used for ordering — Auto picks the
 * cheapest CAPABLE model, so the numbers need to rank correctly, not to be
 * invoices.
 */
export const MODELS = [
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    blurb: "Fast and inexpensive. The default for everyday work.",
    capabilities: { text: true, images: false, documents: true, contextTokens: 128000 },
    costPerMTok: 0.28,
    available: true
  }
];

export const AUTO = "auto";

export const modelById = (id) => MODELS.find((model) => model.id === id) ?? null;

/** Models that can actually be selected right now. */
export const selectableModels = () => MODELS.filter((model) => model.available !== false);

/**
 * What does this request need from a model?
 *
 * Derived from the attachments rather than from the prompt text: an image is an
 * image whatever the sentence around it says, and guessing intent from wording
 * is the kind of rule that fails the first time somebody phrases it differently.
 */
export function requirementsFor({ attachments = [] } = {}) {
  const needsImages = attachments.some((file) => file.kind === "image");
  // A document is TEXT by the time it reaches the model — see attachments.js,
  // which extracts before sending — so it needs no special capability beyond
  // enough context to hold it.
  const extractedChars = attachments
    .filter((file) => file.kind === "document")
    .reduce((total, file) => total + (file.text?.length ?? 0), 0);
  return {
    needsImages,
    // Four characters to a token is the approximation used everywhere else in
    // this project; it is a ratio for comparing, not a tokeniser.
    approxTokens: Math.ceil(extractedChars / 4)
  };
}

/**
 * Choose a model for a request, and say why.
 *
 * Returns `{ model, reason }`, or `{ model: null, reason }` when nothing
 * configured can do the job — which the surface must show rather than send the
 * request anyway and let it fail somewhere the user cannot see.
 */
export function chooseModel(requirements = {}) {
  const capable = selectableModels().filter((model) => {
    if (requirements.needsImages && !model.capabilities.images) return false;
    if (requirements.approxTokens && requirements.approxTokens > model.capabilities.contextTokens * 0.6) return false;
    return true;
  });
  if (capable.length === 0) {
    return {
      model: null,
      reason: requirements.needsImages
        ? "No configured model can read images."
        : "This is larger than any configured model's context window."
    };
  }
  const cheapest = [...capable].sort((a, b) => a.costPerMTok - b.costPerMTok)[0];
  const why = [];
  if (requirements.needsImages) why.push("it can read images");
  if (requirements.approxTokens > 20000) why.push("the attached text is long");
  return {
    model: cheapest,
    reason: why.length
      ? `Auto chose ${cheapest.label} because ${why.join(" and ")}.`
      : `Auto chose ${cheapest.label} — cheapest model that fits this request.`
  };
}

/**
 * Can the CHOSEN model handle these attachments? Used when the user has picked
 * a model explicitly, where the honest answer is to refuse and say what to do,
 * not to quietly send an image to something blind.
 */
export function checkAttachments(modelId, attachments = []) {
  if (modelId === AUTO) {
    const { model, reason } = chooseModel(requirementsFor({ attachments }));
    return model ? { ok: true, model, reason } : { ok: false, reason };
  }
  const model = modelById(modelId);
  if (!model) return { ok: false, reason: "That model is not configured." };
  const images = attachments.filter((file) => file.kind === "image");
  if (images.length && !model.capabilities.images) {
    return {
      ok: false,
      model,
      reason: `${model.label} cannot read images. Pick a model that can, or switch to Auto and one will be chosen for you.`
    };
  }
  return { ok: true, model, reason: null };
}
