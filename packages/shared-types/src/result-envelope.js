function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function readPath(value, path) {
  return String(path ?? "")
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => current?.[key], value);
}

function inferData(capability, output) {
  const target = output?.target ?? null;
  const content = firstDefined(output?.content, output?.contents);
  const value = firstDefined(
    output?.value,
    content,
    output?.text,
    output?.title,
    target?.value,
    target?.toggleState,
    target?.name
  );
  return {
    value,
    text: firstDefined(output?.text, content, typeof value === "string" ? value : undefined),
    title: output?.title,
    content,
    url: firstDefined(output?.url, output?.location),
    path: firstDefined(output?.filePath, output?.path),
    target,
    window: firstDefined(output?.window, output?.groundedWindow),
    controls: firstDefined(output?.controls, output?.relevantControls, output?.elements),
    capability
  };
}

export function createResultEnvelope({
  capability,
  executionResult,
  observation,
  verification,
  step,
  observedAt = new Date().toISOString()
} = {}) {
  const output = executionResult ?? {};
  const data = inferData(capability, output);
  return {
    type: "syscora.result",
    version: 1,
    capability: String(capability ?? "unknown"),
    ok: ["VERIFIED", "PARTIALLY_VERIFIED"].includes(verification?.status),
    data,
    raw: output,
    evidence: {
      status: verification?.status ?? "UNKNOWN",
      message: verification?.message ?? null,
      confidence: verification?.confidence ?? null,
      observation: observation ?? null
    },
    provenance: {
      capability: String(capability ?? "unknown"),
      step: Number.isInteger(step) ? step : null,
      observedAt,
      source: data.target?.source ?? (/^browser\./.test(capability ?? "") ? "DOM"
        : /^ui\./.test(capability ?? "") ? "UIA"
          : "INTERNAL")
    }
  };
}

export function extractResultValue(envelope, requestedPath) {
  if (!envelope) return undefined;
  const path = String(requestedPath ?? "").replace(/^output\./, "");
  const exact = readPath(envelope.raw, path);
  if (exact !== undefined) return exact;

  const leaf = path.split(".").filter(Boolean).at(-1);
  const aliases = {
    name: ["data.target.name", "data.value"],
    contents: ["data.content", "data.text", "data.value"],
    content: ["data.content", "data.text", "data.value"],
    text: ["data.text", "data.value"],
    value: ["data.value", "data.text", "data.content"],
    title: ["data.title", "data.value"],
    target: ["data.target"],
    path: ["data.path"],
    filePath: ["data.path"]
  };
  for (const candidate of aliases[leaf] ?? ["data.value"]) {
    const value = readPath(envelope, candidate);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}
