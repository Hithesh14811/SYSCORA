// MVP investor-demo acceptance tests — the five demo workflows through the REAL
// production runtime factory (createRuntime), no fake planner injection.
//
// The model provider is forced to "mock" (deterministic) so these run offline,
// reproducibly, and without spending API credits. That exercises the SAME
// deterministic fallback path the demo relies on when AgentRouter is
// unavailable — real capabilities, real scheduler, real observation/verify.
// The real-model path is proven separately (opt-in) in m3-real-model.test.js.
//
// Read-only workflows run against the real OS on Windows and assert no
// unnecessary approval. Mutating workflows (filesystem) use a temp dir and are
// verified + cleaned up. Windows-only; skipped elsewhere.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import net from "node:net";
import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";

const onWindows = process.platform === "win32";
const demo = (name, fn) => test(name, { skip: onWindows ? false : "Windows-only demo workflow" }, fn);

// Force the deterministic planner for every runtime built here.
process.env.SYSCORA_MODEL_PROVIDER = "mock";

async function freshRuntime() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-demo-"));
  return { runtime: createRuntime(base), base };
}

const capsOf = (s) => (s.plan?.taskGraph?.tasks ?? []).map((t) => t.capability);
const askedApproval = (s) => s.finalResponse?.status === "AWAITING_APPROVAL";

// ---- WORKFLOW A: system + developer intelligence (read-only) ----------------
demo("A. system+dev prompt → real read-only plan, no approval, verified", async () => {
  const { runtime, base } = await freshRuntime();
  try {
    const s = await runtime.submitIntent(
      "Tell me about this computer and what development tools are installed.",
      { autoApprove: false, workspacePath: base }
    );
    const caps = capsOf(s);
    assert.ok(caps.includes("system.inspect"), "composes system.inspect");
    assert.ok(caps.length >= 2, "multi-capability developer snapshot");
    assert.equal(s.plan.plannerSource, "DETERMINISTIC_FALLBACK");
    assert.equal(askedApproval(s), false, "read-only inspection must NOT require approval");
    assert.equal(s.finalResponse.status, "COMPLETED", `expected COMPLETED, got ${s.finalResponse.status}`);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// ---- WORKFLOW B: port troubleshooting (read-only) ---------------------------
demo("B. port prompt → extracts port, real inspection, no approval", async () => {
  const { runtime, base } = await freshRuntime();
  // A real listener so the inspection has a genuine owner to find.
  const server = net.createServer();
  const port = await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  try {
    const s = await runtime.submitIntent(
      `Something is using port ${port}. Find out what it is.`,
      { autoApprove: false, workspacePath: base }
    );
    assert.ok(capsOf(s).includes("process.port.inspect"), "composes process.port.inspect");
    assert.equal(s.plan.taskGraph.tasks[0].inputs.port, port, "extracts the exact port");
    assert.equal(askedApproval(s), false, "read-only port inspection must NOT require approval");
    assert.equal(s.finalResponse.status, "COMPLETED");
  } finally {
    server.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

// ---- WORKFLOW C: file/folder multi-step (mutating, verified) ----------------
demo("C. file/folder workflow → real multi-step create+verify, approval gated", async () => {
  const { runtime, base } = await freshRuntime();
  try {
    // Mutating, so it correctly requires approval; autoApprove drives the demo.
    const s = await runtime.submitIntent(
      "Create a temporary development folder and create a config file inside it, then verify everything exists.",
      { autoApprove: true, workspacePath: base }
    );
    const caps = capsOf(s);
    assert.ok(caps.includes("filesystem.createDirectory"), "composes createDirectory");
    assert.ok(caps.includes("filesystem.write"), "composes write");
    assert.ok(caps.length >= 2, "multi-task graph");
    assert.equal(s.finalResponse.status, "COMPLETED", `expected COMPLETED, got ${s.finalResponse.status}`);

    // Independently verify the real filesystem effect: a directory + file exist
    // somewhere under the demo workspace.
    const results = s.taskResults ?? [];
    const dirResult = results.find((r) => r.executionResult?.directoryPath)?.executionResult;
    const fileResult = results.find((r) => r.executionResult?.filePath)?.executionResult;
    assert.ok(dirResult?.directoryPath, "a directory was actually created");
    const dirStat = await fs.stat(dirResult.directoryPath);
    assert.ok(dirStat.isDirectory(), "created directory exists on disk");
    if (fileResult?.filePath) {
      const fileStat = await fs.stat(fileResult.filePath);
      assert.ok(fileStat.isFile(), "created config file exists on disk");
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// ---- WORKFLOW D: WinGet software discovery (read-only) ----------------------
demo("D. winget search prompt → real search, no approval", async () => {
  const { runtime, base } = await freshRuntime();
  try {
    const s = await runtime.submitIntent(
      "Find VLC using Windows Package Manager and tell me what would be installed.",
      { autoApprove: false, workspacePath: base }
    );
    assert.ok(capsOf(s).includes("package.winget.search"), "composes package.winget.search");
    assert.equal(askedApproval(s), false, "search must NOT require approval");
    // WinGet may be absent on a bare CI box; either it completed, or it failed
    // gracefully without crashing. Never AWAITING_APPROVAL for a search.
    assert.ok(["COMPLETED", "FAILED"].includes(s.finalResponse.status), `unexpected ${s.finalResponse.status}`);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// ---- WORKFLOW E: project inspection (read-only) -----------------------------
demo("E. project inspection prompt → real read-only analysis, no approval", async () => {
  const { runtime, base } = await freshRuntime();
  // A fixture project so inspection has real evidence to read.
  await fs.writeFile(path.join(base, "package.json"), JSON.stringify({
    name: "demo-fixture", scripts: { start: "node index.js" }, dependencies: { express: "^4" }
  }));
  try {
    const s = await runtime.submitIntent(
      "Inspect this project and tell me what I need to run it.",
      { autoApprove: false, workspacePath: base }
    );
    assert.ok(capsOf(s).includes("environment.project.inspect"), "composes project inspection");
    assert.equal(askedApproval(s), false, "project inspection must NOT require approval");
    assert.equal(s.finalResponse.status, "COMPLETED");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// ---- Provider failure: bounded latency, no crash ----------------------------
demo("F. unreachable provider falls back quickly (bounded latency)", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-demo-"));
  // Point at a dead gateway so the health gate must trip.
  process.env.SYSCORA_MODEL_PROVIDER = "agentrouter";
  process.env.SYSCORA_MODEL_API_KEY = "sk-dead-key-for-test";
  process.env.SYSCORA_MODEL_BASE_URL = "https://127.0.0.1:9/v1"; // nothing listens
  try {
    const runtime = createRuntime(base);
    const started = Date.now();
    const s = await runtime.submitIntent(
      "Tell me about this computer and what development tools are installed.",
      { autoApprove: false, workspacePath: base }
    );
    const elapsed = Date.now() - started;
    assert.equal(s.plan.plannerSource, "DETERMINISTIC_FALLBACK", "must fall back, not hang on model");
    assert.equal(s.finalResponse.status, "COMPLETED");
    assert.ok(elapsed < 12000, `fallback must be bounded (<12s), took ${elapsed}ms`);
  } finally {
    delete process.env.SYSCORA_MODEL_API_KEY;
    delete process.env.SYSCORA_MODEL_BASE_URL;
    process.env.SYSCORA_MODEL_PROVIDER = "mock";
    await fs.rm(base, { recursive: true, force: true });
  }
});
