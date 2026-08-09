import crypto from "node:crypto";

const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "both", "by", "do", "for", "from",
  "give", "in", "inside", "is", "it", "its", "me", "named", "of", "on", "or", "quick", "so",
  "tell", "the", "then", "this", "to", "what", "whats", "with"
]);

// Looking is not changing. screen.read belongs here for the same reason
// ui.inspect does: it captures and transcribes a window and mutates nothing, and
// leaving it out would mean a purely informational goal ("what does that dialog
// say?") could not use the one capability that answers it.
const READ_ONLY_CAPABILITIES = /^(?:system\.inspect|process\.list|filesystem\.read|filesystem\.inspect|application\.launch|window\.(?:enumerate|resolve|wait)|ui\.(?:inspect|find|extract|resolveTarget)|screen\.(?:capture|read)|ocr\.read|vision\.locate|browser\.(?:launch|navigate|currentState|inspect|find|read|extract|wait))$/;

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

// Actions a prohibition can forbid. A negation word only expresses a constraint
// when it governs one of these — "never" in "Never Gonna Give You Up" is part of
// a song title, not an instruction, and treating it as one turned a legitimate
// playback request into a read-only constraint the plan could never satisfy.
const PROHIBITED_ACTION_VERBS = "book|buy|purchase|order|reserve|rent|pay|send|submit|share|post|publish|install|uninstall|delete|remove|destroy|drop|modify|change|edit|alter|overwrite|rename|move|create|write|save|add|set|configure|enable|disable|toggle|update|upgrade|restart|reboot|shut\\s*down|kill|stop|open|launch|run|execute|click|navigate|download|upload|touch";

// A negation followed, within a couple of words, by an action it forbids.
const PROHIBITION_PATTERN = new RegExp(
  `\\b(?:do not|do n't|don't|must not|mustn't|should not|shouldn't|never|no)\\s+(?:\\w+\\s+){0,2}(?:${PROHIBITED_ACTION_VERBS})\\b`,
  "i"
);
// Phrasings that carry the constraint without a following verb.
const PROHIBITION_PHRASE_PATTERN = /\b(?:without (?:changing|modifying|editing|installing|saving|booking|purchasing)|no changes?|read[- ]only)\b/i;

function isProhibition(value) {
  const text = String(value ?? "");
  return PROHIBITION_PATTERN.test(text) || PROHIBITION_PHRASE_PATTERN.test(text);
}

function isStandaloneProhibition(value) {
  const text = String(value ?? "").trimStart();
  const startsWithNegation = /^(?:do not|do n't|don't|must not|mustn't|should not|shouldn't|never|no changes?|without (?:changing|modifying|editing|installing|saving|booking|purchasing))\b/i.test(text);
  return startsWithNegation && isProhibition(text);
}

// A CONSTRAINT is something the run must be RESTRICTED by. Everywhere it is
// consumed it is judged as a restriction: coverage marks it satisfied only when
// the candidate plan does not mutate, and the evidence check looks for a task
// whose verbs it forbids.
//
// A bare "must" does not mean that. Asked to set the volume to 26%, the model
// wrote the constraint "Volume must be set to exactly 26%" — a REQUIREMENT to
// act. Classified as a constraint it inverted: the only plan that could satisfy
// the user (one that sets the volume) was the one guaranteed to violate it, so
// coverage failed, the typed one-step route was discarded, and the request fell
// through to the adaptive loop, which had no volume tool in reach and clicked
// blindly on whatever window happened to be in front — twenty-four times.
//
// So "must" only marks a constraint when it governs a restriction: must not,
// must only, must ask/confirm first. "must be set to X" is an outcome, and
// outcomes are already carried as STATE criteria.
function isBehavioralConstraint(value) {
  const text = String(value ?? "");
  if (/\b(?:only|ask before|confirm before|desktop app)\b/i.test(text)) return true;
  if (/\bwithout\s+\w+ing\b/i.test(text)) return true;
  return /\bmust\s+(?:not|never|only|ask|confirm)\b/i.test(text);
}

// Words that describe HOW an answer is delivered to the person, rather than any
// state of the machine. No observation will ever contain them: nothing the
// runtime reads back from Windows says "presented", "ranked" or "to the user",
// because those describe SYSCORA's own reply, which is composed after the work
// finishes.
//
// Left in the token set they were pure noise that could only ever fail. A
// criterion like "the processes using the most memory are identified and
// presented in descending order" tokenises to eight terms of which five are
// presentational, so it could not clear the matching threshold no matter what
// the machine returned — and it was the SECOND criterion on nearly every
// question, because that is simply how a model writes down "and tell me".
const PRESENTATION_TOKENS = new Set([
  "identified", "identify", "presented", "present", "reported", "report",
  "displayed", "display", "shown", "show", "returned", "return", "listed",
  "told", "informed", "summarized", "summarised", "summary", "described",
  "ranked", "ranking", "ordered", "order", "descending", "ascending",
  "sorted", "clearly", "user", "response", "answer", "output", "message"
]);

// Vocabulary that asserts something about the MACHINE — either a change made to
// it or a condition holding on it. If a criterion says any of this, there is a
// real fact to go and observe, and the evidence gate must hold.
const MACHINE_STATE_PATTERN =
  /\b(?:creat|delet|remov|writ|wrote|sav|instal|uninstal|modif|chang|edit|updat|renam|mov|copi|copy|set|configur|enabl|disabl|toggl|launch|open|clos|start|stopp?|kill|restart|maximiz|minimiz|resiz|focus|navigat|click|typ|play|paus|download|upload|send|submit|book|purchas)\w*\b|\b(?:exists?|running|installed|present on|visible|in the foreground|now playing)\b/i;

// Vocabulary about DELIVERING an answer: what SYSCORA says back, and in what
// shape. Nothing the machine reports will ever contain it.
const DELIVERY_PATTERN =
  // Each verb takes \w* so its inflections match. Without it `\breport\b` failed
  // on "reported" — which is the form these criteria are always written in — and
  // the criterion silently stayed STATE, which is the failure this whole
  // distinction exists to prevent.
  /\b(?:report\w*|present\w*|display\w*|shown|shows|list\w*|return\w*|tell\w*|told|inform\w*|summariz\w*|summaris\w*|identif\w*|rank\w*|sort\w*|order\w*|descending|ascending|highest first|lowest first|to the user|in the (?:answer|response|reply))\b/i;

// A criterion about the answer rather than about the machine.
//
// "The processes are ranked by memory usage with the highest consumers shown
// first" is a promise about how SYSCORA writes its reply. There is no place in
// Windows to go and check it, and the reply does not exist yet when the gate
// runs — so gating on machine evidence for it can only ever fail. It failed on
// essentially every question a person asks, because "and tell me the answer" is
// how models habitually write the second success criterion.
//
// "A folder named Reports exists on the Desktop and is shown to the user" also
// mentions delivery, but it asserts a fact about the disk as well. That one
// stays STATE and stays gated — which is the whole point of the evidence gate,
// and is untouched here.
// What is being REPORTED is not what is being ASSERTED.
//
// "The user is told clearly whether Git is installed" is a promise to answer a
// question. The word "installed" in it names the subject of the answer; it does
// not claim anything was installed. Testing the raw sentence for machine-state
// vocabulary therefore misfires on almost every reporting criterion, because a
// reporting criterion nearly always names the thing it reports on — and it
// misfired here, so a correct, well-evidenced answer about Git was labelled
// INCONCLUSIVE.
//
// Removing the subordinate clause leaves the main assertion, which is what the
// criterion actually commits to:
//   "...told clearly whether Git is installed"  -> "...told clearly"     REPORT
//   "A folder is created and shown to the user" -> unchanged             STATE
function mainAssertion(description) {
  return String(description ?? "")
    // A leading condition — "If installed, the version is reported" — qualifies
    // the promise, it is not the promise.
    .replace(/^\s*(?:if|when|where)\b[^,]{0,60},\s*/i, "")
    // Reported content: everything from the clause marker onward.
    .replace(/\b(?:whether|that|what|which|why|how (?:much|many|large|big)?|if)\b[\s\S]*$/i, "")
    .trim();
}

function isReportCriterion(description) {
  const text = String(description ?? "");
  if (!DELIVERY_PATTERN.test(text)) return false;
  const assertion = mainAssertion(text);
  // Stripping left nothing to judge, so fall back to the whole sentence rather
  // than treating an empty string as "no machine state".
  return !MACHINE_STATE_PATTERN.test(assertion || text);
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
  // Only lift a clause when the negation actually governs an action (see
  // isProhibition). Matching a bare "never" turned the title in "play Never
  // Gonna Give You Up" into a binding constraint on the whole request.
  for (const match of text.matchAll(/\b(?:do not|don't|never|must not)\s+[^.;]+/gi)) {
    if (isProhibition(match[0])) clauses.push(match[0].trim());
  }
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
  // Only genuinely RESTRICTIVE entries become constraint criteria.
  //
  // `declaredConstraints` also keeps entries that merely overlap the request
  // wording, which is how a restatement of the goal — "Volume must be set to
  // exactly 45 percent" — was admitted as a constraint. Every consumer then
  // judged it as a restriction and marked it violated by the one plan that
  // actually does what the user asked. The overlap rule is still useful for
  // keeping real user constraints that match no pattern, so those entries are
  // kept as ordinary criteria (below) and simply not treated as prohibitions.
  const restrictiveConstraints = declaredConstraints.filter(
    (constraint) => isProhibition(constraint) || isBehavioralConstraint(constraint)
  );
  const advisoryConstraints = declaredConstraints.filter(
    (constraint) => !restrictiveConstraints.includes(constraint)
  );
  const constraintCriteria = [
    ...restrictiveConstraints,
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
    ...constraintCriteria,
    // Non-restrictive entries from the model's constraints list. Recorded so
    // nothing the model said is lost, but classified below like any other
    // criterion rather than as a restriction.
    ...advisoryConstraints
  ])];
  const constraintSet = new Set(constraintCriteria.map(normalize));
  const rawClauseSet = new Set(rawClauses.map(normalize));
  const criteria = descriptions.map((description, index) => {
    const kind = isProhibition(description)
      ? "PROHIBITION"
      : constraintSet.has(normalize(description)) ? "CONSTRAINT"
        : isReportCriterion(description) ? "REPORT" : "STATE";
    // An anchor is a literal string the plan MUST contain, so it only counts
    // when the user actually wrote it. Criteria are often authored by the
    // model, and its prose routinely carries all-caps acronyms ("the name or
    // PID of the process", "the CPU and RAM totals", "the PDF path") that
    // literalAnchors cannot tell apart from a user-specified identifier.
    // Treating those as mandatory rejects correct typed plans — a real
    // process.port.inspect plan was thrown out for not containing the literal
    // text "PID" — so anchors are kept only when they appear in the original
    // request. Model-invented ones degrade to ordinary tokens, which still
    // contribute to matching but cannot single-handedly fail a plan.
    const normalizedRequest = normalize(originalRequest);
    const anchors = literalAnchors(description).filter((anchor) => normalizedRequest.includes(anchor));
    // A criterion gates completion only when it is grounded in what the user
    // actually said: a prohibition or constraint they stated, a clause of their
    // own request, or a criterion carrying a literal anchor from it. An
    // interpreting model may add plausible extras ("...and the version if
    // available") that the user never asked for; recording those is useful, but
    // letting them gate would both fail correct work and make the same request
    // succeed or fail depending on how the model phrased itself that run.
    // A criterion gates only when it is grounded in what the user actually said.
    //
    // The original test — a literal anchor, or a verbatim clause of the request —
    // was far too strict for an ordinary multi-clause sentence. "Open calculator
    // and work out 47 times 89" produced the criterion "The expression 47 × 89
    // has been entered into Calculator", which carries no ALL-CAPS anchor and is
    // not a verbatim clause, so it was discarded as a model invention. Both
    // substantive criteria were dropped, the only survivor was a REPORT
    // criterion any plan satisfies, and a plan that merely LAUNCHED Calculator
    // scored full goal coverage. The arithmetic half of the request evaporated
    // and the request was reported as done.
    //
    // Sharing two or more distinctive terms with the request is real grounding:
    // "47", "89" and "calculator" all came from the user. One shared term is
    // not — "the volume is not muted" shares only "volume" with "set the volume
    // to 45 percent", and that is exactly the invention that must not gate.
    const substantiveTerms = tokens(description).filter((token) => !PRESENTATION_TOKENS.has(token));
    const sharedWithRequest = substantiveTerms.filter((token) => originalTokens.has(token));
    const grounded = kind !== "STATE"
      || anchors.length > 0
      || rawClauseSet.has(normalize(description))
      || sharedWithRequest.length >= 2;
    return {
      criterionId: `criterion_${index + 1}`,
      description,
      required: grounded,
      kind,
      anchors,
      // Match on substance only. A criterion is usually a mix — "the processes
      // consuming the most memory are identified and reported in descending
      // order" is half machine state and half delivery — and scoring the
      // delivery half against machine output means a correct answer scores
      // below threshold on words that could not possibly appear in it.
      semanticTerms: tokens(description).filter((token) => !PRESENTATION_TOKENS.has(token))
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

function taskEvidence(task, capabilityRegistry, executionResult = null) {
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
    capability?.description,
    // What the task PRODUCED, not only what it was asked to do. Criteria for a
    // read describe the answer ("the total count of files in the Downloads
    // folder is returned"), and that wording overlaps the output far more than
    // the command line that produced it. Judging only the inputs meant a task
    // that returned exactly the right number scored below the coverage
    // threshold, the criterion was left unsatisfied, and a correct answer was
    // reported to the user as inconclusive and thrown away.
    executionResult ? evidenceObject(executionResult) : null
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

export function matchGoalCriteriaForTask(goalContract, task, capabilityRegistry = null, executionResult = null) {
  const evidence = taskEvidence(task, capabilityRegistry, executionResult);
  const declaredIds = new Set(task?.goalCriterionIds ?? task?.criterionIds ?? []);
  return (goalContract?.criteria ?? [])
    .filter((criterion) => {
      // A REPORT criterion is carried by whichever task produced the data the
      // answer will be built from. It has to be attached to a task like any
      // other criterion, because the evidence ledger only recognises criteria
      // that some task claimed — leaving them unclaimed made every session
      // carrying one finish INCONCLUSIVE despite having done the work.
      if (criterion.kind === "REPORT") return executionResult != null;
      return criterion.kind === "STATE" && criterionMatch(criterion, evidence).covered;
    })
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
    if (criterion.kind === "REPORT") {
      // A plan cannot show its answer in advance. Any plan that gathers
      // something can be reported on; whether it gathered the RIGHT thing is
      // what the STATE criteria alongside this one are for.
      const gathers = (taskGraph?.tasks ?? []).length > 0;
      return {
        criterionId: criterion.criterionId,
        description: criterion.description,
        covered: gathers,
        reason: gathers ? "plan-produces-results-to-report" : "plan-has-no-tasks"
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
    if (criterion.kind === "REPORT") {
      // This criterion is about SYSCORA answering, and the answer is composed
      // from the evidence below after this assessment runs — so demanding
      // machine evidence for it asks the run to prove something that has not
      // happened yet and never will happen on the machine. It is satisfied when
      // the work that the answer will be built from actually ran and was
      // verified. Nothing is weakened: if no read succeeded there is nothing to
      // report and this correctly stays unsatisfied.
      const verifiedWork = (input.verifications ?? []).some((verification) => verification?.status === "VERIFIED")
        || (input.taskResults ?? []).some((result) => result?.executionResult != null);
      return {
        criterionId: criterion.criterionId,
        description: criterion.description,
        satisfied: verifiedWork && evidence.length > 0,
        evidence: verifiedWork
          ? "Verified observations are available for the answer."
          : "No verified observation was produced, so there is nothing to report."
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
