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
    // A recursive delete aimed at a drive root, a user profile root, or a
    // Windows system directory. A recursive delete of a project folder is an
    // ordinary thing to want, so this is deliberately anchored on the target.
    pattern: /(?:remove-item|rd|rmdir|del|erase|rm)\b[^\n]*?(?:[a-z]:\\?(?:\s|$|\*)|[a-z]:\\(?:windows|program files|users|programdata)\b|\/(?:\s|$)|~\/?\s*$)/i,
    reason: "it recursively deletes a drive root or a Windows system directory"
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
  "git", "npm", "node", "python", "python3", "pip", "dotnet", "java", "javac",
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
  java: null,
  javac: null,
  rustc: null,
  code: null
});

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
    if (rule.pattern.test(commandLine)) {
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
    if (allowedSubcommands && isVersionOrHelpOnly(segment)) continue;
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
