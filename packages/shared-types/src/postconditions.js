export const PostconditionKind = Object.freeze({
  WINDOW_CLOSED: "WINDOW_CLOSED",
  WINDOW_OPEN: "WINDOW_OPEN",
  CONTROL_VISIBLE: "CONTROL_VISIBLE",
  CONTROL_STATE_EQUALS: "CONTROL_STATE_EQUALS",
  TEXT_EQUALS: "TEXT_EQUALS",
  TEXT_CONTAINS: "TEXT_CONTAINS",
  FILE_EXISTS: "FILE_EXISTS",
  FILE_CONTENT_EQUALS: "FILE_CONTENT_EQUALS",
  VALUE_TRANSFER_EQUALS: "VALUE_TRANSFER_EQUALS",
  PROCESS_RUNNING: "PROCESS_RUNNING",
  PROCESS_STOPPED: "PROCESS_STOPPED",
  NAVIGATION_REACHED: "NAVIGATION_REACHED",
  DOM_VALUE_EQUALS: "DOM_VALUE_EQUALS"
});

function values(value, found = []) {
  if (value == null) return found;
  if (typeof value !== "object") found.push(value);
  else if (Array.isArray(value)) value.forEach((item) => values(item, found));
  else Object.values(value).forEach((item) => values(item, found));
  return found;
}

function exact(actual, expected) {
  return values(actual).some((value) => value === expected);
}

function text(actual) {
  return values(actual).filter((value) => typeof value === "string").join(" ");
}

export function evaluatePostcondition(predicate, actual = {}) {
  if (!predicate?.kind) return { satisfied: false, reason: "postcondition-kind-missing" };
  const expected = predicate.expected ?? predicate.value;
  const observed = predicate.path
    ? String(predicate.path).split(".").filter(Boolean).reduce((current, key) => current?.[key], actual)
    : actual;
  let satisfied = false;
  switch (predicate.kind) {
    case PostconditionKind.TEXT_EQUALS:
    case PostconditionKind.FILE_CONTENT_EQUALS:
    case PostconditionKind.VALUE_TRANSFER_EQUALS:
    case PostconditionKind.DOM_VALUE_EQUALS:
    case PostconditionKind.CONTROL_STATE_EQUALS:
      satisfied = exact(observed, expected);
      break;
    case PostconditionKind.TEXT_CONTAINS:
    case PostconditionKind.CONTROL_VISIBLE:
    case PostconditionKind.NAVIGATION_REACHED:
    case PostconditionKind.WINDOW_OPEN:
    case PostconditionKind.PROCESS_RUNNING:
      satisfied = text(observed).toLowerCase().includes(String(expected ?? "").toLowerCase());
      break;
    case PostconditionKind.WINDOW_CLOSED:
    case PostconditionKind.PROCESS_STOPPED:
      satisfied = !text(observed).toLowerCase().includes(String(expected ?? "").toLowerCase());
      break;
    case PostconditionKind.FILE_EXISTS:
      satisfied = observed?.exists === true || observed?.found === true || Boolean(observed?.filePath ?? observed?.path);
      break;
    default:
      return { satisfied: false, reason: `unsupported-postcondition:${predicate.kind}` };
  }
  return { satisfied, kind: predicate.kind, expected, observed };
}
