// Can a remembered shape reach past the DENY floor?
//
//   node scripts/probe-deny-through-allowlist.mjs
//
// TWO LAYERS, AND THE POINT IS THAT THEY ARE SEPARATE.
//
//   the allowlist  decides whether the approval CARD is shown      (tools.js)
//   the DENY floor decides whether a process is spawned at all     (the adapter)
//
// The floor is checked in `WindowsAdapter.executeCommand`, on the source command
// AND on the spawn wrapper, precisely so that a caller which forgot to check
// cannot run one. A harness with a stub adapter therefore has NO floor — and
// this script says so out loud rather than quietly proving nothing, because
// "I stubbed out the safety check and the safety check did not fire" is the
// shape of a test that has caught nothing in this codebase before.
//
// So this prints both layers' answers for the same command lines.

import {
  classifyShellCommand,
  rememberableShellShape,
  shellShapeIsAllowed
} from "../packages/policy-engine/src/shell-rules.js";

const CASES = [
  "npm run build",
  "npm run lint",
  "npm run build; Remove-Item -Recurse -Force C:\\",
  "npm run build | iex",
  "npm publish",
  "Remove-Item -Recurse -Force C:\\Windows"
];

// A session in which the user has already said "yes, and don't ask again" to
// `npm run`.
const allowed = new Set(["npm run"]);

console.log("A session that has approved `npm run` once:\n");
console.log("floor    card        command");
console.log("-".repeat(78));
for (const command of CASES) {
  const { verdict } = classifyShellCommand(command);
  // The card is only skipped when the shape is covered AND the command would
  // have asked in the first place. A DENY never reaches this question.
  const skipsCard = verdict === "ASK" && shellShapeIsAllowed(command, [], allowed);
  const card = verdict === "DENY" ? "never runs" : (skipsCard ? "skipped" : "SHOWN");
  console.log(String(verdict).padEnd(8), card.padEnd(11), JSON.stringify(command));
}

console.log("\nWhat each command would be remembered as, if approved:");
for (const command of CASES) {
  const shape = rememberableShellShape(command);
  console.log(`  ${shape ? shape.key.padEnd(12) : "— never    ".padEnd(12)} ${JSON.stringify(command)}`);
}

console.log(
  "\nThe floor itself is not exercised here — it lives in WindowsAdapter.executeCommand\n" +
  "and is covered by tests/unit/shell-rules.test.js. What this shows is that no\n" +
  "remembered shape ever covers a DENY, so the two layers cannot be traded off."
);
