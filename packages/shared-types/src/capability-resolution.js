export const CapabilityResolutionKind = Object.freeze({
  EXACT_MATCH: "EXACT_MATCH",
  CANONICAL_ALIAS: "CANONICAL_ALIAS",
  UNKNOWN_CAPABILITY: "UNKNOWN_CAPABILITY",
  AMBIGUOUS_CAPABILITY: "AMBIGUOUS_CAPABILITY"
});

function structuralKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, "");
}

function declaredAliases(capability) {
  return [
    ...(Array.isArray(capability?.aliases) ? capability.aliases : []),
    ...(Array.isArray(capability?.canonicalAliases) ? capability.canonicalAliases : []),
    ...(Array.isArray(capability?.metadata?.aliases) ? capability.metadata.aliases : [])
  ].map(String).filter(Boolean);
}

export function resolveCapabilityId(requestedId, catalog = []) {
  const requested = String(requestedId ?? "").trim();
  const capabilities = Array.isArray(catalog) ? catalog : [];
  const exact = capabilities.find((capability) => capability?.name === requested);
  if (exact) {
    return {
      kind: CapabilityResolutionKind.EXACT_MATCH,
      requestedId: requested,
      canonicalId: exact.name,
      candidates: [exact.name]
    };
  }

  const requestedKey = structuralKey(requested);
  if (!requestedKey) {
    return {
      kind: CapabilityResolutionKind.UNKNOWN_CAPABILITY,
      requestedId: requested,
      canonicalId: null,
      candidates: []
    };
  }

  const matches = capabilities.filter((capability) => {
    if (!capability?.name) return false;
    return declaredAliases(capability).some((alias) => structuralKey(alias) === requestedKey);
  });
  const candidates = [...new Set(matches.map((capability) => capability.name))];
  if (candidates.length === 1) {
    return {
      kind: CapabilityResolutionKind.CANONICAL_ALIAS,
      requestedId: requested,
      canonicalId: candidates[0],
      candidates
    };
  }
  return {
    kind: candidates.length > 1
      ? CapabilityResolutionKind.AMBIGUOUS_CAPABILITY
      : CapabilityResolutionKind.UNKNOWN_CAPABILITY,
    requestedId: requested,
    canonicalId: null,
    candidates
  };
}

export function canonicalizeCapabilityAction(action, catalog = []) {
  if (!action || typeof action !== "object") {
    return {
      ok: false,
      resolution: resolveCapabilityId(null, catalog),
      action
    };
  }
  const resolution = resolveCapabilityId(action.capability, catalog);
  const ok = resolution.kind === CapabilityResolutionKind.EXACT_MATCH
    || resolution.kind === CapabilityResolutionKind.CANONICAL_ALIAS;
  return {
    ok,
    resolution,
    action: ok ? { ...action, capability: resolution.canonicalId } : action
  };
}
