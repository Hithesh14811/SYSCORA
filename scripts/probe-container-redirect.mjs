#!/usr/bin/env node
// Is a directory what it says it is, or is somebody redirecting it?
//
// `C:\Users\hithe\AppData\Local\SYSCORA` held the user's 1,904 conversations and
// physically lived at
// `...\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\SYSCORA`.
// From inside the container that redirection is invisible: lstat says "ordinary
// directory", readlink says "not a link", and every read agrees with every
// write. From outside - Notepad's Save dialog, for one - the same path resolves
// somewhere else entirely and the save fails.
//
// So this probe does not ask our own filesystem calls, which are the things
// being fooled. It asks Windows for the resolved target and compares.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: probe-container-redirect.mjs <dir> [<dir>...]");
  process.exit(2);
}

// PowerShell resolves the true target for junctions, symlinks AND the
// package-container mapping, which node's lstat/realpath do not see.
function windowsTarget(dir) {
  try {
    const out = execFileSync("powershell", [
      "-NoProfile", "-Command",
      `$i = Get-Item -LiteralPath ${JSON.stringify(dir)} -Force -ErrorAction Stop; `
      + "[PSCustomObject]@{ attributes = $i.Attributes.ToString(); target = $i.Target } | ConvertTo-Json -Compress"
    ], { encoding: "utf8", timeout: 30_000 });
    return JSON.parse(out);
  } catch (error) {
    return { attributes: "(unreadable)", target: null, error: String(error.message).split("\n")[0] };
  }
}

let redirected = 0;
for (const raw of targets) {
  const dir = path.resolve(raw);
  console.log(`\n${dir}`);
  if (!fs.existsSync(dir)) { console.log("  does not exist"); continue; }

  const st = fs.lstatSync(dir);
  console.log(`  node lstat        isSymbolicLink=${st.isSymbolicLink()}  isDirectory=${st.isDirectory()}`);
  let real = null;
  try { real = fs.realpathSync.native(dir); } catch (e) { real = `ERR ${e.code}`; }
  console.log(`  node realpath     ${real}`);

  const win = windowsTarget(dir);
  // `.Target` comes back as an EMPTY STRING, not null, for an ordinary
  // directory — so `win.target ?? ...` kept the empty string and the verdict
  // read "a link, but not into a container" for a path that is not a link at
  // all. Trim to nothing and treat nothing as clean.
  const target = String(win.target ?? "").trim();
  console.log(`  windows attrs     ${win.attributes}`);
  console.log(`  windows target    ${target || "(none - the path is what it says it is)"}`);

  if (target && /[\\/]Packages[\\/][^\\/]+[\\/]LocalCache/i.test(target)) {
    redirected += 1;
    console.log("  VERDICT           REDIRECTED INTO AN APPLICATION CONTAINER");
    console.log("                    Processes outside that container resolve this path differently,");
    console.log("                    and the contents die with the application.");
  } else if (target) {
    console.log("  VERDICT           a link, but not into a container");
  } else {
    console.log("  VERDICT           clean");
  }
}
process.exit(redirected > 0 ? 1 : 0);
