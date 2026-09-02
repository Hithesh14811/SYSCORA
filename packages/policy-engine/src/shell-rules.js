// Shell command rules.
//
// A general OS agent needs a terminal. Everything a person does on Windows is
// reachable from one — faster, more precisely and more verifiably than by
// driving a GUI — and an agent without one substitutes twenty clicks for one
// line. So the terminal is open. What makes that safe is not withholding it; it
// is that every command line is read before it runs and sorted into three
// buckets:
//
//   ALLOW  the command only READS. It runs immediately, with no approval, the
//          way `ls` needs no ceremony. This is an explicit allow-list.
//   ASK    the command changes something. It goes through risk, policy and the
//          user's approval like any other mutation. This is the DEFAULT, so a
//          command nobody anticipated lands here rather than in ALLOW.
//   DENY   the command destroys data, disables a security control, or executes
//          something fetched from the network. It does not run at all, and no
//          approval — not even an auto-approving session — unblocks it.
//
// The asymmetry is deliberate. A wrong ASK costs one confirmation click. A
// wrong ALLOW runs something that changes the machine without being seen, and a
// wrong DENY is a refusal the user can work around by typing the command
// themselves. Only ALLOW is unrecoverable, so only ALLOW is an explicit list.

export const ShellVerdict = Object.freeze({
  ALLOW: "ALLOW",
  ASK: "ASK",
  DENY: "DENY"
});

// The capabilities whose risk lives in their arguments rather than in their
// contract. Declared here, next to the rules, so every consumer asks the same
// question of the same set — a second hand-maintained copy is how one caller
// ends up enforcing a rule the other does not.
export const SHELL_CAPABILITIES = Object.freeze(new Set([
  "command.run",
  "developer.command.run",
  "cli.exec",
  "cli.execute"
]));

// Commands that cannot be undone, that turn off a protection, or that hand
// control to content fetched from the network. Matched against the whole
// command line, case-insensitively.
//
// Each entry carries the reason a person would give for refusing, because that
// reason is what the user reads — "blocked by rule 7" tells them nothing about
// whether the agent understood them.
// Every way to delete something that this codebase has actually seen used,
// including the ones reached for AFTER a refusal: cmd's rmdir, the .NET API, and
// a delete handed to an elevated process. Order does not matter — a delete verb
// anywhere in the line counts, so a pipe cannot separate the verb from its
// target and slip between them.
const DELETE_VERB = /\b(?:remove-item|ri|rmdir|rd|del|erase|rm|remove-childitem)\b|\[(?:system\.)?io\.(?:directory|file)\]::delete|\bdirectory\.delete\b|\bunlink\b/i;

// A path that IS one of these, rather than one that merely lives under one.
// `C:\Users\hithe\Documents\report.docx` is somebody's file and deleting it is an
// ordinary thing to ask for; `C:\Users\hithe` is their entire profile.
//
// The trailing lookahead is what draws that line: the path has to END at the
// protected root (optionally with a trailing slash or wildcard), followed by a
// quote, whitespace, a separator, or the end of the line.
//
// BOTH SEPARATORS. Windows accepts `C:/Windows` exactly as it accepts
// `C:\Windows`, and PowerShell runs either without complaint — so a floor that
// only knew about backslashes let `Remove-Item C:/Windows -Recurse -Force`
// straight through. Found by writing the eval task for it, before the task was
// ever run.
const SEP = String.raw`[\\/]`;
const PROTECTED_ROOT = new RegExp([
  // A bare drive: C:, C:\, C:/, C:\*
  String.raw`[a-z]:${SEP}?\*?(?=["'\s;,)]|$)`,
  // Windows itself, AND anything inside it. Unlike the others this does not have
  // to end at the root: `C:\Windows\System32` is not a folder somebody is
  // tidying up, and neither is anything else under there.
  String.raw`[a-z]:${SEP}(?:windows|winnt)(?:${SEP}[^"'\s;,)]*)?(?=["'\s;,)]|$)`,
  // The rest are denied as roots only — deleting `C:\Program Files\SomeApp` is a
  // clumsy uninstall, not an attack on the machine, and it still has to be
  // confirmed by the CONFIRM table below.
  String.raw`[a-z]:${SEP}(?:program files(?: \(x86\))?|programdata|users|system32)${SEP}?\*?(?=["'\s;,)]|$)`,
  // One whole user profile: C:\Users\<name>, but not C:\Users\<name>\anything.
  String.raw`[a-z]:${SEP}users${SEP}[^\\/"'\s;,)]+${SEP}?\*?(?=["'\s;,)]|$)`,
  // The same places by the names Windows itself uses for them.
  String.raw`%(?:systemroot|windir|systemdrive|userprofile|homepath)%`,
  String.raw`\$env:(?:systemroot|windir|systemdrive|userprofile|homepath)\b`,
  // POSIX shapes, for the shells that accept them.
  String.raw`(?:^|\s)[/~]\*?(?=\s|$)`
].join("|"), "i");

const DENY_RULES = Object.freeze([
  {
    id: "disk-format",
    // `\bformat\b` also matches `Format-Table` and `Format-List`, which are how
    // PowerShell prints things — so the two most common ways to READ anything
    // were refused as disk formatting. A DENY rule that fires on `Get-PSDrive |
    // Format-Table` is worse than no rule: it makes the refusals meaningless.
    // Anchored instead on the forms that actually format: `Format-Volume`, and
    // cmd's `format` with a drive letter.
    pattern: /\b(?:format-volume|diskpart|clear-disk|initialize-disk|new-partition|set-partition|remove-partition)\b|\bformat(?:\.com)?\s+[a-z]:/i,
    reason: "it formats or repartitions a disk, which destroys everything on it"
  },
  {
    id: "boot-configuration",
    pattern: /\b(bcdedit|bootrec|bcdboot)\b/i,
    reason: "it rewrites the boot configuration, which can leave the machine unbootable"
  },
  {
    id: "recursive-root-delete",
    // A delete aimed at a drive root, the folder holding every profile, a user's
    // whole profile, or a Windows system directory.
    //
    // THIS RULE WAS BACKWARDS, AND IT TAUGHT THE MODEL TO ROUTE AROUND IT.
    //
    // It matched `C:\users` ANYWHERE in the path, so deleting one file in your
    // own Documents was refused as "deleting a drive root" — and because it
    // required the path to follow the verb, `Get-ChildItem <path> | Remove-Item`
    // sailed straight through, as did `[System.IO.Directory]::Delete(<path>)`.
    // It refused the safe, direct, readable form and permitted the two most
    // dangerous ones.
    //
    // Live, that is exactly what happened: refused, tried cmd's rmdir, refused,
    // tried the pipe — which worked — then tried `-Verb RunAs` and the .NET API.
    // Four attempts to get around a refusal, two of them successful. A gate that
    // refuses arbitrary things trains the thing it is gating to evade it.
    //
    // Now: the verb and the target are matched INDEPENDENTLY, anywhere in the
    // command, and the target must BE a root rather than merely live under one.
    match: (commandLine) => DELETE_VERB.test(commandLine) && PROTECTED_ROOT.test(commandLine),
    reason: "it deletes a drive root, a whole user profile, or a Windows system directory"
  },
  {
    id: "shadow-copy-delete",
    pattern: /\bvssadmin\b[^\n]*\bdelete\b|\bwbadmin\b[^\n]*\bdelete\b/i,
    reason: "it deletes the shadow copies and backups the machine would be restored from"
  },
  {
    id: "secure-wipe",
    pattern: /\bcipher\b[^\n]*\/w|\bsdelete\b|\bformat\b[^\n]*\/p:/i,
    reason: "it securely wipes free space or files so they cannot be recovered"
  },
  {
    id: "security-control-disable",
    pattern: /set-mppreference\b[^\n]*\bdisable\w*\s*\$?true|\bnetsh\b[^\n]*\badvfirewall\b[^\n]*\boff\b|disable-windowsoptionalfeature\b[^\n]*defender|\bsc\b[^\n]*\bconfig\b[^\n]*\b(windefend|wscsvc|mpssvc)\b/i,
    reason: "it disables Windows Defender or the firewall"
  },
  {
    id: "remote-code-execution",
    // Fetch-and-run: the classic `iwr … | iex`, `curl … | sh`, and the
    // DownloadString form. What runs is decided by a server, not by the user.
    pattern: /(?:invoke-webrequest|invoke-restmethod|iwr|irm|curl|wget)\b[^\n|]*\|\s*(?:iex|invoke-expression|powershell|pwsh|cmd|sh|bash)\b|downloadstring\s*\([^)]*\)\s*\)?\s*(?:\||;)?\s*(?:iex|invoke-expression)|\biex\s*\(\s*(?:new-object|iwr|irm)/i,
    reason: "it downloads code from the internet and executes it, so what runs is decided by a remote server"
  },
  {
    id: "registry-hive-delete",
    pattern: /\breg(?:\.exe)?\s+delete\b[^\n]*\bhk(?:lm|ey_local_machine|cr|ey_classes_root)\b|remove-item\b[^\n]*\bhklm:/i,
    reason: "it deletes a machine-wide registry hive key"
  },
  {
    id: "account-removal",
    pattern: /\bnet\s+user\b[^\n]*\/delete\b|\bremove-localuser\b|\bnet\s+localgroup\b[^\n]*administrators[^\n]*\/delete\b/i,
    reason: "it deletes a user account or removes an administrator"
  },
  // Shutting down and restarting used to be refused here, and weakening the
  // PowerShell execution policy with them. Neither is irrecoverable: the machine
  // boots again, and the policy can be set back — and "restart my computer" is
  // an ordinary thing to ask an assistant to do. A floor that catches ordinary
  // requests is not a floor, it is a wall in the wrong place. What stays below
  // is only what no approval could make recoverable.
  {
    id: "fork-bomb",
    pattern: /:\(\)\s*\{.*\}\s*;\s*:|%0\s*\|\s*%0/i,
    reason: "it is a fork bomb and would exhaust the machine's process table"
  }
]);

// Command lines that only read. Every entry must be verifiably side-effect-free
// on its own — anything that merely *usually* reads belongs in ASK.
//
// Matched against the FIRST verb of each segment of the line, so a pipeline is
// only allowed when every stage of it is.
const READ_ONLY_VERBS = new Set([
  // PowerShell readers
  "get-process", "get-service", "get-childitem", "get-item", "get-content",
  "get-location", "get-date", "get-host", "get-command", "get-help",
  "get-module", "get-psdrive", "get-volume", "get-disk", "get-partition",
  "get-computerinfo", "get-hotfix", "get-eventlog", "get-winevent",
  "get-netadapter", "get-netipaddress", "get-nettcpconnection", "get-dnsclientcache",
  "get-localuser", "get-localgroup", "get-scheduledtask", "get-timezone",
  "get-culture", "get-uiculture", "get-executionpolicy", "get-package",
  "get-appxpackage", "get-wmiobject", "get-ciminstance", "get-itemproperty",
  "get-filehash", "get-acl", "get-random", "get-variable", "get-alias",
  "get-history", "get-job", "get-counter", "get-clipboard", "get-error",
  "test-path", "test-connection", "test-netconnection", "resolve-path",
  "measure-object", "compare-object", "select-object", "sort-object",
  "where-object", "group-object", "format-list", "format-table", "out-string",
  "convertto-json", "convertfrom-json", "select-string", "join-path", "split-path",
  // cmd / unix-shaped readers
  "dir", "ls", "gci", "type", "cat", "gc", "echo", "write-output", "write-host",
  "pwd", "cd", "where", "which", "whoami", "hostname", "date", "time",
  "systeminfo", "ver", "vol", "tree", "find", "findstr", "fc", "comp",
  "tasklist", "ipconfig", "netstat", "nslookup", "ping", "tracert", "arp",
  "route", "getmac", "driverquery", "assoc", "ftype", "set", "path",
  "wc", "head", "tail", "sort", "more", "less",
  // developer tooling, read-only invocations only (subcommands checked below)
  "git", "npm", "node", "python", "python3", "py", "pip", "dotnet", "java", "javac",
  "go", "cargo", "rustc", "docker", "kubectl", "winget", "code", "gh", "curl", "wget"
]);

// For tools whose safety depends entirely on the subcommand, the allow-list is
// on the subcommand rather than the tool. `git status` reads; `git push` does
// not, and both start with `git`.
const READ_ONLY_SUBCOMMANDS = Object.freeze({
  git: new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse",
    "describe", "config", "blame", "shortlog", "ls-files", "ls-remote", "tag",
    "stash", "count-objects", "check-ignore", "whatchanged", "reflog", "version"]),
  npm: new Set(["ls", "list", "view", "info", "show", "outdated", "config",
    "root", "prefix", "bin", "search", "ping", "why", "version", "-v", "--version"]),
  pip: new Set(["list", "show", "freeze", "check", "config", "--version", "-V"]),
  dotnet: new Set(["--info", "--version", "--list-sdks", "--list-runtimes"]),
  docker: new Set(["ps", "images", "info", "version", "inspect", "logs", "stats",
    "port", "top", "history", "diff"]),
  kubectl: new Set(["get", "describe", "logs", "explain", "version", "config",
    "cluster-info", "api-resources", "top"]),
  winget: new Set(["search", "show", "list", "source", "--version", "-v"]),
  go: new Set(["version", "env", "list", "vet"]),
  cargo: new Set(["--version", "-V", "tree", "metadata", "search"]),
  gh: new Set(["pr", "issue", "repo", "run", "auth", "api", "--version"]),
  // A bare `curl`/`wget` that only fetches to stdout reads; one that writes a
  // file or pipes into a shell does not, and the DENY rules and the write-flag
  // check below catch those.
  curl: null,
  wget: null,
  node: null,
  python: null,
  python3: null,
  py: null,
  java: null,
  javac: null,
  rustc: null,
  code: null
});

// These executables only become read-only when they are asked for help or a
// version. Running a script is arbitrary code execution; previously the `null`
// entry above accidentally allowed `python cleanup.py` and `node task.js` while
// still prompting for the harmless Windows `py --version` launcher.
const VERSION_ONLY_VERBS = new Set([
  "node", "python", "python3", "py", "java", "javac", "rustc", "code"
]);

// Flags that turn an otherwise-reading command into one that writes.
const WRITE_FLAGS = /(?:^|\s)(?:-o|--output|-O|--remote-name|>>?|--write|--in-place|-i\b)/i;

// Interpreters given inline code are unbounded: `node -e "<anything>"` can do
// whatever the argument says, so the verb tells us nothing about what runs.
const INLINE_CODE = /(?:^|\s)(?:-e|-c|--eval|--command|-exec|--exec|-Command|-EncodedCommand|--interactive)\b/i;

function firstVerb(segment) {
  const trimmed = String(segment ?? "").trim().replace(/^[({\s]+/, "");
  const match = trimmed.match(/^([^\s;|&]+)/);
  if (!match) return "";
  // Strip a path prefix and an .exe suffix so `C:\Program Files\Git\bin\git.exe`
  // is recognised as `git`.
  return match[1]
    .replace(/^["']|["']$/g, "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.(exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
}

const VERSION_OR_HELP_FLAG = /^(?:-{1,2}(?:v|version|h|help|\?|info)|\/(?:\?|version))$/i;

function isVersionOrHelpOnly(segment) {
  const parts = String(segment ?? "").trim().split(/\s+/).slice(1);
  return parts.length > 0 && parts.every((part) => VERSION_OR_HELP_FLAG.test(part));
}

function subcommandOf(segment) {
  const parts = String(segment ?? "").trim().split(/\s+/).slice(1);
  return (parts.find((part) => !part.startsWith("-")) ?? parts[0] ?? "").toLowerCase();
}

// Split a command line into the segments that will each execute. Anything
// joined by `;`, `|`, `&&` or `||` runs, so every segment must clear the bar —
// otherwise `Get-Process | Remove-Item` reads as a read.
//
// The split has to respect quoting and nesting. A naive split on the separator
// characters tears PowerShell's calculated properties in half:
//
//   Get-PSDrive | Select-Object @{Name='FreeGB';Expression={$_.Free/1GB}}
//
// splits at the `;` INSIDE the hash literal, producing a fragment beginning
// `Expression={...}` whose first word is not a command at all — so a perfectly
// ordinary read was classified as needing approval, and in read-only mode was
// rejected outright. That is a false failure of exactly the kind this codebase
// keeps paying for: correct work discarded by a check measuring the wrong thing.
function segmentsOf(commandLine) {
  const text = String(commandLine ?? "");
  const segments = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "{" || character === "(" || character === "[") depth += 1;
    else if (character === "}" || character === ")" || character === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && (character === ";" || character === "|" || character === "&")) {
      // `||` and `&&` are two characters for one separator.
      if (text[index + 1] === character) index += 1;
      segments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/**
 * Classify a command line.
 *
 * @param {string} command   the command, or the whole command line
 * @param {string[]} args    argv when the caller already separated them
 * @returns {{verdict: string, rule: string|null, reason: string}}
 */
export function classifyShellCommand(command, args = []) {
  const commandLine = [String(command ?? ""), ...(args ?? []).map(String)].join(" ").trim();
  if (!commandLine) {
    return { verdict: ShellVerdict.ASK, rule: null, reason: "The command is empty." };
  }

  // DENY is checked against the whole line first, and it wins outright. A
  // denied fragment anywhere in a pipeline denies the pipeline.
  for (const rule of DENY_RULES) {
    // Most rules are a single pattern. One needs two independent conditions —
    // see recursive-root-delete — because requiring them in one expression is
    // what let a pipe separate the verb from its target.
    const denied = rule.match ? rule.match(commandLine) : rule.pattern.test(commandLine);
    if (denied) {
      return {
        verdict: ShellVerdict.DENY,
        rule: rule.id,
        reason: `I won't run this command because ${rule.reason}. If you want it run, please run it yourself.`
      };
    }
  }

  const segments = segmentsOf(commandLine);
  for (const segment of segments) {
    const verb = firstVerb(segment);
    if (!READ_ONLY_VERBS.has(verb)) {
      return {
        verdict: ShellVerdict.ASK,
        rule: "not-a-known-read",
        reason: `\`${verb || segment}\` is not on the list of commands known to only read, so it needs your approval.`
      };
    }
    // An interpreter handed inline code runs whatever that code says.
    if (INLINE_CODE.test(segment)) {
      return {
        verdict: ShellVerdict.ASK,
        rule: "inline-code",
        reason: `\`${verb}\` is being given code to run inline, so what it does cannot be read from the command name.`
      };
    }
    if (WRITE_FLAGS.test(segment)) {
      return {
        verdict: ShellVerdict.ASK,
        rule: "write-flag",
        reason: `\`${segment.trim()}\` writes its output to a file.`
      };
    }
    const allowedSubcommands = READ_ONLY_SUBCOMMANDS[verb];
    // Asking a tool its version or its help text reads, whatever the tool is,
    // and every tool spells it differently (`git --version`, `docker -v`,
    // `dotnet --info`). Enumerating that per tool is how `git --version` — the
    // single most common way to check whether something is installed — ended up
    // needing approval.
    if (isVersionOrHelpOnly(segment)) continue;
    if (VERSION_ONLY_VERBS.has(verb)) {
      return {
        verdict: ShellVerdict.ASK,
        rule: "interpreter-execution",
        reason: `\`${verb}\` is being asked to run code rather than only report its version, so it needs your approval.`
      };
    }
    if (allowedSubcommands) {
      const subcommand = subcommandOf(segment);
      if (!allowedSubcommands.has(subcommand)) {
        return {
          verdict: ShellVerdict.ASK,
          rule: "not-a-known-read-subcommand",
          reason: `\`${verb} ${subcommand}\` is not one of the ${verb} subcommands known to only read, so it needs your approval.`
        };
      }
    }
  }

  return {
    verdict: ShellVerdict.ALLOW,
    rule: "read-only",
    reason: "Every part of this command only reads state."
  };
}

// Convenience predicate for callers that only care whether a command may run
// without being seen.
export function isReadOnlyShellCommand(command, args = []) {
  return classifyShellCommand(command, args).verdict === ShellVerdict.ALLOW;
}

// INSTALLING AN APPLICATION HAS NOTHING TO DO WITH HAVING A PROJECT FOLDER OPEN.
//
// The workspace gate in the toolset refuses any command that is not read-only
// when no folder is attached, and tells the user to attach one. For a developer
// terminal scoped to a project that is exactly right. For "install Quick Share"
// it is a non-sequitur, and it is expensive: measured live, 29 Aug 2026, the two
// refused `winget` calls pushed the whole request down the Store GUI instead —
// 21 steps, 99.5s, and it hit the 150,000-token ceiling before the install
// finished. The same install through `winget install --id` is about three steps.
//
// The bill is almost entirely the STEPS, not the work: tool output across all 21
// calls was 5,624 tokens, under 4% of what was spent. A round trip costs ~7,000
// billed tokens on this endpoint whatever it does.
//
// SO THIS IS AN EXEMPTION FROM THE FOLDER REQUIREMENT, NOT FROM SAFETY. The
// command still goes through DENY, still goes through the CONFIRM table, and
// still goes through the ask-mode boundary. All that changes is that not having
// a project attached stops being a reason to refuse an install.
//
// NARROW ON PURPOSE, AND ANCHORED. The whole command must be one package-manager
// install and nothing else. A shell separator anywhere means this returns false,
// so `winget install x; Remove-Item -Recurse C:\` is not an install as far as
// this is concerned — it is whatever the rest of the rules make of it.
//
// `uninstall` is deliberately absent: it has its own CONFIRM rule above, and
// removing an application is the unrecoverable direction.
const PACKAGE_INSTALL = /^\s*(?:winget|choco|scoop)(?:\.exe)?\s+(?:install|upgrade|update)\b/i;
// Anything that could chain, redirect or expand into a second command. Checked
// against the raw string rather than parsed, because the question is only "is
// this one plain install", and anything unusual answers no.
const SHELL_COMPOSITION = /[;&|><`$\n\r]|\$\(|\(\s*\)/;

export function isPackageInstall(command, args = []) {
  const whole = [String(command ?? ""), ...args.map((arg) => String(arg ?? ""))].join(" ");
  if (!PACKAGE_INSTALL.test(whole)) return false;
  if (SHELL_COMPOSITION.test(whole)) return false;
  // A DENY is a DENY. This exemption may never be the thing that lets one past.
  return classifyShellCommand(command, args).verdict !== ShellVerdict.DENY;
}

// THE THINGS WORTH ONE CLICK.
//
// ALLOW/ASK/DENY above describes the whole space, and the agent loop enforces
// only DENY: everything else runs immediately, which is the entire reason it is
// fast. Enforcing ASK as written would be correct and unusable — ASK is the
// DEFAULT for anything that changes anything, so installing an application,
// creating a file or changing a setting the user just asked for would each stop
// and wait. An assistant that asks permission to do what it was told to do is
// not an assistant.
//
// This is the narrow middle. Not "does it change something" — almost everything
// does — but "if this is not what they meant, is it gone for good?" Deleting
// somebody's files, removing an application, rewriting machine-wide registry
// state, disabling a service, adding a scheduled task, turning the computer off,
// changing an account, force-pushing over a branch. Each is one click to approve
// and unrecoverable to get wrong, and none of them is something an ordinary
// request produces by accident.
//
// Everything else — installs, writes, launches, settings, clicks, typing —
// stays exactly as fast as it is now.
const CONFIRM_RULES = Object.freeze([
  {
    id: "persistent-user-environment",
    pattern: /\[Environment\]::SetEnvironmentVariable\s*\([^)]*,\s*['"]User['"]\s*\)|\bsetx(?:\.exe)?\s+\S/i,
    summary: "change your persistent user environment",
    reason: "user environment changes such as PATH affect future applications and remain after SYSCORA closes"
  },
  {
    id: "delete-files",
    // A delete of a drive root is already DENIED. This is the ordinary delete: a
    // file, a folder, a wildcard. Reversible only if the recycle bin happens to
    // catch it, which for PowerShell's Remove-Item it does not.
    //
    // Every route counts, not just the readable one. Asking about `Remove-Item`
    // while letting `[System.IO.Directory]::Delete` past would make the question
    // a formality — and the model has already been observed reaching for exactly
    // that after a refusal.
    pattern: new RegExp([
      String.raw`(?:^|[;|&(]\s*)(?:remove-item|ri\b|del|erase|rd|rmdir|rm)\s+(?!-{0,2}(?:help|\?))\S`,
      String.raw`\|\s*remove-item\b`,
      String.raw`\[(?:system\.)?io\.(?:directory|file)\]::delete\s*\(`,
      String.raw`\bstart-process\b[^\n]*\b(?:rmdir|remove-item|del|erase)\b`
    ].join("|"), "i"),
    summary: "delete files or folders",
    reason: "deleting is not undoable — PowerShell's Remove-Item does not use the recycle bin"
  },
  {
    id: "uninstall-application",
    pattern: /\bwinget\s+uninstall\b|\buninstall-package\b|\bmsiexec\b[^\n]*\/x|\bremove-appxpackage\b/i,
    summary: "remove an installed application",
    reason: "the application and anything it keeps locally would have to be reinstalled and set up again"
  },
  {
    id: "machine-registry-write",
    pattern: /\breg(?:\.exe)?\s+(?:add|delete|import)\b[^\n]*\bhk(?:lm|ey_local_machine|cr|ey_classes_root)\b|(?:set|new|remove)-item(?:property)?\b[^\n]*\bhklm:/i,
    summary: "change machine-wide registry settings",
    reason: "this changes Windows for every account on the machine, and there is no undo"
  },
  {
    id: "service-change",
    pattern: /\b(?:stop-service|set-service|remove-service)\b|\bsc(?:\.exe)?\s+(?:config|stop|delete)\b|\bnet\s+stop\b/i,
    summary: "stop or reconfigure a Windows service",
    reason: "something on the machine depends on it, and a stopped service does not come back on its own"
  },
  {
    id: "kill-process",
    // THE TABLE GUARDED STOPPING A SERVICE AND NOT KILLING A PROCESS, WHICH IS
    // THE SAME ACT WITH A WORSE BLAST RADIUS.
    //
    // Observed live, 21 Aug 2026. Asked why the machine felt slow, the agent
    // correctly found OneDrive pegged at 97% of a core, and — with no gate in
    // its way — ran `Stop-Process -Name OneDrive -Force` followed by a
    // Start-Process against `$env:LOCALAPPDATA\Microsoft\OneDrive\OneDrive.exe`,
    // a path that does not exist on this machine. The real one was in a reading
    // it had taken two steps earlier. The user's file sync stayed dead, and the
    // repository this product is built in lives inside that OneDrive folder.
    //
    // A process is not a service: nothing restarts it, and whatever was unsaved
    // in it is gone. `close_app` is the ordinary route for "shut Spotify" and is
    // untouched by this — the pattern is deliberately anchored to the shell
    // verbs, so asking to close an application stays exactly as fast as it was.
    // ANCHORED TO COMMAND POSITION, because `kill` is an ordinary English word
    // and PowerShell also happens to alias it to Stop-Process. The first draft
    // of this rule was `\b(?:stop-process|kill)\b`, and the test below caught it
    // asking permission for `git commit -m 'kill the old build step'`. A gate
    // that fires on a commit message gets switched off, and then it is not
    // guarding the thing it was written for either.
    pattern: new RegExp([
      String.raw`(?:^|[;|&(]\s*)(?:stop-process|kill)\b`,
      String.raw`\|\s*stop-process\b`,
      String.raw`(?:^|[;|&(]\s*)taskkill(?:\.exe)?\s+\S`
    ].join("|"), "i"),
    summary: "force a running program to quit",
    reason: "anything unsaved in it is lost, and nothing starts it again on its own — a failed restart leaves it dead"
  },
  {
    id: "scheduled-task",
    pattern: /\b(?:register|unregister|set)-scheduledtask\b|\bschtasks(?:\.exe)?\s+\/(?:create|delete|change)\b/i,
    summary: "add or change something that runs automatically",
    reason: "a scheduled task keeps running long after this conversation, on its own"
  },
  {
    id: "power-state",
    pattern: /\b(?:stop-computer|restart-computer)\b|\bshutdown(?:\.exe)?\s+\/[rsh]\b/i,
    summary: "shut down or restart the computer",
    reason: "anything unsaved in any open application goes with it"
  },
  {
    id: "account-change",
    pattern: /\bnet\s+user\b[^\n]*\s\S|\b(?:new|set|remove)-localuser\b|\b(?:add|remove)-localgroupmember\b/i,
    summary: "change a Windows account",
    reason: "account and password changes can lock the user out of their own machine"
  },
  {
    id: "destructive-git",
    pattern: /\bgit\b[^\n]*\bpush\b[^\n]*(?:--force(?!-with-lease)|(?:^|\s)-f(?:\s|$))|\bgit\b[^\n]*\breset\b[^\n]*--hard|\bgit\b[^\n]*\bclean\b[^\n]*-[a-z]*f/i,
    summary: "discard or overwrite work in a git repository",
    reason: "committed work and uncommitted changes are lost, locally or on the remote"
  },
  {
    id: "firewall-change",
    pattern: /\bnetsh\b[^\n]*\badvfirewall\b[^\n]*\bset\b|\bset-netfirewall(?:profile|rule)\b|\bnew-netfirewallrule\b/i,
    summary: "change the firewall",
    reason: "firewall rules decide what can reach this machine"
  }
]);

// THE GATE WAS ON THE WRONG THINGS.
//
// Everything above guards the terminal. Meanwhile the same agent, in one
// session, sent a WhatsApp message to the wrong person twice and clicked "Delete
// for everyone" twice — and was asked about none of it, while being asked
// whether it could delete an empty leftover folder. A shell delete is usually
// recoverable from somewhere. A message to somebody's mother is not.
//
// Deliberately tiny. Not "anything that changes something" — clicking, typing,
// scrolling and opening stay untouched and exactly as fast. Only the controls
// that push something OUT, to another person, irreversibly.
const IRREVERSIBLE_CONTROLS = Object.freeze([
  {
    id: "delete-for-everyone",
    pattern: /^\s*(?:delete for everyone|delete for me|unsend|remove for everyone|delete chat|clear chat|empty chat|delete message|delete account|deactivate account)\s*$/i,
    summary: "delete this for everyone",
    reason: "it removes the message from the other person's phone too, and cannot be put back"
  },
  {
    id: "send-outward",
    // The button forms. Enter-to-send is handled separately, by the app it is
    // being pressed in — see requiresSendConfirmation.
    // A bare Share control opens a chooser/submenu; it has not sent anything
    // yet. Gating that intermediate menu added a user round trip in Spotify
    // while the actual WhatsApp Send/Enter remained the irreversible boundary.
    pattern: /^\s*(?:send|send message|send now|post|publish|tweet|reply all|send invite)\s*$/i,
    summary: "send this",
    reason: "once it has gone to somebody else it cannot be taken back"
  }
]);

// The applications where pressing Enter sends something to another person. This
// is the WhatsApp case: the text was typed, Enter was pressed, and it went to
// whichever chat happened to be open — which twice was the wrong one.
const MESSAGING_APPS = /whatsapp|telegram|signal|discord|slack|messenger|instagram|teams|outlook|thunderbird|skype|imessage|messages/i;

/**
 * Is this click on a control that pushes something out irreversibly?
 *
 * Matched on the WHOLE label, anchored, so "Delete for everyone" asks and
 * "More options for Kalank - Title Track Add to Liked Songs" does not.
 */
export function requiresClickConfirmation(label) {
  const text = String(label ?? "").trim();
  if (!text) return { confirm: false };
  for (const control of IRREVERSIBLE_CONTROLS) {
    if (control.pattern.test(text)) {
      return { confirm: true, rule: control.id, summary: control.summary, reason: control.reason };
    }
  }
  return { confirm: false };
}

/**
 * Is this keystroke the one that sends a message?
 *
 * Enter in a text editor is a newline; Enter in WhatsApp is irreversible. The
 * difference is the application, so that is what this asks about.
 */
export function requiresSendConfirmation(key, application) {
  if (!/^(?:enter|return)$/i.test(String(key ?? "").trim())) return { confirm: false };
  if (!MESSAGING_APPS.test(String(application ?? ""))) return { confirm: false };
  return {
    confirm: true,
    rule: "send-message",
    summary: "send this message",
    reason: "it goes to whichever conversation is open on screen — check that it is the right one — " +
      "and it cannot be unsent once it arrives"
  };
}

/**
 * Does this command need one click before it runs?
 *
 * Returns `{ confirm: false }` for the overwhelming majority, including every
 * read and every ordinary mutation. Matching is on the whole command line, so a
 * destructive fragment anywhere in a pipeline counts.
 *
 * @returns {{confirm: boolean, rule?: string, summary?: string, reason?: string}}
 */
export function requiresConfirmation(command, args = []) {
  const commandLine = [String(command ?? ""), ...(args ?? []).map(String)].join(" ").trim();
  if (!commandLine) return { confirm: false };
  for (const rule of CONFIRM_RULES) {
    if (rule.pattern.test(commandLine)) {
      return { confirm: true, rule: rule.id, summary: rule.summary, reason: rule.reason };
    }
  }
  return { confirm: false };
}
