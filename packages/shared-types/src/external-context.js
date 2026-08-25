import { redactSensitiveData } from "./redaction.js";

// WHAT THE AGENT READS OFF A WINDOW IS ALSO WHAT IT SENDS TO THE MODEL.
//
// Found live, 22 Aug 2026. The user moved a model API key between their devices
// through a WhatsApp chat, so it sat in the chat list PREVIEW — one of the 131
// elements in a `screen` reading of WhatsApp — and every run that looked at
// WhatsApp posted it to the model endpoint. The vendor-prefix list below caught
// none of it, because the key began `rn37EXgy.` and Baseten is not on the list.
// Nor would the next vendor be: that list is a race against an industry that
// invents a new prefix every month, and this project's own rule is that a guard
// enumerating spellings loses to the next spelling.
//
// So this matches the SHAPE instead — the one property every API key has and no
// English does: a long unbroken run of letters and digits carrying upper case
// AND lower case AND a digit at once.
//
// THE THRESHOLD IS SET BY WHAT MUST SURVIVE, NOT BY WHAT MUST BE CAUGHT.
// Over-redaction has cost this project far more than under-redaction: it typed
// `***REDACTED_EMAIL***` into a login form, typed `%USERPROFILE%` into
// PowerShell as a relative path and burned a whole task budget, and destroyed
// the cost metrics of 1,673 sessions with `/token/i`. So:
//
//   separators END a run  — `C:\Users\hithe\Documents\Project2024\src` is seven
//     short runs, not one long one, and file paths are the thing this must
//     never touch. Base64 secrets containing `/` are missed as a result. That
//     is the deliberate side of the trade: a missed secret is a risk, a
//     mangled path is a broken product.
//   all THREE character classes — a UUID and a git hash are single-case hex,
//     so neither can ever match however long it is.
//   28 characters — `ChatListItemGridViewItem2` is 25, and identifiers of that
//     shape are what UI Automation names its controls with.
//
// `_` AND `-` ARE SEPARATORS, AND LEAVING THEM INSIDE THE RUN COST A WHOLE
// REQUEST. The class used to be `[A-Za-z0-9_-]`, which contradicted the rule
// stated three paragraphs above and made every ordinary saved filename a
// candidate. Live, 23 Aug 2026: the agent wrote
// `J1_Internships_Software_Engineer.txt` to the Desktop, listed the folder to
// find it again, and the listing came back reading `***REDACTED***.txt` — 32
// characters, upper case and lower case and a digit, exactly the shape. It then
// called `read_file` on the placeholder, got ENOENT, and spent five steps
// working around its own redaction with PowerShell. The user saw an assistant
// that could not open the file it had just written.
//
// Nothing in the first table below loses by this: a vendor prefix like `hf_` or
// `sk-` is matched by the named rules above, and what follows one is an
// unbroken alphanumeric run regardless.
//
// Known limits, stated rather than discovered later: a 32-character
// single-case hex key (Azure) is indistinguishable from an MD5 by shape alone
// and is NOT caught; neither is a secret shorter than 28 characters that
// carries no known prefix, nor one whose only long run is broken up by
// underscores. tests/unit/secret-shapes.test.js pins both tables.
const SECRET_RUN = /[A-Za-z0-9]{28,}/g;
const looksLikeCredential = (run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run);

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

// AN EMAIL ADDRESS IS NOT A SECRET, IT IS THE SUBJECT OF THE WORK.
//
// This used to end with a blanket `…@….… → ***REDACTED_EMAIL***`, applied to
// every message on the way to the model — including the user's own words. Live,
// that broke two different tasks and neither failure looked like redaction:
//
//   "log in with hitheshs096@gmail.com" reached the model as "log in with
//   ***REDACTED_EMAIL***", so it typed that literal placeholder into the form,
//   the site rejected it, and the user had to spell the address out as
//   "hitheshs096 at the rate g mail . com" to get past our own filter.
//
//   Asked to check it was on the right Gmail account and switch if not, the
//   model saw "Google Account: Prathibha Shetty (***REDACTED_EMAIL***)" and a
//   switcher listing four accounts, ALL of them ***REDACTED_EMAIL***. The
//   comparison it had been asked to make was erased from its input. It guessed
//   from the display name — the only thing left — and was blamed for ignoring
//   the instruction.
//
// Credentials still go, because a leaked key is unrecoverable and the agent
// never needs to read one back. An address is the opposite: it is routinely the
// whole point of the request, it is already on the user's own screen, and
// without it the agent cannot tell two accounts apart.
//
// A HOME DIRECTORY IS NOT A SECRET EITHER, AND HIDING IT BREAKS EVERY PATH.
//
// This also used to rewrite `C:\Users\<name>` to the literal text
// `%USERPROFILE%`. The model never saw a real path — it saw the placeholder,
// and then, reasonably, typed the placeholder back into the next command.
// PowerShell does not expand `%VAR%`, so the string was taken as a RELATIVE
// path and resolved against the working directory:
//
//   Get-ChildItem : Cannot find path 'C:\Users\hithe\OneDrive\Documents\SYSCORA\
//   %USERPROFILE%\OneDrive\Documents\check\beautify-ecommerce\node_modules'
//
// Asked to find a folder and improve the app inside it, the agent found the
// folder, was handed a path it could not use, and spent its whole budget
// re-locating it — searching C:\Users, listing node_modules recursively at
// thirteen seconds a go, and finally giving up without editing a single file.
// It even reasoned aloud that "the tool masks the real username", which is
// exactly right and exactly the problem.
//
// The username is in every window title, every Explorer breadcrumb and every
// screenshot the agent already receives; concealing it in paths alone bought no
// privacy and cost the filesystem.
function scrub(item, parentKey = "") {
  if (Array.isArray(item)) return item.map((child) => scrub(child, parentKey));
  if (!item || typeof item !== "object") {
    if (typeof item !== "string") return item;
    if (/clipboard/i.test(parentKey)) return "***REDACTED***";
    if (/title/i.test(parentKey) && (/[\\/]/.test(item) || /\b\S+\.(?:txt|docx?|xlsx?|pdf|key|pem|env)\b/i.test(item))) {
      return "[PRIVATE_WINDOW_TITLE]";
    }
    return item
      .replace(/\b(?:sk|gsk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, "***REDACTED***")
      .replace(/\bAKIA[A-Z0-9]{12,}\b/g, "***REDACTED***")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer ***REDACTED***")
      .replace(/\b(api[_ -]?key|password|access[_ -]?token|auth[_ -]?token)\s*[:=]\s*[^\s,;]+/gi, "$1=***REDACTED***")
      // Last, so a key the named rules above already recognised keeps their
      // more specific replacement rather than being flattened by this one.
      .replace(SECRET_RUN, (run) => (looksLikeCredential(run) ? "***REDACTED***" : run));
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
