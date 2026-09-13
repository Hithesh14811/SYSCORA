// WHEN THE MACHINE IS BROKEN, WHICH TOOLS STILL SAY IT WORKED?
//
//   node scripts/probe-fault-injection.mjs
//   node scripts/probe-fault-injection.mjs --verbose     every cell, with the sentence
//   node scripts/probe-fault-injection.mjs --latex
//
// This project's founding defect is an agent claiming work it did not do: "Sent."
// with the message still in the search box, "Muted." with the music audible,
// "Focused." while every keystroke was discarded, "Done." over a file that was
// never written. Each was a `render` returning a string, and each was patched
// separately, after it shipped, as another regex over English.
//
// `evidence.js` replaced that with a structural rule — a success sentence is
// reachable only through `confirmed()`, which throws without a CONFIRMED receipt
// from a capability OTHER than the one that acted. This measures whether the rule
// actually holds when the machine lies, across every acting tool at once.
//
// HOW THIS DIFFERS FROM `tests/unit/tool-evidence.test.js`, WHICH IS NOT A
// DUPLICATE OF IT. That file downgrades a receipt SYNTHETICALLY: it takes a real
// CONFIRMED result, rebuilds the receipt as UNCONFIRMED by hand, and checks the
// render changes its sentence. That proves the render branches. It does not prove
// the chain in front of the render produces the right verdict in the first place.
//
// Here nothing is hand-built. A fault is injected into the CAPABILITY LAYER — the
// actuator silently does nothing, or the reader goes blind — and the tool runs
// the whole way through: act, read back, build the receipt, render. What is
// measured is what a user would have been told.
//
// THE COUNTERFACTUAL, AND WHY IT IS FAIR. An ungated renderer has no branch to
// take: it returns its success sentence whatever happened, because that is what
// "ungated" means and it is precisely what this codebase did before evidence.js —
// "Muted." was a string a function chose to return. So the ungated arm is the
// sentence the tool emits on a HEALTHY machine, and the question for each cell is
// whether that sentence would have been a lie. No second implementation is
// needed, and none is invented.
//
// NOTHING HERE TOUCHES THE MACHINE. Every capability is a stub.

import { harness } from "../tests/unit/fixtures/mock-machine.js";
import { ACTING_CALLS, FAULTS } from "../tests/unit/fixtures/faults.js";
import { CONFIRMED, EvidenceError, looksLikeSuccessClaim } from "../packages/fast-agent/src/evidence.js";

const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");

async function runCell(call, overrides) {
  const files = new Map(call.file ? [call.file] : []);
  const { toolset } = harness({ files, overrides });
  const byName = new Map(toolset.toolsForTest.map((tool) => [tool.name, tool]));
  const tool = byName.get(call.tool);
  try {
    if (call.needsReading) await toolset.execute("screen", { application: "app" });
    const outcome = await toolset.execute(call.tool, call.args);
    const raw = outcome?.raw ?? null;
    // No receipt at all means the toolset caught its own render throwing, which
    // is the gate firing at the outermost layer.
    if (!raw) return { verdict: null, text: String(outcome?.content ?? ""), refused: true };
    let text = null;
    let refused = false;
    try {
      text = tool.render(raw);
    } catch (error) {
      if (!(error instanceof EvidenceError)) throw error;
      refused = true;
    }
    return { verdict: raw.evidence?.verdict ?? null, text: text ?? "", refused };
  } catch (error) {
    // A tool that throws told the user nothing, so it claimed nothing.
    return { verdict: null, text: "", refused: false, threw: String(error.message).slice(0, 80) };
  }
}

const faultNames = Object.keys(FAULTS);
const results = [];

for (const call of ACTING_CALLS) {
  const label = call.label ?? call.tool;
  const healthy = await runCell(call, {});
  const row = {
    label,
    healthyVerdict: healthy.verdict,
    healthySentence: healthy.text,
    // The ungated counterfactual. If the tool does not claim success even on a
    // healthy machine, an ungated copy of it could not have lied either, and the
    // cell is honestly excluded rather than counted as a save.
    ungatedWouldClaim: looksLikeSuccessClaim(healthy.text),
    cells: {}
  };
  for (const fault of faultNames) {
    const cell = await runCell(call, FAULTS[fault]);
    // DID THE FAULT REACH THIS TOOL AT ALL? If the receipt and the sentence are
    // byte-identical to the healthy run, this fault did not perturb this tool —
    // it reads a capability the fault does not override — and the cell is not a
    // test of anything. Counting it would pad the denominator with cells that
    // were never at risk and make the headline rate look better than it is.
    //
    // This is how the volume tool was caught being unreachable by `reader-blind`:
    // it never calls `system.volume.inspect` on the set path, it reads the
    // setter's own return value, so blinding the inspector changed nothing.
    const unperturbed = cell.verdict === row.healthyVerdict && cell.text === row.healthySentence;
    row.cells[fault] = {
      ...cell,
      unperturbed,
      claimed: !unperturbed && !cell.refused && looksLikeSuccessClaim(cell.text),
      falseConfirm: !unperturbed && cell.verdict === CONFIRMED
    };
  }
  results.push(row);
}

// ---------------------------------------------------------------------------

const allCells = results.flatMap((row) => faultNames.map((fault) => ({ row, fault, ...row.cells[fault] })));
const untouched = allCells.filter((cell) => cell.unperturbed);
// Only cells the fault actually perturbed are a test of anything.
const cells = allCells.filter((cell) => !cell.unperturbed);
const atRisk = cells.filter((cell) => cell.row.ungatedWouldClaim);
const gatedClaims = cells.filter((cell) => cell.claimed);
const falseConfirms = cells.filter((cell) => cell.falseConfirm);

console.log(`\n${ACTING_CALLS.length} acting tools x ${faultNames.length} fault classes = ${cells.length} cells`);
console.log("injected into the capability layer; every receipt below was produced by the real code path\n");

const mark = (cell) => {
  if (cell.unperturbed) return "n/a ";
  if (cell.falseConfirm) return "CONF";
  if (cell.claimed) return "LIE ";
  if (cell.refused) return "ref ";
  return " .  ";
};

const width = Math.max(...results.map((row) => row.label.length)) + 1;
console.log(`${"tool".padEnd(width)} ${faultNames.map((f) => f.slice(0, 15).padEnd(16)).join("")}ungated`);
console.log("-".repeat(width + faultNames.length * 16 + 8));
for (const row of results) {
  console.log(
    `${row.label.padEnd(width)} ` +
    faultNames.map((fault) => mark(row.cells[fault]).padEnd(16)).join("") +
    (row.ungatedWouldClaim ? "would lie" : "hedges anyway")
  );
}
console.log("-".repeat(width + faultNames.length * 16 + 8));
console.log("  .  = honest    ref = the render refused to speak    LIE = claimed success    CONF = CONFIRMED on a broken machine\n");

const pct = (n, d) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);
console.log(`cells where an UNGATED renderer would have claimed success : ${atRisk.length}/${cells.length}  ${pct(atRisk.length, cells.length)}`);
console.log(`cells where the GATED renderer claimed success             : ${gatedClaims.length}/${cells.length}  ${pct(gatedClaims.length, cells.length)}`);
console.log(`cells returning CONFIRMED against a broken machine         : ${falseConfirms.length}/${cells.length}  ${pct(falseConfirms.length, cells.length)}`);
console.log(`cells excluded because the fault never reached the tool    : ${untouched.length}/${allCells.length}`);

if (verbose) {
  console.log("\n--- every cell ---");
  for (const row of results) {
    console.log(`\n${row.label}  [healthy: ${row.healthyVerdict}] ${JSON.stringify(row.healthySentence.slice(0, 90))}`);
    for (const fault of faultNames) {
      const cell = row.cells[fault];
      console.log(`   ${fault.padEnd(16)} ${String(cell.verdict).padEnd(12)} ${cell.refused ? "(render refused)" : JSON.stringify(String(cell.text).slice(0, 90))}`);
    }
  }
}

if (falseConfirms.length > 0) {
  console.log("\nCONFIRMED ON A BROKEN MACHINE — these are real defects, not results:");
  for (const cell of falseConfirms) {
    console.log(`  ${cell.row.label} / ${cell.fault}: ${JSON.stringify(String(cell.text).slice(0, 120))}`);
  }
}
if (gatedClaims.length > 0) {
  console.log("\nCLAIMED SUCCESS WITH THE GATE ON — these are real defects, not results:");
  for (const cell of gatedClaims) {
    console.log(`  ${cell.row.label} / ${cell.fault}: ${JSON.stringify(String(cell.text).slice(0, 120))}`);
  }
}

// THE PROBE MUST BE ABLE TO FAIL. If no tool would have lied without the gate,
// this measured nothing at all — a broken fixture, or a fault set that does not
// actually break anything, and the headline 0% would be vacuous. Five checks in
// this repository could not fail and were believed for months.
if (atRisk.length === 0) {
  console.log("\nFAIL: not one tool would have claimed success even without the gate, so this run " +
    "measured nothing. The faults are not reaching the tools.");
  process.exitCode = 1;
}

if (argv.includes("--latex")) {
  console.log("\n% --- paste into the paper ---");
  console.log("\\begin{tabular}{lrr}");
  console.log("\\toprule");
  console.log("Renderer & False success claims & Rate \\\\");
  console.log("\\midrule");
  console.log(`Ungated (pre-\\texttt{evidence.js}) & ${atRisk.length} / ${cells.length} & ${pct(atRisk.length, cells.length)} \\\\`);
  console.log(`Evidence-gated & ${gatedClaims.length} / ${cells.length} & ${pct(gatedClaims.length, cells.length)} \\\\`);
  console.log("\\bottomrule");
  console.log("\\end{tabular}");
}
