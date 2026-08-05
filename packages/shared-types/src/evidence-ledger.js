import crypto from "node:crypto";

function containsExact(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsExact(item, expected));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsExact(item, expected));
  }
  return false;
}

function contentFingerprint(value) {
  if (value === undefined) return null;
  let serialized;
  try { serialized = JSON.stringify(value); } catch { serialized = String(value); }
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

export function createEvidenceLedger() {
  return { version: 1, entries: [] };
}

export function appendEvidence(ledger, evidence = {}) {
  const entry = {
    evidenceId: evidence.evidenceId ?? `evidence_${crypto.randomUUID()}`,
    taskId: evidence.taskId ?? null,
    subgoalId: evidence.subgoalId ?? evidence.taskId ?? null,
    criterionIds: [...new Set(evidence.criterionIds ?? [])],
    capability: evidence.capability ?? null,
    modality: evidence.modality ?? null,
    observation: evidence.observation ?? null,
    verification: evidence.verification ?? null,
    source: evidence.source ?? evidence.provenance?.source ?? evidence.observation?.source ?? null,
    confidence: Number.isFinite(evidence.confidence)
      ? evidence.confidence
      : (Number.isFinite(evidence.verification?.confidence) ? evidence.verification.confidence : null),
    verificationMethod: evidence.verificationMethod ?? evidence.verification?.method ?? null,
    identity: evidence.identity ?? null,
    independentFromActionResult: evidence.independentFromActionResult === true,
    value: evidence.value,
    contentFingerprint: evidence.contentFingerprint ?? contentFingerprint(evidence.value),
    provenance: evidence.provenance ?? null,
    producedBindings: [...new Set(evidence.producedBindings ?? [])],
    consumedBindings: [...new Set(evidence.consumedBindings ?? [])],
    timestamp: evidence.timestamp ?? new Date().toISOString()
  };
  ledger.entries.push(entry);
  return entry;
}

export function evaluateEvidenceLedger(goalContract, ledger, bindings = {}) {
  const entries = ledger?.entries ?? [];
  const criteria = (goalContract?.criteria ?? []).map((criterion) => {
    const candidates = entries.filter((entry) => entry.criterionIds.includes(criterion.criterionId));
    const evidence = candidates.filter((entry) => {
      const timestampValid = Number.isFinite(Date.parse(entry.timestamp));
      return entry.verification?.status === "VERIFIED"
        && entry.independentFromActionResult === true
        && entry.observation !== null
        && typeof entry.source === "string" && entry.source.length > 0
        && typeof entry.verificationMethod === "string" && entry.verificationMethod.length > 0
        && Number.isFinite(entry.confidence) && entry.confidence >= 0 && entry.confidence <= 1
        && timestampValid;
    });
    const rejectionReasons = [];
    if (candidates.length > 0 && evidence.length === 0) {
      if (candidates.every((entry) => entry.independentFromActionResult !== true)) rejectionReasons.push("NOT_INDEPENDENT");
      if (candidates.every((entry) => entry.observation === null)) rejectionReasons.push("MISSING_OBSERVATION");
      if (candidates.every((entry) => !entry.source)) rejectionReasons.push("MISSING_SOURCE");
      if (candidates.every((entry) => !entry.verificationMethod)) rejectionReasons.push("MISSING_VERIFICATION_METHOD");
    }
    return {
      criterionId: criterion.criterionId,
      description: criterion.description,
      satisfied: evidence.length > 0,
      evidenceIds: evidence.map((entry) => entry.evidenceId),
      rejectionReasons
    };
  });
  const lineage = Object.entries(bindings).map(([name, binding]) => {
    const consumers = entries.filter((entry) =>
      entry.consumedBindings.includes(binding.bindingId ?? name)
      && (
        containsExact([entry.observation, entry.value, entry.verification?.evidence], binding.value)
        || (entry.contentFingerprint && entry.contentFingerprint === (binding.contentFingerprint ?? contentFingerprint(binding.value)))
      )
    );
    return {
      bindingId: binding.bindingId ?? name,
      name,
      value: binding.value,
      producerEvidenceId: binding.producerEvidenceId ?? null,
      consumerEvidenceIds: consumers.map((entry) => entry.evidenceId),
      verified: consumers.length > 0
    };
  });
  return {
    satisfied: criteria.length > 0 && criteria.every((criterion) => criterion.satisfied),
    satisfiedCount: criteria.filter((criterion) => criterion.satisfied).length,
    totalCriteria: criteria.length,
    criteria,
    unsatisfiedCriteria: criteria.filter((criterion) => !criterion.satisfied).map((criterion) => criterion.description),
    lineage
  };
}
