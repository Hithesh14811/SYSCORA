import test from "node:test";
import assert from "node:assert/strict";
import { summarizeReadOnlyResults } from "../../packages/agent-runtime/src/read-result-summary.js";

const readRegistry = {
  get() {
    return { permissionModel: { type: "READ" } };
  }
};

test("aggregate system reads return the requested facts instead of a task count", () => {
  const summary = summarizeReadOnlyResults([
    {
      capability: "system.inspect",
      executionResult: {
        release: "10.0.26200",
        totalMemory: 33685659648,
        cpus: 16,
        windowsDetails: {
          caption: "Microsoft Windows 11 Home",
          version: "10.0.26200",
          build: "26200",
          totalMemory: 33685659648,
          cpuName: "Example CPU",
          cpuCores: 16,
          cpuLogical: 16
        },
        rawCommand: { stdout: "must not be shown" }
      }
    },
    { capability: "processes.list", executionResult: [{ ProcessName: "one" }] },
    { capability: "system.services.list", executionResult: [{ DisplayName: "two" }] }
  ], readRegistry);

  assert.match(summary, /Windows 11 Home/);
  assert.match(summary, /Example CPU/);
  assert.match(summary, /31\.4 GiB/);
  assert.doesNotMatch(summary, /must not be shown/);
  assert.doesNotMatch(summary, /3 tasks/);
});

test("read-result summaries fail closed for mutating capabilities", () => {
  const registry = {
    get(name) {
      return { permissionModel: { type: name === "filesystem.write" ? "WRITE" : "READ" } };
    }
  };
  assert.equal(summarizeReadOnlyResults([
    { capability: "filesystem.write", executionResult: { filePath: "x.txt" } }
  ], registry), null);
});

test("directory summaries report the exact file count rather than total entries", () => {
  const summary = summarizeReadOnlyResults([{
    capability: "filesystem.list",
    executionResult: {
      root: "C:\\Users\\Example\\Downloads",
      exists: true,
      fileCount: 372,
      directoryCount: 4,
      count: 376,
      entries: []
    }
  }], readRegistry);
  assert.match(summary, /contains 372 files and 4 directories/);
  assert.doesNotMatch(summary, /376/);
});
