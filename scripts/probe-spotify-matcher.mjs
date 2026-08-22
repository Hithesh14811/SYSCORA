// Is the Spotify result matcher's embedded PowerShell still valid, and does it
// now prefer a song over a podcast episode of the same name?
//
// The script is built as one long string of PowerShell and handed to a shell, so
// a typo in it does not fail at import — it fails live, mid-task, as "matching
// track not found". This parses it with PowerShell's own parser before anything
// is played, and checks the scoring rules that decide song vs episode.
//
//   node scripts/probe-spotify-matcher.mjs

import { spawn } from "node:child_process";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const results = [];
const check = (name, passed, detail) => {
  results.push(passed);
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${String(detail).replace(/\n/g, "\n      ").slice(0, 500)}` : ""}`);
};

// Capture the script the adapter builds without running it.
let built = null;
const adapter = new WindowsAdapter({ automationHost: false });
adapter.runPowerShell = async (script) => {
  built = script;
  return { stdout: "null", stderr: "", exitCode: 0 };
};

await adapter._invokeSpotifyPlayButton("Shake It Off Taylor Swift", 3000, 12345);
check("the matcher builds a script", Boolean(built) && built.length > 500, `${built?.length ?? 0} characters`);

// The rules this fix depends on must actually be in there.
check("candidates are scored rather than all-or-nothing", /\$scoreOf=/.test(built) && /\$needed=/.test(built));
check("a majority of tokens is enough to be considered", /\* 0\.5/.test(built));
check("podcast rows are recognised", /\$isEpisode=/.test(built) && /Your Episodes/.test(built));
check("a song is preferred and an episode only used as a fallback",
  /\$episodePlay=\$candidate/.test(built) && /if\(-not \$play -and \$episodePlay\)/.test(built));
check("the caller is told when it settled for an episode", /pickedEpisode=\$pickedEpisode/.test(built));

// PowerShell's own parser is the only authority on whether this runs.
const parse = await new Promise((resolve) => {
  const check = `
    $ErrorActionPreference='Stop'
    $code = [Console]::In.ReadToEnd()
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$null, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { $_.Message } ; exit 1 }
    'PARSED-OK'`;
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", check], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  child.on("close", (code) => resolve({ code, out: out.trim() }));
  child.stdin.end(built);
});
check("PowerShell parses the generated script", parse.code === 0 && /PARSED-OK/.test(parse.out), parse.out);

// The scoring rule itself, checked directly: this is the reason a podcast won.
const tokens = ["shake", "it", "off", "taylor", "swift"];
const scoreOf = (label) => {
  const words = label.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return tokens.filter((token) => words.includes(token)).length;
};
const needed = Math.max(1, Math.ceil(tokens.length * 0.5));
check("the song row now qualifies (it did not before)",
  scoreOf("Shake It Off") >= needed,
  `song row scores ${scoreOf("Shake It Off")} of ${tokens.length}, needs ${needed} — under the old all-tokens rule it scored 3/5 and was rejected`);
check("the episode row still qualifies, so ranking is what decides",
  scoreOf("Shake It Off - Taylor Swift") >= needed,
  `episode row scores ${scoreOf("Shake It Off - Taylor Swift")} of ${tokens.length}`);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
