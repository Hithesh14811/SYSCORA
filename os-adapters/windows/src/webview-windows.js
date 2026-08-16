// THE WINDOW NAMED AFTER THE APPLICATION IS NOT ALWAYS THE APPLICATION.
//
// Measured on this machine, 15 Aug 2026, with WhatsApp open on a chat:
//
//   WhatsApp.Root   "WhatsApp"        hwnd 198130   6 elements   Minimize/Restore/Close
//   msedgewebview2  "(139) WhatsApp"  hwnd 197286  90 elements   the entire application
//
// Two unrelated TOP-LEVEL windows — no parent, no owner, no HWND relationship at
// all. Asking to read "whatsapp" scores the process name, lands on WhatsApp.Root,
// and gets back the three caption buttons. That single fact is behind every
// WhatsApp failure on record: names truncated to "Chi...", an emoji button hunted
// across 48 steps and 692,000 tokens, an input box indistinguishable from a sent
// bubble. The tree was never missing. We were reading the frame.
//
// The second window publishes, right now and with no launch flag: "Attach",
// "Emojis, GIFs, Stickers", "Voice message", Edit "Type a message to +91 …", and
// every chat name in full with its unread count.
//
// The only thing tying the two together is PROCESS PARENTAGE — msedgewebview2
// 23468 is a child of WhatsApp.Root 21256. So that is what this matches on. A
// title or a process-name rule would put any Chromium window under any
// application that happened to share a word with it, which is how "click the
// button in Chrome" ends up in somebody's Slack.

// Processes that host somebody else's user interface. Matching the process name
// alone is NOT enough — a candidate must additionally descend from the frame's
// own process.
const WEBVIEW_HOST_PROCESS = /^(msedgewebview2|electron)$/i;

/**
 * Is this process one that renders somebody else's page?
 *
 * Exported because perception is not the only thing that needs to know. The
 * gate protecting a user's unsaved work reads a rendered page's Document
 * control as a file with work in it, and refused every keystroke aimed at
 * WhatsApp's message box once readings started following into the content
 * window — 42 steps and 599,352 tokens for a message that never went.
 */
export function isWebviewHostProcess(processName) {
  return WEBVIEW_HOST_PROCESS.test(String(processName ?? "").replace(/\.exe$/i, ""));
}

// A BROWSER WINDOW IS ITS OWN APPLICATION, NEVER SOMEBODY'S EMBEDDED CONTENT.
//
// Found by surveying every window on this desktop: `explorer "Program Manager"`
// — the desktop itself, which has an empty tree and covers the whole screen —
// adopted the user's Chrome window as "its content", because Chrome was launched
// from Explorer and so genuinely descends from it. A reading of the desktop
// would have been answered with whatever the user had open in a browser tab.
// Parentage is necessary and not sufficient.
const BROWSER_PROCESS = /^(chrome|msedge|firefox|brave|opera|vivaldi|avastbrowser|avastsecurebrowser|iexplore|arc|librewolf|waterfox)$/i;

// The shell is not an application with an interface hiding somewhere else. Its
// windows have empty trees by nature, which is exactly what triggers the search.
const SHELL_FRAME_PROCESS = /^(explorer|shellexperiencehost|searchhost|startmenuexperiencehost|textinputhost|applicationframehost)$/i;
const SHELL_FRAME_CLASS = /^(Progman|WorkerW|Shell_TrayWnd|Shell_SecondaryTrayWnd|DV2ControlHost)$/i;

// Chromium names its render-widget window class this on every platform build.
// A window carrying it is a Chromium surface whatever the executable is called.
const CHROMIUM_WINDOW_CLASS = /^Chrome_WidgetWin_\d+$/i;

// The content window covers essentially the whole frame: 2880x1704 inside
// 2906x1730, or 97%. Helper windows — hidden drag surfaces, IME candidates,
// tooltips — are tiny. Half the frame separates them with room to spare.
const MIN_COVERAGE = 0.5;

// listWindows() has two shapes depending on whether the persistent host answered
// or the PowerShell fallback did. Normalize once here rather than at four call
// sites, which is how the two spellings of `windowId` got mixed up before.
export function normalizeWindow(window) {
  if (!window) return null;
  const bounds = window.Bounds ?? window.bounds ?? null;
  return {
    windowId: String(window.WindowHandle ?? window.windowId ?? window.handle ?? ""),
    processId: Number(window.Id ?? window.processId ?? window.ProcessId ?? 0),
    processName: String(window.ProcessName ?? window.processName ?? ""),
    title: String(window.MainWindowTitle ?? window.title ?? ""),
    className: String(window.ClassName ?? window.className ?? ""),
    bounds: bounds && Number.isFinite(Number(bounds.width))
      ? { x: Number(bounds.x), y: Number(bounds.y), width: Number(bounds.width), height: Number(bounds.height) }
      : null
  };
}

// Is `pid` this process, or a descendant of it? WebView2 sits one level down,
// but an application that launches its content through a broker or a stub sits
// deeper, and the walk is cheap. The depth bound is what stops a corrupt or
// recycled parent map spinning forever.
export function descendsFrom(pid, ancestorPid, parentOf, maxDepth = 6) {
  let current = Number(pid);
  const ancestor = Number(ancestorPid);
  if (!Number.isFinite(current) || !Number.isFinite(ancestor)) return false;
  const seen = new Set();
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (current === ancestor) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const parent = Number(parentOf?.get?.(current) ?? parentOf?.[current]);
    if (!Number.isFinite(parent) || parent <= 0) return false;
    current = parent;
  }
  return false;
}

function area(bounds) {
  return bounds ? Math.max(0, bounds.width) * Math.max(0, bounds.height) : 0;
}

// How much of `inner` lies on top of `outer`, 0 to 1.
//
// THE TIE-BREAK MATTERS AS SOON AS THERE ARE TWO WINDOWS. One process hosts
// every window an application opens, so a second WhatsApp window puts TWO
// content windows under the same parent, both of them legitimately that
// application's. Picking the larger one reads the wrong conversation — and it
// works perfectly on a machine where the user only ever opens one, which is the
// kind of bug that ships. The content window sits exactly on top of its own
// frame, so overlap says which belongs to which.
function overlapFraction(inner, outer) {
  if (!inner || !outer) return 0;
  const width = Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x);
  const height = Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y);
  if (width <= 0 || height <= 0) return 0;
  const self = area(inner);
  return self > 0 ? (width * height) / self : 0;
}

/**
 * The window that actually holds `frameWindowId`'s user interface.
 *
 * Returns null when the frame IS the application — which is the common case, and
 * must stay cheap and silent. Only a Chromium-shaped window belonging to a
 * descendant process, covering most of the frame, is worth redirecting a reading
 * to.
 */
export function pickWebviewWindow({ frameWindowId, windows = [], parentOf = new Map() }) {
  const normalized = windows.map(normalizeWindow).filter(Boolean);
  const frame = normalized.find((window) => window.windowId === String(frameWindowId));
  if (!frame || !frame.processId) return null;
  // The desktop owns every window on it by descent. It is not an application
  // whose interface is somewhere else.
  if (SHELL_FRAME_PROCESS.test(frame.processName) || SHELL_FRAME_CLASS.test(frame.className)) return null;
  const frameArea = area(frame.bounds);

  const candidates = normalized.filter((window) => {
    if (window.windowId === frame.windowId) return false;
    if (window.processId === frame.processId) return false;
    if (BROWSER_PROCESS.test(window.processName)) return false;
    const chromiumShaped = CHROMIUM_WINDOW_CLASS.test(window.className)
      || WEBVIEW_HOST_PROCESS.test(window.processName);
    if (!chromiumShaped) return false;
    if (!descendsFrom(window.processId, frame.processId, parentOf)) return false;
    // A frame with no bounds tells us nothing about coverage; parentage alone
    // has already earned the candidate its place.
    if (frameArea > 0 && area(window.bounds) < frameArea * MIN_COVERAGE) return false;
    return true;
  });

  // The one sitting on this frame, then the largest. Overlap is what separates
  // two windows of the same application; size is what separates the interface
  // from a picture-in-picture or a call window when overlap cannot decide.
  return candidates
    .map((window) => ({ window, overlap: overlapFraction(window.bounds, frame.bounds) }))
    .sort((left, right) =>
      (right.overlap - left.overlap) || (area(right.window.bounds) - area(left.window.bounds)))[0]?.window ?? null;
}

// ---------------------------------------------------------------------------
// The launch flag, for the other half of the desktop.
// ---------------------------------------------------------------------------
//
// WebView2 applications publish their tree unasked. ELECTRON APPLICATIONS DO
// NOT, and no amount of asking from outside changes it. Measured the same day,
// same machine, VS Code launched twice into a throwaway profile:
//
//   no flag                             4 elements     3 named controls
//   --force-renderer-accessibility    157 elements    90 named controls
//
// SYSCORA's own Electron shell reports ZERO elements. The system-wide screen
// reader flag (SPI_SETSCREENREADER) was also tested, set and cleared inside five
// seconds: it moved nothing at all, for WebView2 or otherwise. The launch flag
// is the only lever that works, so it has to go on at launch — which is exactly
// why it belongs here, where SYSCORA starts applications itself, and why an
// application the user already opened cannot be improved without asking them
// first for a restart.
//
// Gated to a known list on purpose. The flag is a Chromium switch; handing it to
// a program that parses its own arguments strictly could stop it starting, and a
// perception improvement that prevents an application launching is not a trade
// worth making silently.
const ELECTRON_APPLICATIONS =
  /^(code|code - insiders|vscode|discord|slack|spotify|teams|ms-teams|notion|obsidian|postman|figma|linear|signal|telegram|element|chatgpt|claude|cursor|windsurf|zed|todoist|trello|whatsapp desktop)$/i;

export const ACCESSIBILITY_LAUNCH_FLAG = "--force-renderer-accessibility";

/**
 * Extra arguments to start `target` with so its interface can be read.
 *
 * `kind` matters: a packaged Start-menu application is activated through the
 * shell by AppUserModelId and never sees an argument list, so offering one there
 * would be a lie. Those are the WebView2 apps in practice, which need no flag.
 */
export function accessibilityLaunchArgs({ application = "", target = "", kind = "" } = {}) {
  if (kind === "start-menu") return [];
  const name = String(application).trim().toLowerCase();
  const stem = String(target).split(/[\\/]/).pop()?.replace(/\.exe$/i, "").trim().toLowerCase() ?? "";
  if (ELECTRON_APPLICATIONS.test(name) || ELECTRON_APPLICATIONS.test(stem)) {
    return [ACCESSIBILITY_LAUNCH_FLAG];
  }
  return [];
}
