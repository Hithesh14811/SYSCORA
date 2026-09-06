// DOES WINDOWS ACTUALLY SHOW IT?
//
//   npx electron scripts/probe-notification.mjs
//
// The unit tests pin that the renderer, the preload and the main process agree
// about one IPC channel. That is wiring, and wiring is not a toast: Windows can
// still refuse to display one — Focus Assist, notifications turned off for the
// app, or an AppUserModelID it has never seen. None of that is visible from a
// source check, and "never claim something happened without evidence" applies to
// this as much as to anything the agent does.
//
// So this raises a real notification through the same two calls the product
// uses, and reports what Windows said about it: whether notifications are
// supported at all, and whether the toast reached `show`, was displayed, or was
// closed. It prints the AppUserModelID actually in force, because a mismatch
// with the installer's `build.appId` is the failure that shows the wrong name.
//
// It shows one toast. Nothing else on the machine is touched.

import { app, Notification } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const APP_ID = manifest.build.appId;

// ELECTRON'S STDOUT DOES NOT REACH A PIPE ON WINDOWS.
//
// The GUI subsystem has no console attached, so `console.log` from this process
// is discarded when it is run from a shell that captures output — the first run
// of this probe printed nothing at all and looked like a hang. Everything is
// therefore written to a file as well, named on the command line or defaulting
// beside the repo, and that file is the probe's actual result.
const outPath = process.argv.find((a) => a.startsWith("--out="))?.slice(6)
  ?? path.join(repoRoot, "notification-probe.log");
const lines = [];
const say = (line) => { lines.push(line); console.log(line); fs.writeFileSync(outPath, lines.join("\n") + "\n"); };

await app.whenReady();
app.setAppUserModelId(APP_ID);

say(`  build.appId              ${APP_ID}`);
say(`  app.getAppUserModelId()  ${app.getAppUserModelId?.() ?? "(not readable on this platform)"}`);
say(`  Notification.isSupported ${Notification.isSupported()}`);

if (!Notification.isSupported()) {
  say("  RESULT: Windows will not show notifications for this process.");
  app.exit(1);
}

const icon = path.join(repoRoot, "apps/desktop/icon.ico");
say(`  icon exists              ${fs.existsSync(icon)}`);

const toast = new Notification({
  title: "SYSCORA — Done",
  body: "Playing Tum Hi Ho Bandhu on Spotify and sent the link to Amma on WhatsApp.",
  icon,
  silent: true
});

let shown = false;
toast.on("show", () => { shown = true; say("  SHOW      Windows accepted and displayed the toast."); });
toast.on("failed", (_event, error) => { say(`  FAILED    Windows refused it: ${error}`); });
toast.on("click", () => say("  CLICK     the user clicked it."));
toast.on("close", () => say("  CLOSE     it was dismissed or timed out."));

toast.show();

// Long enough for the OS to raise it and for a person to see it, then leave.
setTimeout(() => {
  say(shown
    ? "\n  RESULT: a real Windows toast was displayed. Check the bottom-right corner\n"
      + "          and the Action Centre — it should read SYSCORA, not Electron."
    : "\n  RESULT: `show` never fired. The toast did not reach the screen.");
  app.exit(shown ? 0 : 1);
}, 6000);
