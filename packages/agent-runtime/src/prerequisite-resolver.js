// PrerequisiteResolver
//
// Turns "open X" into "inspect → obtain consent → satisfy prerequisite → resume"
// without ever guessing. Four rules shape it:
//
//   1. Absence is proven, never inferred. Only a package/executable resolution
//      says an application is missing. A window that failed to ground says
//      nothing about whether the application is installed.
//   2. An installed application never reaches an installer.
//   3. Approval binds to an exact package identity AND source. An approval for
//      one package cannot authorize another, and the installer only ever runs
//      against the identity the user actually saw.
//   4. The original goal is carried through every branch, so an interruption —
//      approval, failure, or clarification — never discards the task the user
//      asked for.

export const PrerequisiteState = Object.freeze({
  AVAILABLE: "AVAILABLE",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  CLARIFICATION_REQUIRED: "CLARIFICATION_REQUIRED",
  UNAVAILABLE: "UNAVAILABLE"
});

// Package feeds whose contents carry a publisher identity the runtime can show
// the user. A browser download is deliberately absent: obtaining an installer is
// not permission to run it.
const TRUSTED_SOURCES = new Set(["winget", "msstore"]);

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function nameStem(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, "");
}

export class PrerequisiteResolver {
  constructor({ environmentModel, adapter, trustedSources = TRUSTED_SOURCES } = {}) {
    this.environmentModel = environmentModel;
    this.adapter = adapter;
    this.trustedSources = new Set([...trustedSources].map(normalize));
  }

  // Inspect first, always. The installer is only ever reached from a proven
  // absence plus an exact, user-visible package proposal.
  async ensureApplicationAvailable(application, { originalTask = null } = {}) {
    const environment = await this.environmentModel.resolveApplication(application);
    const base = { application, environment, resumeTask: originalTask };

    if (environment.installed) {
      return { ...base, state: PrerequisiteState.AVAILABLE, installedIdentity: environment.installedIdentity };
    }

    const candidates = await this._findTrustedPackages(application);
    if (candidates.length === 0) {
      return { ...base, state: PrerequisiteState.UNAVAILABLE, reason: "NO_TRUSTED_PACKAGE_SOURCE" };
    }
    if (candidates.length > 1) {
      return {
        ...base,
        state: PrerequisiteState.CLARIFICATION_REQUIRED,
        reason: "AMBIGUOUS_PACKAGE_MATCH",
        candidates
      };
    }

    // One bounded lookup so the approval prompt names the real publisher rather
    // than asking the user to trust an unattributed package.
    const [candidate] = candidates;
    if (!candidate.publisher && typeof this.adapter?.describePackage === "function") {
      try {
        const described = await this.adapter.describePackage(candidate.id, candidate.source);
        candidate.publisher = described?.publisher ?? candidate.publisher;
        candidate.version = candidate.version ?? described?.version;
      } catch { /* the proposal still names the exact package id and source */ }
    }
    return {
      ...base,
      state: PrerequisiteState.APPROVAL_REQUIRED,
      proposal: {
        packageId: candidate.id,
        name: candidate.name ?? candidate.id,
        publisher: candidate.publisher ?? "unknown publisher",
        version: candidate.version ?? "unspecified",
        source: candidate.source,
        // Package installs write outside the session; say so up front.
        requiredPrivileges: candidate.requiredPrivileges ?? "Standard user; the package manager may request elevation.",
        changes: [`Installs ${candidate.name ?? candidate.id} from ${candidate.source}`]
      }
    };
  }

  // Install the package the user approved. The approval must name the same
  // identity and source that were proposed; anything else is refused outright.
  async installApproved(proposed, approval = {}) {
    const proposal = proposed?.proposal;
    const base = { application: proposed?.application ?? null, resumeTask: proposed?.resumeTask ?? null };
    if (!proposal) {
      return { ...base, state: PrerequisiteState.UNAVAILABLE, reason: "NO_APPROVED_PROPOSAL" };
    }
    if (normalize(approval.packageId) !== normalize(proposal.packageId)
      || normalize(approval.source) !== normalize(proposal.source)) {
      return { ...base, state: PrerequisiteState.UNAVAILABLE, reason: "APPROVAL_IDENTITY_MISMATCH", proposal };
    }
    if (!this.trustedSources.has(normalize(proposal.source))) {
      return { ...base, state: PrerequisiteState.UNAVAILABLE, reason: "NO_TRUSTED_PACKAGE_SOURCE", proposal };
    }

    // Re-check immediately before installing: the application may have appeared
    // while the approval was pending.
    const before = await this.environmentModel.resolveApplication(base.application);
    if (before.installed) {
      return { ...base, state: PrerequisiteState.AVAILABLE, environment: before, verifiedIndependently: true, alreadyPresent: true };
    }

    let installResult;
    try {
      installResult = await this.adapter.installPackage(proposal.packageId, proposal.source);
    } catch (error) {
      return { ...base, state: PrerequisiteState.UNAVAILABLE, reason: "INSTALL_FAILED", proposal, error: error.message };
    }

    // The installer's own exit code is a claim, not proof. Re-resolve the
    // application to confirm it is genuinely present now.
    const after = await this.environmentModel.resolveApplication(base.application);
    if (!after.installed) {
      return {
        ...base,
        state: PrerequisiteState.UNAVAILABLE,
        reason: installResult?.exitCode === 0 ? "INSTALL_NOT_VERIFIED" : "INSTALL_FAILED",
        proposal,
        installResult,
        environment: after
      };
    }
    return {
      ...base,
      state: PrerequisiteState.AVAILABLE,
      proposal,
      installResult,
      environment: after,
      installedIdentity: after.installedIdentity,
      verifiedIndependently: true
    };
  }

  async _findTrustedPackages(application) {
    if (typeof this.adapter?.searchPackages !== "function") return [];
    let results;
    try {
      results = await this.adapter.searchPackages(application);
    } catch {
      return [];
    }
    const trusted = (results ?? []).filter((entry) => entry?.id && this.trustedSources.has(normalize(entry.source)));
    // Prefer an exact name match when the feed returns near-matches; only fall
    // back to the full candidate list, which the caller surfaces for
    // clarification rather than resolving on its own.
    const stem = nameStem(application);
    const exact = trusted.filter((entry) => nameStem(entry.name) === stem || nameStem(entry.id) === stem);
    return exact.length === 1 ? exact : trusted;
  }
}
