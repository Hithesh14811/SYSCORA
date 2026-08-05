import crypto from "node:crypto";

function containsExact(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsExact(item, expected));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsExact(item, expected));
  }
  return false;
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
    value: evidence.value,
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
    const evidence = entries.filter((entry) =>
      entry.criterionIds.includes(criterion.criterionId)
      && entry.verification?.status === "VERIFIED"
    );
    return {
      criterionId: criterion.criterionId,
      description: criterion.description,
      satisfied: evidence.length > 0,
      evidenceIds: evidence.map((entry) => entry.evidenceId)
    };
  });
  const lineage = Object.entries(bindings).map(([name, binding]) => {
    const consumers = entries.filter((entry) =>
      entry.consumedBindings.includes(binding.bindingId ?? name)
      && containsExact([entry.observation, entry.value, entry.verification?.evidence], binding.value)
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
