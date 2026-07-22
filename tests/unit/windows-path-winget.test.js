import test from "node:test";
import assert from "node:assert/strict";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

test("windows adapter path splitting and joining is stable", () => {
  const adapter = new WindowsAdapter();
  const value = "C:\\A\\;C:\\B;C:\\A\\";
  const split = adapter.splitPath(value);
  assert.deepEqual(split, ["C:\\A", "C:\\B", "C:\\A"]);
  const joined = adapter.joinPath(["C:\\A\\", "C:\\B\\"]);
  assert.equal(joined, "C:\\A;C:\\B");
});

test("WinGet verification stays on the install source and is non-interactive", async () => {
  const adapter = new WindowsAdapter();
  let received;
  adapter.executeCommand = async (_cwd, command, args, options) => {
    received = { command, args, options };
    return { exitCode: 0, stdout: "Spotify.Spotify" };
  };

  await adapter.wingetList("Spotify.Spotify");

  assert.equal(received.command, "winget");
  assert.deepEqual(received.args, [
    "list", "--id", "Spotify.Spotify", "--source", "winget", "--accept-source-agreements"
  ]);
});

