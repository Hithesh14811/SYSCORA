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

function summarizeValue(value) {
  if (value == null) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) {
    const labels = value.slice(0, 5)
      .map((item) => item?.ProcessName ?? item?.DisplayName ?? item?.name ?? item?.title)
      .filter(Boolean);
    return `${value.length} item${value.length === 1 ? "" : "s"}${labels.length ? ` (first: ${labels.join(", ")})` : ""}`;
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

export function summarizeReadOnlyResults(taskResults = [], capabilityRegistry = null) {
  if (taskResults.length === 0) return null;
  const allReadOnly = taskResults.every((result) =>
    capabilityRegistry?.get?.(result.capability)?.permissionModel?.type === "READ"
  );
  if (!allReadOnly) return null;

  const systemResult = taskResults.find((result) => result.capability === "system.inspect")?.executionResult;
  const systemSummary = formatSystemSummary(systemResult);
  if (systemSummary) return systemSummary;

  const summaries = taskResults
    .map((result) => {
      const value = summarizeValue(result.executionResult);
      return value ? `${result.capability}: ${value}` : null;
    })
    .filter(Boolean);
  return summaries.length ? summaries.join("; ") : null;
}
