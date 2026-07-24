import { redactSensitiveData } from "./redaction.js";

function clipped(value, depth = 0, maxStringLength = 1200) {
  if (depth > 5) return "[DEPTH_LIMIT]";
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => clipped(item, depth + 1, maxStringLength));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}…`
      : value;
  }
  return Object.fromEntries(
    Object.entries(value).slice(0, 80)
      .map(([key, item]) => [key, clipped(item, depth + 1, maxStringLength)])
  );
}

function scrub(item, parentKey = "") {
  if (Array.isArray(item)) return item.map((child) => scrub(child, parentKey));
  if (!item || typeof item !== "object") {
    if (typeof item !== "string") return item;
    if (/clipboard/i.test(parentKey)) return "***REDACTED***";
    if (/title/i.test(parentKey) && (/[\\/]/.test(item) || /\b\S+\.(?:txt|docx?|xlsx?|pdf|key|pem|env)\b/i.test(item))) {
      return "[PRIVATE_WINDOW_TITLE]";
    }
    return item
      .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+/gi, "%USERPROFILE%")
      .replace(/\b(?:sk|gsk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, "***REDACTED***")
      .replace(/\bAKIA[A-Z0-9]{12,}\b/g, "***REDACTED***")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer ***REDACTED***")
      .replace(/\b(api[_ -]?key|password|access[_ -]?token|auth[_ -]?token)\s*[:=]\s*[^\s,;]+/gi, "$1=***REDACTED***")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "***REDACTED_EMAIL***");
  }
  return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, scrub(child, key)]));
}

export const ExternalAIConsentScope = Object.freeze({
  DISABLED: "EXTERNAL_AI_DISABLED",
  SANITIZED_REASONING: "EXTERNAL_AI_SANITIZED_REASONING",
  STRUCTURED_UI_CONTEXT: "EXTERNAL_AI_STRUCTURED_UI_CONTEXT",
  SCREENSHOT_OR_VISION: "EXTERNAL_AI_SCREENSHOT_OR_VISION"
});

export const ExternalAIDataCategory = Object.freeze({
  SANITIZED_TASK_TEXT: "SANITIZED_TASK_TEXT",
  STRUCTURED_SEMANTIC_CONTEXT: "STRUCTURED_SEMANTIC_CONTEXT",
  CAPABILITY_METADATA: "CAPABILITY_METADATA",
  STRUCTURED_UIA_METADATA: "STRUCTURED_UIA_METADATA",
  SANITIZED_BROWSER_DOM: "SANITIZED_BROWSER_DOM",
  ACTION_VERIFICATION_STATE: "ACTION_VERIFICATION_STATE",
  SCREENSHOT_OR_VISION: "SCREENSHOT_OR_VISION"
});

const REQUIRED_SCOPE = Object.freeze({
  [ExternalAIDataCategory.SANITIZED_TASK_TEXT]: ExternalAIConsentScope.SANITIZED_REASONING,
  [ExternalAIDataCategory.STRUCTURED_SEMANTIC_CONTEXT]: ExternalAIConsentScope.SANITIZED_REASONING,
  [ExternalAIDataCategory.CAPABILITY_METADATA]: ExternalAIConsentScope.SANITIZED_REASONING,
  [ExternalAIDataCategory.ACTION_VERIFICATION_STATE]: ExternalAIConsentScope.SANITIZED_REASONING,
  [ExternalAIDataCategory.STRUCTURED_UIA_METADATA]: ExternalAIConsentScope.STRUCTURED_UI_CONTEXT,
  [ExternalAIDataCategory.SANITIZED_BROWSER_DOM]: ExternalAIConsentScope.STRUCTURED_UI_CONTEXT,
  [ExternalAIDataCategory.SCREENSHOT_OR_VISION]: ExternalAIConsentScope.SCREENSHOT_OR_VISION
});

export function authorizeExternalAITransfer({ scopes = [], dataCategories = [] } = {}) {
  const active = new Set(Array.isArray(scopes) ? scopes : []);
  const categories = [...new Set(dataCategories)];
  if (active.has(ExternalAIConsentScope.DISABLED)) {
    return { allowed: false, scopes: [...active], dataCategories: categories, missingScopes: ["external-ai-disabled"] };
  }
  const missingScopes = [...new Set(
    categories.map((category) => REQUIRED_SCOPE[category]).filter((scope) => scope && !active.has(scope))
  )];
  return {
    allowed: missingScopes.length === 0,
    scopes: [...active],
    dataCategories: categories,
    missingScopes
  };
}

export function sanitizeExternalContext(value, { maxStringLength = 1200 } = {}) {
  return scrub(redactSensitiveData(clipped(value, 0, maxStringLength)));
}

export function classifyExternalContext(value) {
  const data = sanitizeExternalContext(value);
  return {
    classification: "SANITIZED_MACHINE_CONTEXT",
    safeForExternalReasoning: true,
    transformed: JSON.stringify(data) !== JSON.stringify(value),
    data
  };
}
