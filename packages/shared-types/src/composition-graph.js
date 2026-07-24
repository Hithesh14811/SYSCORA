const BINDING_REFERENCE = /^\$binding\.([A-Za-z][A-Za-z0-9_-]*)$/;

function collectBindingReferences(value, found = new Set()) {
  if (typeof value === "string") {
    const match = value.match(BINDING_REFERENCE);
    if (match) found.add(match[1]);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectBindingReferences(item, found));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectBindingReferences(item, found));
  }
  return [...found];
}

export function createCompositionGraph(actions = [], { id = "composition" } = {}) {
  const nodes = actions.map((action, index) => {
    const nodeId = action.nodeId ?? `${id}:${index + 1}`;
    return {
      ...action,
      nodeId,
      dependsOn: action.dependsOn ?? (index ? [actions[index - 1].nodeId ?? `${id}:${index}`] : []),
      requiresBindings: action.requiresBindings ?? collectBindingReferences(action.inputs),
      producesBindings: action.bindOutput
        ? [typeof action.bindOutput === "string" ? action.bindOutput : action.bindOutput.name].filter(Boolean)
        : []
    };
  });
  return { graphId: id, nodes };
}

export function validateCompositionGraph(graph, { capabilityExists = () => true } = {}) {
  const errors = [];
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  if (!nodes.length) errors.push("composition graph requires at least one node");
  const byId = new Map();
  for (const node of nodes) {
    if (!node?.nodeId) errors.push("every composition node requires nodeId");
    else if (byId.has(node.nodeId)) errors.push(`duplicate composition node: ${node.nodeId}`);
    else byId.set(node.nodeId, node);
    if (!node?.capability || !capabilityExists(node.capability)) {
      errors.push(`unknown capability in composition graph: ${node?.capability ?? "missing"}`);
    }
  }
  const availableBindings = new Set();
  const completed = new Set();
  const remaining = [...nodes];
  while (remaining.length) {
    const index = remaining.findIndex((node) =>
      (node.dependsOn ?? []).every((dependency) => completed.has(dependency))
    );
    if (index < 0) {
      errors.push("composition graph contains a cycle or missing dependency");
      break;
    }
    const [node] = remaining.splice(index, 1);
    for (const dependency of node.dependsOn ?? []) {
      if (!byId.has(dependency)) errors.push(`node ${node.nodeId} depends on missing node ${dependency}`);
    }
    for (const binding of node.requiresBindings ?? []) {
      if (!availableBindings.has(binding)) {
        errors.push(`node ${node.nodeId} requires binding ${binding} before it is produced`);
      }
    }
    if (node.bindOutput && typeof node.bindOutput === "object") {
      const binding = node.bindOutput;
      if (!binding.name) errors.push(`node ${node.nodeId} binding requires a name`);
      if (!binding.path) errors.push(`node ${node.nodeId} binding requires an output path`);
      if (binding.expectedType && !["string", "number", "boolean", "object"].includes(binding.expectedType)) {
        errors.push(`node ${node.nodeId} has unsupported binding type ${binding.expectedType}`);
      }
      if (binding.requiredSourceCapability && binding.requiredSourceCapability !== node.capability) {
        errors.push(`node ${node.nodeId} binding producer does not match ${binding.requiredSourceCapability}`);
      }
    }
    (node.producesBindings ?? []).forEach((binding) => availableBindings.add(binding));
    completed.add(node.nodeId);
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}
