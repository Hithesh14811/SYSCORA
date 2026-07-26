import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

test("WindowsAdapter - verifyUserPathEntry and rollbackUserPath", async () => {
  const adapter = new WindowsAdapter();
  // First get current user path to restore later
  const originalPath = await adapter.getUserPath();
  
  try {
    // Add a test entry that probably doesn't exist
    const testEntry = path.join(os.tmpdir(), `syscora-test-path-${process.pid}-${Date.now()}`);
    await adapter.addUserPathEntry(testEntry);
    
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
    await adapter.setUserPath(originalPath.value);
  }
});
