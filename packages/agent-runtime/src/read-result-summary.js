const OMITTED_RESULT_KEYS = new Set([
  "rawCommand",
  "commandResult",
  "stdout",
  "stderr"
]);

function scalarEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([key, item]) =>
      !OMITTED_RESULT_KEYS.has(key) &&
      ["string", "number", "boolean"].includes(typeof item)
    )
    .slice(0, 8);
}

function itemLabel(item) {
  if (typeof item === "string") return item;
  const name = item?.ProcessName ?? item?.DisplayName ?? item?.name ?? item?.title ?? item?.path;
  if (!name) return null;
  const version = item?.version ?? item?.DisplayVersion;
  return version ? `${name} ${version}` : String(name);
}

function summarizeValue(value) {
  if (value == null) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) {
    const labels = value.slice(0, 5).map(itemLabel).filter(Boolean);
    return `${value.length} item${value.length === 1 ? "" : "s"}${labels.length ? ` (first: ${labels.join(", ")})` : ""}`;
  }
  // A result whose substance is a LIST — installed applications, directory
  // entries, found files — reduced to its scalar fields only, so the answer to
  // "is Python installed?" came out as "count: 3, truncated: false, searched:
  // 209, nameContains: Python". Every number in that sentence is accurate and it
  // does not contain a single application name, which is the one thing that was
  // asked for. Lead with the contents.
  for (const key of ["applications", "entries", "files", "items", "processes", "services"]) {
    const list = value?.[key];
    if (!Array.isArray(list)) continue;
    if (list.length === 0) return `No ${key} matched.`;
    const labels = list.slice(0, 12).map(itemLabel).filter(Boolean);
    if (labels.length === 0) break;
    const more = list.length > labels.length ? `, and ${list.length - labels.length} more` : "";
    return `${list.length} ${key}: ${labels.join(", ")}${more}`;
  }
  const entries = scalarEntries(value);
  return entries.length
    ? entries.map(([key, item]) => `${key}: ${item}`).join(", ")
    : null;
}

function formatSystemSummary(result) {
  const details = result?.windowsDetails ?? {};
  const windowsName = details.caption ?? "Windows";
  const version = details.version ?? result?.release;
  const build = details.build;
  const cpuName = details.cpuName;
  const cores = details.cpuCores;
  const logical = details.cpuLogical ?? result?.cpus;
  const memoryBytes = Number(details.totalMemory ?? result?.totalMemory);
  const memory = Number.isFinite(memoryBytes)
    ? `${(memoryBytes / (1024 ** 3)).toFixed(1)} GiB`
    : null;
  const parts = [
    `Windows: ${[windowsName, version && `version ${version}`, build && `build ${build}`].filter(Boolean).join(", ")}`,
    cpuName
      ? `CPU: ${cpuName}${cores ? `, ${cores} cores` : ""}${logical ? `, ${logical} logical processors` : ""}`
      : null,
    memory ? `Installed memory: ${memory}` : null
  ].filter(Boolean);
  return parts.length >= 2 ? `${parts.join("; ")}.` : null;
}

// Render structured research findings as readable, sourced lines. Titles carry
// the substance on a search results page (prices, routes, providers), so they
// lead; the host follows so a claim can be traced to who made it. Nothing is
// inferred or merged here — these are the observed results, trimmed only for
// length.
function formatResearchSummary(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  if (items.length === 0) return null;
  const host = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
  };
  const lines = items.slice(0, 8).map((item) => {
    const title = String(item?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
    if (!title) return null;
    const source = host(item?.url);
    return `- ${title}${source ? ` (${source})` : ""}`;
  }).filter(Boolean);
  if (lines.length === 0) return null;
  const searched = result?.sourceUrl ? ` Searched: ${result.sourceUrl}` : "";
  return `Found ${items.length} result(s):\n${lines.join("\n")}\n\nThese are search results, not verified live prices — open a source to confirm before relying on it.${searched}`;
}

// A short, live preview of what one action returned, for the activity feed.
//
// Distinct from summarizeReadOnlyResults, which composes the FINAL answer from
// every read in a session and deliberately drops `stdout` — the right choice for
// a prose answer, and the wrong one here. Watching a command run and seeing only
// "Command completed successfully" is the difference between a terminal and a
// progress bar: the output IS the result, and it is what tells the user the
// agent looked at the right thing.
export function previewActionResult(capability, executionResult, { maxChars = 600 } = {}) {
  const result = executionResult ?? null;
  if (!result || typeof result !== "object") return null;

  // A refusal explains itself; nothing else about the result matters.
  if (result.blocked === true) return String(result.stderr ?? "Refused by the command rules.").slice(0, maxChars);

  if (typeof result.stdout === "string" || typeof result.stderr === "string") {
    const stdout = String(result.stdout ?? "").trim();
    const stderr = String(result.stderr ?? "").trim();
    const body = stdout || stderr;
    if (body) return body.slice(0, maxChars);
    if (Number.isFinite(result.exitCode)) return `exit code ${result.exitCode}`;
  }

  // Reading the screen returns a transcript; the first lines of it are what a
  // person would glance at.
  if (typeof result.visibleText === "string" && result.visibleText.trim()) {
    return result.visibleText.trim().replace(/\n{2,}/g, "\n").slice(0, maxChars);
  }

  const value = summarizeValue(result);
  return value ? String(value).slice(0, maxChars) : null;
}

export function summarizeReadOnlyResults(taskResults = [], capabilityRegistry = null) {
  if (taskResults.length === 0) return null;
  const allReadOnly = taskResults.every((result) =>
    capabilityRegistry?.get?.(result.capability)?.permissionModel?.type === "READ"
  );
  if (!allReadOnly) return null;

  const systemResult = taskResults.find((result) => result.capability === "system.inspect")?.executionResult;
  const systemSummary = formatSystemSummary(systemResult);
  if (systemSummary) return systemSummary;

  const calculatorResult = taskResults
    .filter((result) => result.capability === "calculator.evaluate")
    .map((result) => result.executionResult)
    .filter((result) => result?.matched === true && result?.expectedResult != null)
    .at(-1);
  if (calculatorResult) {
    return `${calculatorResult.expression} = ${calculatorResult.expectedResult}.`;
  }

  // Research exists to hand back what was FOUND. The generic scalar summary
  // below would reduce it to "found: true, sourceUrl: ..., pageTitle: ..." —
  // technically accurate and completely useless, since the results the user
  // asked for sit in `items` and never reach them. Report the findings, each
  // with its source, so the answer is checkable.
  // A retried research task leaves the earlier failed attempt in the list, so
  // take the last attempt that actually carries findings rather than the first
  // entry (which may be the attempt that errored and has no items).
  const researchSummary = taskResults
    .filter((result) => result.capability === "browser.research")
    .map((result) => formatResearchSummary(result.executionResult))
    .filter(Boolean)
    .at(-1);
  if (researchSummary) return researchSummary;

  const directoryResult = taskResults
    .filter((result) => result.capability === "filesystem.list")
    .map((result) => result.executionResult)
    .filter((result) => result?.exists !== false)
    .at(-1);
  if (directoryResult) {
    const files = Number(directoryResult.fileCount ?? 0);
    const directories = Number(directoryResult.directoryCount ?? 0);
    return `${directoryResult.root} contains ${files} file${files === 1 ? "" : "s"}` +
      ` and ${directories} director${directories === 1 ? "y" : "ies"}` +
      `${directoryResult.truncated ? " (the listing was truncated)" : ""}.`;
  }

  const summaries = taskResults
    .map((result) => {
      const value = summarizeValue(result.executionResult);
      return value ? `${result.capability}: ${value}` : null;
    })
    .filter(Boolean);
  return summaries.length ? summaries.join("; ") : null;
}
