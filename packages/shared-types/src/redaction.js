const REDACTED = "***REDACTED***";

function shouldRedactKey(key) {
  if (/^key$/i.test(key)) {
    return false;
  }
  return /(value|secret|token|password|credential|apiKey|accessKey|privateKey)/i.test(key);
}

// Public predicate: is this input field name secret-shaped? The approval
// commitment (PermissionBroker) uses the SAME rule the session store uses to
// redact, so the two never disagree about which fields are secrets — a field
// that gets redacted in persistence is exactly one the commitment binds via a
// keyed HMAC rather than a literal value.
export function isSensitiveKey(key) {
  return shouldRedactKey(String(key));
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
    if (shouldRedactKey(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redactSensitiveData(value);
  }
  return output;
}

export { REDACTED };
