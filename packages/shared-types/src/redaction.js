const REDACTED = "***REDACTED***";

// Names that mean "credential" and nothing else. A match here is redacted
// whatever the value looks like.
const UNAMBIGUOUS = /(secret|password|credential|apiKey|accessKey|privateKey|pairingCode|oneTimeCode|unlockCode|otp)/i;
// Names that mean a credential SOMETIMES. "token" is an auth token and it is
// also a unit of text; "value" is a form field's contents and it is also the
// generic name for anything at all.
const AMBIGUOUS = /(value|token)/i;

function shouldRedactKey(key, value) {
  if (/^key$/i.test(key)) {
    return false;
  }
  if (UNAMBIGUOUS.test(key)) return true;
  if (!AMBIGUOUS.test(key)) return false;
  // A COUNT IS NOT A CREDENTIAL.
  //
  // `/token/i` matched `tokensIn`, `tokensOut`, `tokensCached` and
  // `tokensFresh`, so every session ever persisted recorded its cost as
  // "***REDACTED***". Found 21 Aug 2026 while trying to read back why a drawing
  // request failed: the run's own token counts had been destroyed on the way to
  // disk, in a product whose headline claims are about cost per task. 1,673 of
  // 1,998 stored sessions carry the placeholder.
  //
  // The rule is the VALUE'S SHAPE, not a list of field names, because a list
  // would need extending for every new counter. A captured secret arrives as a
  // string — UIA reads a text box as text, a config file holds a key as text —
  // so sparing finite numbers under an ambiguous name gives up nothing a string
  // rule was catching. Unambiguous names above are still redacted at any type,
  // which is what keeps a numeric PIN under `password` covered.
  return typeof value !== "number" || !Number.isFinite(value);
}

// Public predicate: is this input field name secret-shaped? The approval
// commitment (PermissionBroker) uses the SAME rule the session store uses to
// redact, so the two never disagree about which fields are secrets — a field
// that gets redacted in persistence is exactly one the commitment binds via a
// keyed HMAC rather than a literal value.
export function isSensitiveKey(key, value) {
  return shouldRedactKey(String(key), value);
}

export function redactSensitiveData(input) {
  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveData(item));
  }

  if (!input || typeof input !== "object") {
    return input;
  }

  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (shouldRedactKey(key, value)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redactSensitiveData(value);
  }
  return output;
}

export { REDACTED };
