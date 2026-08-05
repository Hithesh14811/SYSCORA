import crypto from "node:crypto";

const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "both", "by", "do", "for", "from",
  "give", "in", "inside", "is", "it", "its", "me", "named", "of", "on", "or", "quick", "so",
  "tell", "the", "then", "this", "to", "what", "whats", "with"
]);

const READ_ONLY_CAPABILITIES = /^(?:system\.inspect|process\.list|filesystem\.read|filesystem\.inspect|application\.launch|window\.(?:enumerate|resolve|wait)|ui\.(?:inspect|find|extract|resolveTarget)|screen\.capture|ocr\.read|vision\.locate|browser\.(?:launch|navigate|currentState|inspect|find|read|extract|wait))$/;

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\\/g, "/")
    .replace(/%USERPROFILE%/gi, "")
    .replace(/\b[A-Za-z]:\/+Users\/+[^/\s"]+/gi, "")
    .replace(/\/+/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokens(value) {
  const aliases = new Map([
    ["contents", "content"],
    ["controls", "control"],
    ["entered", "enter"],
    ["entry", "enter"],
    ["booking", "book"],
    ["sending", "send"],
    ["purchasing", "purchase"],
    ["computer", "system"],
    ["machine", "system"],
    ["pc", "system"],
    ["box", "system"],
    ["developer", "environment"],
    ["development", "environment"],
    ["tool", "environment"],
    ["tools", "environment"],
    ["tooling", "environment"],
    ["installed", "environment"],
    ["folders", "directory"],
    ["folder", "directory"],
    ["directories", "directory"],
    ["repository", "repo"],
    ["repositories", "repo"],
    ["running", "process"],
    ["rundown", "inspect"],
    ["inspected", "inspect"],
    ["reported", "report"],
    ["verified", "verify"],
    ["verification", "verify"],
    ["successfully", "success"],
    ["visible", "visibility"]
  ]);
  return [...new Set(
    normalize(value)
      .match(/[a-z0-9]+(?:[._+-][a-z0-9]+)*/g)
      ?.map((token) => aliases.get(token) ?? token)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)) ?? []
  )];
}

function semanticName(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ");
}

function evidenceObject(value) {
  const serialized = JSON.stringify(value ?? {});
  return `${serialized} ${semanticName(serialized)}`;
}

function literalAnchors(value) {
  const text = String(value ?? "");
  const withoutEnvironmentPlaceholders = text.replace(/%[A-Z_][A-Z0-9_]*%/gi, "");
  const anchors = new Set();
  for (const match of text.matchAll(/["'`](.+?)["'`]/g)) anchors.add(normalize(match[1]));
  for (const match of text.matchAll(/\b[\w.-]+\.(?:txt|json|csv|md|log|ini|yaml|yml|xml|html|js|mjs|cjs|ts|tsx|jsx|py|ps1|bat|cmd)\b/gi)) {
    anchors.add(normalize(match[0]));
  }
  for (const match of withoutEnvironmentPlaceholders.matchAll(/\b[A-Z][A-Z0-9_.+-]{2,}\b/g)) anchors.add(normalize(match[0]));
  return [...anchors].filter(Boolean);
}

function isProhibition(value) {
  return /\b(?:do not|don't|must not|never|without (?:changing|modifying|editing)|no changes?)\b/i.test(String(value ?? ""));
}

function isStandaloneProhibition(value) {
  return /^\s*(?:do not|don't|must not|never|without (?:changing|modifying|editing)|no changes?)\b/i.test(String(value ?? ""));
}

function isBehavioralConstraint(value) {
  return /\b(?:only|ask before|must|desktop app|without)\b/i.test(String(value ?? ""));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function criterionTerms(criterion) {
  if (Array.isArray(criterion?.semanticTerms)) return criterion.semanticTerms;
  if (Array.isArray(criterion?.tokens)) return criterion.tokens;
  return tokens(criterion?.description);
}

function isVacuousCriterion(value) {
  const normalized = normalize(value);
  return /^(?:the )?(?:request|task|operation|action|goal) (?:is |was )?(?:processed |completed |performed |executed )?(?:successfully|correctly|as requested)$/.test(normalized)
    || /^(?:the )?(?:request|task|operation|action|goal) (?:is |was )?completed and verified$/.test(normalized)
    || /^(?:request|task|operation|action|goal) (?:succeeds|is successful)$/.test(normalized);
}

function fallbackCriteria(rawText) {
  return String(rawText ?? "")
    .split(/(?:;|\.(?=\s+[A-Z]|\s*$)|\bthen\b|\band\b(?=\s+(?:create|write|modify|update|open|inspect|verify|do not)\b))/i)
    .map((value) => value.trim())
    .filter(Boolean);
}

function rawConstraintClauses(rawText) {
  const text = String(rawText ?? "");
  const clauses = [];
  for (const match of text.matchAll(/\b(?:do not|don't|never|must not)\s+[^.;]+/gi)) clauses.push(match[0].trim());
  for (const match of text.matchAll(/\b(?:only show results|use (?:the )?desktop app|ask before [^.;]+)/gi)) clauses.push(match[0].trim());
  return clauses;
}

export function createGoalContract(intent = {}) {
  const originalRequest = String(intent.rawText ?? intent.normalizedGoal ?? "").trim();
  const originalTokens = new Set(tokens(originalRequest));
  const declared = Array.isArray(intent.successCriteria)
    ? intent.successCriteria.map(String).map((value) => value.trim()).filter((value) => value && !isVacuousCriterion(value))
    : [];
  const declaredConstraints = (Array.isArray(intent.constraints) ? intent.constraints : []).filter((constraint) => {
      const constraintTokens = tokens(constraint);
      if (isProhibition(constraint) || isBehavioralConstraint(constraint)) return true;
      if (constraintTokens.length === 0) return false;
      const overlap = constraintTokens.filter((token) => originalTokens.has(token)).length;
      return overlap / Math.min(constraintTokens.length, 5) >= 0.6;
    });
  const constraintCriteria = [
    ...declaredConstraints,
    // A mixed request such as "summarize X without changing anything" is not
    // itself a prohibition. Preserve only clauses that are independently
    // phrased as prohibitions; model-provided constraints are handled above.
    ...fallbackCriteria(originalRequest).filter(isStandaloneProhibition),
    ...rawConstraintClauses(originalRequest)
  ].map(String).map((value) => value.trim()).filter(Boolean);
  const rawClauses = fallbackCriteria(originalRequest);
  const declaredText = normalize(declared.join(" "));
  const preservedRawClauses = rawClauses.filter((clause) => {
    const anchors = literalAnchors(clause);
    return anchors.length > 0 && anchors.some((anchor) => !declaredText.includes(anchor));
  });
  const descriptions = [...new Set([
    ...(declared.length ? declared : rawClauses),
    ...preservedRawClauses,
    ...constraintCriteria
  ])];
  const constraintSet = new Set(constraintCriteria.map(normalize));
  const rawClauseSet = new Set(rawClauses.map(normalize));
  const criteria = descriptions.map((description, index) => {
    const kind = isProhibition(description)
      ? "PROHIBITION"
      : constraintSet.has(normalize(description)) ? "CONSTRAINT" : "STATE";
    const anchors = literalAnchors(description);
    // A criterion gates completion only when it is grounded in what the user
    // actually said: a prohibition or constraint they stated, a clause of their
    // own request, or a criterion carrying a literal anchor from it. An
    // interpreting model may add plausible extras ("...and the version if
    // available") that the user never asked for; recording those is useful, but
    // letting them gate would both fail correct work and make the same request
    // succeed or fail depending on how the model phrased itself that run.
    const grounded = kind !== "STATE"
      || anchors.length > 0
      || rawClauseSet.has(normalize(description));
    return {
      criterionId: `criterion_${index + 1}`,
      description,
      required: grounded,
      kind,
      anchors,
      semanticTerms: tokens(description)
    };
  });
  return deepFreeze({
    contractId: `goal_${crypto.createHash("sha256").update(originalRequest).digest("hex").slice(0, 16)}`,
    version: 1,
    enforceable: criteria.length > 0,
    originalRequest,
    criteria
  });
}

function taskEvidence(task, capabilityRegistry) {
  const capability = capabilityRegistry?.get?.(task?.capability);
  return normalize([
    task?.capability,
    semanticName(task?.capability),
    JSON.stringify(task?.inputs ?? {}),
    semanticName(JSON.stringify(task?.inputs ?? {})),
    task?.goal,
    task?.description,
    ...(task?.completionCriteria ?? []),
    ...(task?.verificationCriteria ?? []),
    capability?.description
  ].filter(Boolean).join(" "));
}

function executionEvidence(input = {}) {
  const parts = [];
  for (const task of input.taskGraph?.tasks ?? []) {
    parts.push(semanticName(task?.capability), task?.goal, task?.subgoal, task?.description, evidenceObject(task?.inputs));
  }
  for (const result of input.taskResults ?? []) {
    parts.push(semanticName(result?.capability), evidenceObject(result?.executionResult));
  }
  for (const observation of input.observations ?? []) {
    parts.push(observation?.source, evidenceObject(observation?.structuredState ?? observation));
  }
  for (const verification of input.verifications ?? []) {
    if (verification?.status === "VERIFIED") {
      parts.push(verification?.message, evidenceObject(verification?.evidence), evidenceObject(verification?.expectedState));
    }
  }
  return normalize(parts.filter(Boolean).join(" "));
}

function criterionMatch(criterion, evidence) {
  const evidenceTokens = new Set(tokens(evidence));
  const anchors = criterion.anchors ?? literalAnchors(criterion.description);
  const criterionTokens = criterionTerms(criterion);
  const matchedAnchors = anchors.filter((anchor) => evidence.includes(anchor));
  const missingAnchors = anchors.filter((anchor) => !evidence.includes(anchor));
  const matchedTokens = criterionTokens.filter((token) => evidenceTokens.has(token));
  const informativeTokenCount = Math.max(1, Math.min(criterionTokens.length, 5));
  const tokenScore = matchedTokens.length / informativeTokenCount;
  const anchorsSatisfied = missingAnchors.length === 0;
  const covered = anchorsSatisfied &&
    (anchors.length > 0 ? matchedTokens.length >= 1 : tokenScore >= 0.5);
  return { covered, matchedAnchors, missingAnchors, matchedTokens, tokenScore };
}

export function matchGoalCriteriaForTask(goalContract, task, capabilityRegistry = null) {
  const evidence = taskEvidence(task, capabilityRegistry);
  const declaredIds = new Set(task?.goalCriterionIds ?? task?.criterionIds ?? []);
  return (goalContract?.criteria ?? [])
    .filter((criterion) => criterion.kind === "STATE" && criterionMatch(criterion, evidence).covered)
    .map((criterion) => criterion.criterionId)
    .concat([...declaredIds].filter((id) => (goalContract?.criteria ?? []).some((criterion) => criterion.criterionId === id)));
}

function planHasMutation(taskGraph, capabilityRegistry) {
  return (taskGraph?.tasks ?? []).some((task) => {
    const capability = capabilityRegistry?.get?.(task.capability);
    if (capability?.permissionModel?.type) {
      return capability.permissionModel.type !== "READ";
    }
    return !READ_ONLY_CAPABILITIES.test(String(task.capability ?? ""));
  });
}

// Only grounded criteria gate. Advisory ones are still carried on the contract
// and reported, so nothing is hidden — they simply cannot fail a request the
// user never made.
export function requiredCriteria(goalContract) {
  const all = goalContract?.criteria ?? [];
  const grounded = all.filter((criterion) => criterion.required !== false);
  // When nothing is grounded there is no stricter subset to check against, so
  // the full set stands. Returning an empty set here would make coverage
  // vacuously false and reject every plan.
  return grounded.length > 0 ? grounded : all;
}

export function assessGoalContractPlanCoverage(goalContract, taskGraph, capabilityRegistry = null) {
  const criteria = requiredCriteria(goalContract);
  const evidence = (taskGraph?.tasks ?? []).map((task) => taskEvidence(task, capabilityRegistry)).join(" ");
  const mutates = planHasMutation(taskGraph, capabilityRegistry);
  const results = criteria.map((criterion) => {
    if (criterion.kind === "PROHIBITION" || criterion.kind === "CONSTRAINT") {
      return {
        criterionId: criterion.criterionId,
        description: criterion.description,
        covered: !mutates,
        reason: mutates ? "candidate-plan-contains-mutation" : "candidate-plan-is-read-only"
      };
    }
    return {
      criterionId: criterion.criterionId,
      description: criterion.description,
      ...criterionMatch(criterion, evidence)
    };
  });
  const coveredCount = results.filter((result) => result.covered).length;
  return {
    covered: criteria.length > 0 && coveredCount === criteria.length,
    coveredCount,
    totalCriteria: criteria.length,
    criteria: results,
    missingCriteria: results.filter((result) => !result.covered).map((result) => result.description)
  };
}

export function assessGoalContractEvidence(goalContract, input = {}, capabilityRegistry = null) {
  // Completion stays strict: every criterion on the contract must be evidenced.
  // Groundedness only relaxes the pre-execution relevance check below.
  const criteria = goalContract?.criteria ?? [];
  const evidence = executionEvidence(input);
  const detectedChanges = (input.observations ?? []).flatMap((observation) => observation?.detectedChanges ?? []);
  const mutatingChanges = detectedChanges.filter((change) =>
    !["process", "window.foreground", "application.navigation"].includes(String(change))
  );
  const planMutates = planHasMutation(input.taskGraph, capabilityRegistry);
  const results = criteria.map((criterion) => {
    if (criterion.kind === "PROHIBITION" || criterion.kind === "CONSTRAINT") {
      const criterionTokens = criterionTerms(criterion);
      const broadMutationBan = criterionTokens.some((token) =>
        ["change", "modify", "edit", "alter", "mutation"].includes(token)
      );
      const forbiddenActions = criterionTokens.filter((token) =>
        ["add", "remove", "configure", "delete", "create", "write", "set", "toggle", "enable", "disable", "book", "purchase", "pay", "send", "submit", "install"].includes(token)
      );
      const scopeTokens = criterionTokens.filter((token) =>
        !["not", "change", "modify", "edit", "alter", "mutation", "any"].includes(token)
        && !forbiddenActions.includes(token)
      );
      const violatingTask = (input.taskGraph?.tasks ?? []).some((task) => {
        const capability = capabilityRegistry?.get?.(task?.capability);
        if (capability?.permissionModel?.type === "READ") return false;
        if (READ_ONLY_CAPABILITIES.test(String(task?.capability ?? ""))) return false;
        if (task?.capability === "ui.navigateSection") return false;
        const taskTokens = new Set(tokens(taskEvidence(task, capabilityRegistry)));
        const scopedTargetTokens = new Set(tokens(JSON.stringify({
          capability: task?.capability,
          action: task?.inputs?.action,
          target: task?.inputs?.target,
          selector: task?.inputs?.selector,
          text: task?.inputs?.text
        })));
        const broadViolation = broadMutationBan && (
          scopeTokens.length === 0 || scopeTokens.every((token) => scopedTargetTokens.has(token))
        );
        return broadViolation || forbiddenActions.some((token) => taskTokens.has(token));
      });
      const unscopedMutationEvidence = mutatingChanges.length > 0
        && broadMutationBan
        && criterionTokens.every((token) =>
          ["change", "modify", "edit", "alter", "mutation", "any"].includes(token)
        );
      const constraintText = normalize(criterion.description);
      const onlyShowResults = /\bonly show results\b/.test(constraintText);
      const desktopRequired = /\b(?:use )?(?:the )?desktop app\b/.test(constraintText);
      const confirmationRequired = /\bask before\b|\bconfirm before\b/.test(constraintText);
      const tasks = input.taskGraph?.tasks ?? [];
      const usesBrowser = tasks.some((task) => /^browser\./.test(String(task.capability ?? "")));
      const usesDesktop = tasks.some((task) => /^(?:application|window|ui|media)\./.test(String(task.capability ?? "")));
      const consequentialTask = tasks.some((task) => /(?:book|purchase|pay|send|submit|install)/i.test(`${task.capability} ${task.goal ?? ""} ${task.description ?? ""}`));
      const approvalSatisfied = !consequentialTask || input.approvalGranted === true;
      const satisfied = !violatingTask && !unscopedMutationEvidence
        && (!broadMutationBan || scopeTokens.length > 0 || !planMutates)
        && (!onlyShowResults || !planMutates)
        && (!desktopRequired || (usesDesktop && !usesBrowser))
        && (!confirmationRequired || approvalSatisfied);
      return {
        criterionId: criterion.criterionId,
        description: criterion.description,
        satisfied,
        evidence: satisfied
          ? "No action matching the prohibited mutation scope was recorded."
          : `Mutation evidence: ${mutatingChanges.join(", ") || "prohibited mutating capability executed"}`
      };
    }
    const match = criterionMatch(criterion, evidence);
    return {
      criterionId: criterion.criterionId,
      description: criterion.description,
      satisfied: match.covered,
      evidence: match.covered
        ? `Runtime evidence matched ${[...match.matchedAnchors, ...match.matchedTokens].slice(0, 8).join(", ")}.`
        : `Missing evidence for ${[...match.missingAnchors, ...criterionTerms(criterion).filter((token) => !match.matchedTokens.includes(token))].slice(0, 8).join(", ") || "criterion"}.`,
      ...match
    };
  });
  return {
    satisfied: criteria.length > 0 && results.every((result) => result.satisfied),
    satisfiedCount: results.filter((result) => result.satisfied).length,
    totalCriteria: criteria.length,
    criteria: results,
    unsatisfiedCriteria: results.filter((result) => !result.satisfied).map((result) => result.description)
  };
}
