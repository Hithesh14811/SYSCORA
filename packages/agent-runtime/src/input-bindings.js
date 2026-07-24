const REFERENCE = /^\$(task|observation|entity)\.([^.]+)(?:\.(.+))?$/;

function readPath(value, path) {
  if (!path) return value;
  if (path === "output") return value;
  if (path.startsWith("output.")) path = path.slice("output.".length);
  return path.split(".").reduce((current, key) => {
    if (current == null || !Object.prototype.hasOwnProperty.call(Object(current), key)) return undefined;
    return current[key];
  }, value);
}

export function collectInputReferences(value, found = []) {
  if (typeof value === "string" && REFERENCE.test(value)) found.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectInputReferences(item, found));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectInputReferences(item, found));
  return found;
}

export function resolveTaskInputs(inputs, {
  taskResults = new Map(),
  observations = new Map(),
  semanticEntities = new Map()
} = {}) {
  const provenance = [];
  const resolve = (value) => {
    if (typeof value === "string") {
      const match = value.match(REFERENCE);
      if (!match) return value;
      const [, kind, id, path] = match;
      const source = kind === "task" ? taskResults.get(id)
        : kind === "observation" ? observations.get(id)
        : semanticEntities.get(id);
      if (source === undefined) throw new Error(`Unresolved runtime reference ${value}`);
      const resolved = readPath(source, path);
      if (resolved === undefined) throw new Error(`Runtime reference path does not exist: ${value}`);
      provenance.push({ reference: value, kind, id, path: path ?? null });
      return structuredClone(resolved);
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
    }
    return value;
  };
  return { inputs: resolve(inputs), provenance };
}
