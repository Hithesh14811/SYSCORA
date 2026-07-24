function containsExactValue(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactValue(item, expected));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsExactValue(item, expected));
  }
  return false;
}

export function evaluateTransitionContracts(actions = [], bindings = {}) {
  return Object.entries(bindings).map(([name, binding]) => {
    const producer = actions.find((entry) => entry?.action?.capability === binding.sourceCapability
      && entry?.resultEnvelope?.provenance?.step === binding.sourceStep);
    const consumers = actions.filter((entry) =>
      entry?.succeeded && containsExactValue(entry?.action?.inputs, binding.value)
    );
    const independentMatches = actions.filter((entry) =>
      entry?.succeeded
      && entry?.action?.capability !== binding.sourceCapability
      && /(?:\.read$|\.verify|\.inspect$|\.currentState$|\.find$)/.test(String(entry?.action?.capability ?? ""))
      && containsExactValue(entry?.executionResult, binding.value)
    );
    const provenanceValid = Boolean(binding.provenance?.capability && binding.provenance?.source);
    const exactTransferVerified = consumers.length > 0 && independentMatches.length > 0;
    const sourceUrl = producer?.executionResult?.url ?? producer?.resultEnvelope?.data?.url ?? null;
    const sourceKind = producer?.executionResult?.title === binding.value
      ? "page title"
      : producer?.action?.capability?.startsWith("ui.") ? "GUI value" : "typed value";
    return {
      binding: name,
      type: binding.type,
      value: binding.value,
      producerCapability: binding.sourceCapability,
      producerStep: binding.sourceStep,
      producerSubgoal: producer?.action?.subgoal ?? null,
      sourceUrl,
      sourceKind,
      provenance: binding.provenance ?? null,
      provenanceValid,
      consumers: consumers.map((entry) => ({
        capability: entry.action.capability,
        step: entry.resultEnvelope?.provenance?.step ?? null
      })),
      independentVerifiers: independentMatches.map((entry) => ({
        capability: entry.action.capability,
        step: entry.resultEnvelope?.provenance?.step ?? null
      })),
      exactTransferVerified,
      summary: exactTransferVerified
        ? `Exact consumer content matches producer ${sourceKind} value${String(sourceUrl).startsWith("data:text/html") ? " from HTML data URI" : ""}.`
        : "Typed transition has not yet been independently verified."
    };
  });
}
