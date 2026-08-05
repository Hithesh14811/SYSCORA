import test from "node:test";
import assert from "node:assert/strict";
import { PrerequisiteResolver, PrerequisiteState } from "../../packages/agent-runtime/src/prerequisite-resolver.js";
import { EnvironmentModel } from "../../packages/context-engine/src/environment-model.js";

function build({ installed = false, searchResults = null, installSucceeds = true, installedAfter = true } = {}) {
  const calls = { install: [], search: [], resolve: [] };
  let present = installed;
  const adapter = {
    resolveApplicationTarget: async (application) => {
      calls.resolve.push(application);
      return present
        ? { application, resolved: true, kind: "start-menu", target: `${application}.AppID` }
        : { application, resolved: false, kind: null, target: null, reason: "NO_INSTALLED_IDENTITY" };
    },
    listProcesses: async () => [],
    listWindows: async () => [],
    inspectPort: async (port) => ({ port, listening: false, status: "NOT_LISTENING", connections: [], probe: { ok: true } }),
    searchPackages: async (query) => {
      calls.search.push(query);
      return searchResults ?? [
        { id: "Acme.Notes", name: "Acme Notes", publisher: "Acme Inc.", version: "3.1.0", source: "winget" }
      ];
    },
    installPackage: async (id, source) => {
      calls.install.push({ id, source });
      if (installSucceeds) present = installedAfter;
      return { exitCode: installSucceeds ? 0 : 1 };
    }
  };
  const resolver = new PrerequisiteResolver({
    environmentModel: new EnvironmentModel({ adapter }),
    adapter
  });
  return { resolver, calls, adapter };
}

const originalTask = { taskId: "goal-1", capability: "media.play", inputs: { application: "Acme Notes", query: "Good For You" } };

test("an already-installed application is used directly and the installer is never invoked", async () => {
  const { resolver, calls } = build({ installed: true });
  const outcome = await resolver.ensureApplicationAvailable("Acme Notes", { originalTask });

  assert.equal(outcome.state, PrerequisiteState.AVAILABLE);
  assert.deepEqual(calls.install, [], "an installed application must never reach the installer");
  assert.deepEqual(calls.search, [], "no package search is needed when it is already present");
  assert.deepEqual(outcome.resumeTask, originalTask);
});

test("a missing application produces one scoped approval request naming the exact package", async () => {
  const { resolver, calls } = build({ installed: false });
  const outcome = await resolver.ensureApplicationAvailable("Acme Notes", { originalTask });

  assert.equal(outcome.state, PrerequisiteState.APPROVAL_REQUIRED);
  assert.equal(outcome.proposal.packageId, "Acme.Notes");
  assert.equal(outcome.proposal.publisher, "Acme Inc.");
  assert.equal(outcome.proposal.version, "3.1.0");
  assert.equal(outcome.proposal.source, "winget");
  assert.ok(outcome.proposal.requiredPrivileges);
  assert.deepEqual(calls.install, [], "nothing may be installed before approval");
  // The original goal survives the interruption.
  assert.deepEqual(outcome.resumeTask, originalTask);
});

test("installation runs only against the exact approved package identity and source", async () => {
  const { resolver, calls } = build({ installed: false });
  const proposed = await resolver.ensureApplicationAvailable("Acme Notes", { originalTask });

  const wrongId = await resolver.installApproved(proposed, { packageId: "Evil.Package", source: "winget" });
  assert.equal(wrongId.state, PrerequisiteState.UNAVAILABLE);
  assert.equal(wrongId.reason, "APPROVAL_IDENTITY_MISMATCH");

  const wrongSource = await resolver.installApproved(proposed, { packageId: "Acme.Notes", source: "some-other-feed" });
  assert.equal(wrongSource.state, PrerequisiteState.UNAVAILABLE);
  assert.equal(wrongSource.reason, "APPROVAL_IDENTITY_MISMATCH");

  assert.deepEqual(calls.install, [], "a mismatched approval must never install anything");
});

test("an approved installation is verified independently and resumes the original goal", async () => {
  const { resolver, calls } = build({ installed: false });
  const proposed = await resolver.ensureApplicationAvailable("Acme Notes", { originalTask });
  const installed = await resolver.installApproved(proposed, { packageId: "Acme.Notes", source: "winget" });

  assert.equal(installed.state, PrerequisiteState.AVAILABLE);
  assert.deepEqual(calls.install, [{ id: "Acme.Notes", source: "winget" }]);
  assert.equal(installed.verifiedIndependently, true);
  assert.deepEqual(installed.resumeTask, originalTask);
});

test("an installation that reports success but leaves nothing installed is not treated as available", async () => {
  const { resolver } = build({ installed: false, installedAfter: false });
  const proposed = await resolver.ensureApplicationAvailable("Acme Notes", { originalTask });
  const installed = await resolver.installApproved(proposed, { packageId: "Acme.Notes", source: "winget" });

  assert.equal(installed.state, PrerequisiteState.UNAVAILABLE);
  assert.equal(installed.reason, "INSTALL_NOT_VERIFIED");
  // The original task context survives the failure rather than being discarded.
  assert.deepEqual(installed.resumeTask, originalTask);
});

test("a failed installer exit is reported as a failure and the goal context is preserved", async () => {
  const { resolver } = build({ installed: false, installSucceeds: false });
  const proposed = await resolver.ensureApplicationAvailable("Acme Notes", { originalTask });
  const installed = await resolver.installApproved(proposed, { packageId: "Acme.Notes", source: "winget" });

  assert.equal(installed.state, PrerequisiteState.UNAVAILABLE);
  assert.deepEqual(installed.resumeTask, originalTask);
});

test("no trusted package source means the request stops rather than guessing an installer", async () => {
  const { resolver, calls } = build({ installed: false, searchResults: [] });
  const outcome = await resolver.ensureApplicationAvailable("Nonexistent App", { originalTask });

  assert.equal(outcome.state, PrerequisiteState.UNAVAILABLE);
  assert.equal(outcome.reason, "NO_TRUSTED_PACKAGE_SOURCE");
  assert.deepEqual(calls.install, []);
});

test("an untrusted package source is never proposed for installation", async () => {
  const { resolver } = build({
    installed: false,
    searchResults: [{ id: "Acme.Notes", name: "Acme Notes", publisher: "Acme Inc.", version: "3.1.0", source: "random-internet-download" }]
  });
  const outcome = await resolver.ensureApplicationAvailable("Acme Notes", { originalTask });
  assert.equal(outcome.state, PrerequisiteState.UNAVAILABLE);
  assert.equal(outcome.reason, "NO_TRUSTED_PACKAGE_SOURCE");
});

test("an ambiguous package match asks rather than picking one", async () => {
  // Two plausible near-matches and no exact name match: the resolver must not
  // choose on the user's behalf.
  const { resolver, calls } = build({
    installed: false,
    searchResults: [
      { id: "Acme.NotesLite", name: "Acme Notes Lite", publisher: "Acme Inc.", version: "3.1.0", source: "winget" },
      { id: "Acme.NotesPro", name: "Acme Notes Pro", publisher: "Acme Inc.", version: "4.0.0", source: "winget" }
    ]
  });
  const outcome = await resolver.ensureApplicationAvailable("Acme Notes", { originalTask });
  assert.equal(outcome.state, PrerequisiteState.CLARIFICATION_REQUIRED);
  assert.equal(outcome.candidates.length, 2);
  assert.deepEqual(calls.install, []);
  assert.deepEqual(outcome.resumeTask, originalTask);
});

test("an exact package-name match still requires approval of that exact identity", async () => {
  const { resolver } = build({
    installed: false,
    searchResults: [
      { id: "Acme.Notes", name: "Acme Notes", publisher: "Acme Inc.", version: "3.1.0", source: "winget" },
      { id: "Acme.NotesPro", name: "Acme Notes Pro", publisher: "Acme Inc.", version: "4.0.0", source: "winget" }
    ]
  });
  const outcome = await resolver.ensureApplicationAvailable("Acme Notes", { originalTask });
  assert.equal(outcome.state, PrerequisiteState.APPROVAL_REQUIRED);
  assert.equal(outcome.proposal.packageId, "Acme.Notes");
});

test("a failure to ground a window is never treated as absence of the application", async () => {
  // Installed and resolvable, but no window ever appears.
  const { resolver, calls } = build({ installed: true });
  const outcome = await resolver.ensureApplicationAvailable("Acme Notes", { originalTask });
  assert.equal(outcome.state, PrerequisiteState.AVAILABLE);
  assert.equal(outcome.environment.installed, true);
  assert.equal(outcome.environment.running, false);
  assert.deepEqual(calls.install, [], "an ungrounded window must never trigger a reinstall");
});

test("winget search output is parsed into exact package identities", async () => {
  const { parseWingetSearchTable } = await import("../../os-adapters/windows/src/windows-adapter.js");
  const stdout = [
    "Name                 Id                           Version   Source",
    "---------------------------------------------------------------------",
    "Acme Notes           Acme.Notes                   3.1.0     winget",
    "Acme Notes Pro       Acme.NotesPro                4.0.0     winget",
    "Visual Studio Code   Microsoft.VisualStudioCode   1.90.0    winget"
  ].join("\n");
  const parsed = parseWingetSearchTable(stdout);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { id: "Acme.Notes", name: "Acme Notes", version: "3.1.0", source: "winget", publisher: null });
  assert.equal(parsed[2].id, "Microsoft.VisualStudioCode");
  // Output with no table yields no candidates rather than a guessed identity.
  assert.deepEqual(parseWingetSearchTable("No package found matching input criteria."), []);
});

test("the approval proposal names the publisher reported by the package feed", async () => {
  const { resolver, adapter } = build({ installed: false });
  adapter.searchPackages = async () => [{ id: "Acme.Notes", name: "Acme Notes", version: "3.1.0", source: "winget", publisher: null }];
  adapter.describePackage = async (id, source) => ({ id, source, publisher: "Acme Incorporated", version: "3.1.0" });
  const outcome = await resolver.ensureApplicationAvailable("Acme Notes", { originalTask });
  assert.equal(outcome.proposal.publisher, "Acme Incorporated");
});
