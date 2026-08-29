// Per-request access policy shared by the desktop, daemon and agent runtime.
//
// The old API exposed one `autoApprove` boolean. It could only mean "stop for
// every confirmation" or "approve every confirmation", and the desktop sent
// the latter unconditionally. Keep accepting it for older clients and tests,
// but make every current surface send an explicit mode.

export const ApprovalMode = Object.freeze({
  ASK: "ask",
  BALANCED: "balanced",
  FULL: "full"
});

export const ShellExecutionMode = Object.freeze({
  NONE: "none",
  WORKSPACE: "workspace",
  ISOLATED: "isolated",
  HOST: "host"
});

const APPROVAL_MODES = new Set(Object.values(ApprovalMode));
const SHELL_MODES = new Set(Object.values(ShellExecutionMode));

export function normalizeApprovalMode(value, { autoApprove, fallback = ApprovalMode.BALANCED } = {}) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (APPROVAL_MODES.has(mode)) return mode;
  // Backward compatibility is deliberately limited to requests that did not
  // send the new field. New clients cannot smuggle an unknown value through by
  // also setting autoApprove.
  if (value == null && typeof autoApprove === "boolean") {
    return autoApprove ? ApprovalMode.FULL : ApprovalMode.ASK;
  }
  return APPROVAL_MODES.has(fallback) ? fallback : ApprovalMode.BALANCED;
}

export function normalizeAccessPolicy(value = {}) {
  const developerMode = value.developerMode === true;
  let shellExecutionMode = String(value.shellExecutionMode ?? "").trim().toLowerCase();
  if (!developerMode) shellExecutionMode = ShellExecutionMode.NONE;
  else if (!SHELL_MODES.has(shellExecutionMode) || shellExecutionMode === ShellExecutionMode.NONE) {
    // A caller that enables arbitrary shell but omits the execution boundary
    // receives the disposable boundary, never an implicit host process.
    shellExecutionMode = ShellExecutionMode.ISOLATED;
  }

  const roots = Array.isArray(value.workspaceRoots) ? value.workspaceRoots : [];
  const workspaceRoots = [...new Set(roots
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean))].slice(0, 16);

  return Object.freeze({
    approvalMode: normalizeApprovalMode(value.approvalMode, {
      autoApprove: value.autoApprove,
      fallback: ApprovalMode.BALANCED
    }),
    developerMode,
    shellExecutionMode,
    workspaceRoots
  });
}

// Content-derived instructions stay human-gated in every mode. "Full access"
// is standing permission from the user; text on a web page or in an email is
// not the user and cannot inherit it.
export function canAutoApprove(request, policy) {
  const mode = normalizeApprovalMode(policy?.approvalMode, { fallback: ApprovalMode.BALANCED });
  if (String(request?.kind ?? "") === "injected-instruction") return false;
  return mode === ApprovalMode.FULL;
}
