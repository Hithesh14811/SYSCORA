// What machine is this, actually?
//
// The agent ran on a machine it knew nothing about. Asked to open a file "in
// Documents", it ran `Get-ChildItem "$env:USERPROFILE\Documents" -Recurse` —
// which is the right command for a Windows machine in general and the wrong one
// for THIS Windows machine, because OneDrive had redirected the Documents known
// folder to `C:\Users\hithe\OneDrive\Documents`. `%USERPROFILE%\Documents` still
// exists; it is a nearly empty leftover. So the search found nothing, and the
// agent concluded the file did not exist — while it was sitting in the folder
// the user calls Documents.
//
// It then spent ninety seconds recursing the entire user profile to rediscover a
// fact Windows will state in one call, and timed out doing it. The same blindness
// is behind opening WhatsApp Web on a machine with the WhatsApp desktop app
// installed and signed in: with nothing told about the machine, the model has to
// reason from what is typical rather than from what is here.
//
// None of this is a model failure. Nobody had told it where it was.
//
// So: ask Windows once, at the start of the first turn, and put the answer in
// the prompt. It is one PowerShell call, it is cached for the life of the
// process, and it is about fifteen lines — which matters, because this prompt
// has previously been allowed to grow without bound.

// Environment.SpecialFolder names, which resolve through the *live* known-folder
// registration and therefore follow OneDrive redirection. Downloads has no
// SpecialFolder member and has to come from its known-folder GUID instead.
const PROFILE_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue';",
  "$e=[Environment];",
  "$shell='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders';",
  "$dl=(Get-ItemProperty $shell -Name '{374DE290-123F-4565-9164-39C4925E467B}')." +
    "'{374DE290-123F-4565-9164-39C4925E467B}';",
  // The Start menu is the same source `launch` resolves against, so anything
  // named here is genuinely launchable by that name.
  "$apps=@(); try{ $apps=@(Get-StartApps | Select-Object -ExpandProperty Name) }catch{};",
  "$browser=''; try{ $browser=(Get-ItemProperty " +
    "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice')" +
    ".ProgId }catch{};",
  "[pscustomobject]@{",
  "  user=$env:USERNAME; home=$env:USERPROFILE;",
  "  desktop=$e::GetFolderPath('Desktop'); documents=$e::GetFolderPath('MyDocuments');",
  "  pictures=$e::GetFolderPath('MyPictures'); music=$e::GetFolderPath('MyMusic');",
  "  videos=$e::GetFolderPath('MyVideos'); downloads=$dl;",
  "  oneDrive=$env:OneDrive; computer=$env:COMPUTERNAME;",
  "  browser=$browser; apps=$apps",
  "} | ConvertTo-Json -Compress -Depth 3"
].join(" ");

// Applications where "is it installed here" changes the ROUTE, not just the
// wording — a desktop client is already signed in, and the website is not.
// Anything else on the Start menu is reachable through `launch` by name and does
// not need to be listed; naming all of them would be a hundred lines of prompt.
const ROUTE_DECIDING = [
  "WhatsApp", "Spotify", "Telegram", "Signal", "Discord", "Slack",
  "Microsoft Teams", "Outlook", "Mail", "Zoom", "Notion", "Obsidian",
  "Visual Studio Code", "Paint", "Word", "Excel", "PowerPoint", "Notepad",
  "Steam", "Netflix", "Prime Video", "YouTube Music", "Photos", "Calculator"
];

const BROWSER_NAMES = {
  chromehtml: "Google Chrome",
  msedgehtm: "Microsoft Edge",
  msedgehtml: "Microsoft Edge",
  firefoxurl: "Firefox",
  bravehtml: "Brave",
  operastable: "Opera",
  avastbrowserhtml: "Avast Secure Browser"
};

function browserName(progId) {
  const key = String(progId ?? "").toLowerCase().replace(/-.*$/, "").replace(/[^a-z]/g, "");
  for (const [prefix, name] of Object.entries(BROWSER_NAMES)) {
    if (key.startsWith(prefix)) return name;
  }
  return String(progId ?? "").trim() || null;
}

function installedRouteApps(apps) {
  const present = new Set(
    (Array.isArray(apps) ? apps : [])
      .map((name) => String(name ?? "").trim().toLowerCase())
      .filter(Boolean)
  );
  return ROUTE_DECIDING.filter((wanted) => {
    const needle = wanted.toLowerCase();
    for (const name of present) {
      if (name === needle || name.startsWith(`${needle} `) || name.includes(needle)) return true;
    }
    return false;
  });
}

/**
 * Read the machine's real identity and known-folder layout.
 *
 * Never throws: a machine this cannot be read on is one the agent still has to
 * work on, and a missing fact is better than a failed turn.
 */
export async function readMachineProfile(adapter) {
  const empty = { read: false };
  if (typeof adapter?.runPowerShell !== "function") return empty;
  let parsed = null;
  try {
    const ps = await adapter.runPowerShell(PROFILE_SCRIPT, { timeoutMs: 12000 });
    parsed = JSON.parse(String(ps?.stdout ?? "").trim() || "null");
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;

  const home = String(parsed.home ?? "").trim();
  const documents = String(parsed.documents ?? "").trim();
  // The distinction that actually matters. When Documents is redirected, the
  // path everyone reaches for first — `$env:USERPROFILE\Documents` — is a real
  // directory that is not the user's Documents, so a search of it succeeds and
  // finds nothing. That is the failure mode this whole module exists for.
  const redirected = Boolean(
    home && documents && !documents.toLowerCase().startsWith(`${home.toLowerCase()}\\documents`)
  );
  return {
    read: true,
    user: String(parsed.user ?? "").trim() || null,
    computer: String(parsed.computer ?? "").trim() || null,
    home: home || null,
    folders: {
      Desktop: String(parsed.desktop ?? "").trim() || null,
      Documents: documents || null,
      Downloads: String(parsed.downloads ?? "").trim() || null,
      Pictures: String(parsed.pictures ?? "").trim() || null,
      Music: String(parsed.music ?? "").trim() || null,
      Videos: String(parsed.videos ?? "").trim() || null
    },
    oneDrive: String(parsed.oneDrive ?? "").trim() || null,
    redirected,
    browser: browserName(parsed.browser),
    apps: installedRouteApps(parsed.apps)
  };
}

/**
 * The profile as a prompt block — short, concrete, and only facts that change
 * what the agent would otherwise do.
 */
export function describeMachine(profile) {
  if (!profile?.read) return "";
  const lines = ["THIS MACHINE — these are measured facts about the computer you are on. Use them; do not guess."];
  if (profile.user) {
    lines.push(`- Signed in as ${profile.user}${profile.computer ? ` on ${profile.computer}` : ""}, home ${profile.home}.`);
  }
  const folders = Object.entries(profile.folders ?? {}).filter(([, value]) => value);
  if (folders.length) {
    lines.push(
      "- The user's folders, by their real paths:\n" +
      folders.map(([name, value]) => `    ${name}: ${value}`).join("\n")
    );
  }
  if (profile.redirected) {
    // Said as an instruction rather than an observation, because the observation
    // on its own did not change the command the model wrote.
    lines.push(
      `- ONEDRIVE HOLDS THIS USER'S FILES. "Documents", "Desktop" and "Pictures" mean the OneDrive paths ` +
      `above. \`$env:USERPROFILE\\Documents\` is a DIFFERENT, near-empty folder — searching it looks ` +
      `successful and finds nothing. Search the paths above, and when looking for a file the user says ` +
      `they have, search ${profile.oneDrive ? `${profile.oneDrive} ` : "the OneDrive root "}rather than ` +
      "recursing the whole profile. Exclude `node_modules` from any recursive search under it — two " +
      "searches that did not timed out at ninety seconds each without reaching the file."
    );
  }
  if (profile.apps?.length) {
    lines.push(
      `- Desktop apps installed here, launchable by name with \`launch\`: ${profile.apps.join(", ")}.\n` +
      "    An installed desktop app is ALREADY SIGNED IN; its website is not. For messaging, music, mail " +
      "and anything else tied to the user's account, open the app — going to the website first lands on a " +
      "QR code or a login screen and wastes the turn."
    );
  }
  if (profile.browser) {
    // Stated as the registered handler rather than as a promise about where the
    // page will land, because on this machine it does not always agree: a
    // security-suite browser can claim the hand-off without owning the
    // registration. `open_url` reports the window it actually reached, and that
    // report is the fact — this line is only a starting expectation.
    lines.push(
      `- Registered handler for https: ${profile.browser}. \`open_url\` hands the URL to Windows and then ` +
      "tells you which window actually came to the front — believe that, not this line."
    );
  }
  return lines.join("\n");
}
