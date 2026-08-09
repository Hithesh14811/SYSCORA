import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

test("WindowsAdapter - verifyUserPathEntry and rollbackUserPath", async (t) => {
  const adapter = new WindowsAdapter();
  // First get current user path to restore later
  const originalPath = await adapter.getUserPath();
  
  try {
    // Add a test entry that probably doesn't exist
    const testEntry = path.join(os.tmpdir(), `syscora-test-path-${process.pid}-${Date.now()}`);
    try {
      await adapter.addUserPathEntry(testEntry);
    } catch (error) {
      if (error?.code === "USER_PATH_PERMISSION_DENIED") {
        t.skip("Windows user PATH registry writes are not permitted in this execution environment");
        return;
      }
      throw error;
    }
    
    // Verify it's there
    const verification = await adapter.verifyUserPathEntry(testEntry);
    assert.equal(verification.present, true);
    
    // Rollback to original
    await adapter.rollbackUserPath(originalPath.value);
    
    // Verify it's gone
    const afterRollback = await adapter.verifyUserPathEntry(testEntry);
    assert.equal(afterRollback.present, false);
  } finally {
    // Always try to restore original path
    try {
      await adapter.setUserPath(originalPath.value);
    } catch (error) {
      if (error?.code !== "USER_PATH_PERMISSION_DENIED") throw error;
    }
  }
});

test("WindowsAdapter - setUserPath fails closed on a PowerShell non-terminating registry error", async () => {
  const adapter = new WindowsAdapter();
  let call = 0;
  adapter.runPowerShell = async () => {
    call += 1;
    if (call === 1) return { exitCode: 0, stdout: '"C:\\\\WindowsApps"', stderr: "" };
    return {
      exitCode: 0,
      stdout: '"C:\\\\WindowsApps"',
      stderr: "Exception calling SetEnvironmentVariable: Requested registry access is not allowed."
    };
  };

  await assert.rejects(
    adapter.setUserPath("C:\\\\WindowsApps;C:\\\\Tools"),
    (error) => error?.code === "USER_PATH_PERMISSION_DENIED"
  );
});
