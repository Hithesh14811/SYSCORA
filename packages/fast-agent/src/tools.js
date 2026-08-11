// The tools the model actually gets.
//
// The capability registry holds ~90 entries, each with a full contract: risk
// metadata, permission model, modality profiles, reversibility, rollback
// support, availability checks. All of that is real and useful to the machinery
// that schedules and audits a plan — and none of it belongs in a prompt. Sent to
// the model as a catalog it cost thousands of tokens per step to say, in effect,
// "you may click things".
//
// This is the model-facing surface: a short list of verbs a person would
// recognise, each with the two or three arguments it actually takes. The
// implementations underneath are the registry's, unchanged — this file chooses
// which of them to name, what to call them, and how to say the result back in as
// few tokens as it takes to be useful.
//
// The other half of the token budget is on the way back. `screen.read` returns
// 8000 characters of OCR and 240 elements with bounds, source, automationId,
// confidence and timestamps; fed back verbatim every step, the conversation
// doubles in size for each look at the screen. Every tool here renders its
// result as text sized to what the next decision needs.

import { matchesTrackQuery } from "../../capability-registry/src/index.js";

const MAX_OUTPUT_CHARS = 6000;
const MAX_SCREEN_TEXT_CHARS = 2500;
const MAX_ELEMENTS = 60;

function clip(value, max = MAX_OUTPUT_CHARS) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [${text.length - max} more characters]`;
}

function normalizeLabel(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// One line per on-screen element, indexed and de-duplicated.
//
// A screen reading fuses the accessibility tree with the OCR transcript, so a
// button usually appears twice — once as UIA "Nine", once as the OCR line "9"
// sitting on top of it. Both are listed, and the list is long: Calculator alone
// produced sixty entries for thirty-four buttons. Live, the model then picked
// the index next to the one it wanted and pressed 7 for 8, which is how "47 ×
// 89" became "74 × 79". The coordinates were exact; the counting was not.
//
// So: collapse the duplicates, keeping the accessible one because its name is
// what a person would call it, and let the caller click by that name instead of
// by position. The index stays for the things that have no name at all.
// The application's own controls outrank the window's furniture.
//
// The list arrives in accessibility-tree order, which starts at the window and
// works inwards — so on Chrome the first sixty entries were Minimise, Restore,
// Close, Back, Forward, Reload, Home, Bookmark this tab, Extensions, the whole
// bookmarks bar, and the tab strip. The page itself fell past the cut.
//
// Live, that meant the agent searched YouTube, took a reading, and could not see
// a single search result — only Chrome. It concluded the page had not loaded and
// opened the same URL again, four times, until it ran out of steps. The page had
// loaded correctly every time.
const CHROME_FURNITURE = /^(minimi[sz]e|maximi[sz]e|restore|close|back|forward|reload|home|stop|bookmark this tab|extensions|tab groups|all bookmarks|separator|new tab|tab search|view site information|install |open account menu|menu containing hidden bookmarks|saved tab groups|address and search bar)/i;
const STRUCTURAL_ROLES = /^(window|pane|group|document|toolbar|separator|thumb|image)$/i;

function elementRank(element, text) {
  let score = 0;
  if (element.clickable === true) score += 6;
  if (text) score += 2;
  if (element.focused === true) score += 3;
  if (element.enabled === false) score -= 4;
  const role = String(element.role ?? element.controlType ?? "").replace(/^ControlType\./, "");
  if (STRUCTURAL_ROLES.test(role)) score -= 6;
  // Window chrome is reachable when it is genuinely wanted — "close this
  // window" is a real request — but it must never crowd out the content.
  if (CHROME_FURNITURE.test(text)) score -= 10;
  return score;
}

function renderElements(elements, table) {
  const lines = [];
  // Centres already listed, per label. Compared by DISTANCE rather than by a
  // rounded grid key: the OCR line and the UIA control for one button land a
  // pixel or two apart, and two points a pixel apart fall either side of a
  // bucket boundary as often as not.
  const seen = new Map();
  const NEAR_PX = 40;
  const candidates = [];
  for (const [order, element] of elements.entries()) {
    const text = String(element.text ?? element.name ?? "").replace(/\s+/g, " ").trim();
    const bounds = element.bounds ?? element.boundingRect;
    if (!bounds) continue;
    const center = element.center ?? {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2)
    };
    if (!text && element.clickable !== true) continue;
    // Same words, near enough the same place: one thing, listed once.
    if (text) {
      const label = normalizeLabel(text);
      const placed = seen.get(label) ?? [];
      if (placed.some((point) =>
        Math.abs(point.x - center.x) <= NEAR_PX && Math.abs(point.y - center.y) <= NEAR_PX)) continue;
      placed.push(center);
      seen.set(label, placed);
    }
    candidates.push({ element: { ...element, text, center }, text, center, order, rank: elementRank(element, text) });
  }
  // Rank to decide WHAT survives the cut, then restore reading order so the
  // list still describes the screen top-to-bottom rather than by score.
  const kept = candidates
    .sort((left, right) => right.rank - left.rank || left.order - right.order)
    .slice(0, MAX_ELEMENTS)
    .sort((left, right) => left.order - right.order);
  for (const { element, text, center } of kept) {
    const index = table.length;
    table.push(element);
    const role = String(element.role ?? element.controlType ?? "").replace(/^ControlType\./, "");
    lines.push(`${index}| ${role}${text ? ` "${text.slice(0, 80)}"` : ""} @${center.x},${center.y}${element.enabled === false ? " (disabled)" : ""}`);
  }
  return lines;
}

/**
 * Build the model-facing toolset.
 *
 * `registry` supplies the implementations; `adapter` is used directly for the
 * few primitives that have no capability worth the ceremony (moving the pointer,
 * waiting). Returns the OpenAI-format tool definitions plus one execute()
 * entry point.
 */
export function buildToolset({ registry, adapter, basePath = process.cwd() }) {
  // What the last look at the screen found, so a click can name an element
  // rather than a coordinate. Reset by every fresh observation.
  const state = { elements: [], cwd: basePath, lastWindow: null };

  const runCapability = async (name, inputs, options = {}) => {
    const capability = registry.get(name);
    if (!capability) throw new Error(`Unknown capability ${name}`);
    return capability.execute(inputs, options);
  };

  // Resolve a click/type target, in order of how hard it is to get wrong:
  // the element's own label, then its index in the last reading, then a raw
  // coordinate. A name survives the list being re-ordered or re-read; an index
  // does not, and a coordinate survives nothing.
  const resolveTarget = (args) => {
    const wanted = String(args.text ?? "").trim();
    if (wanted) {
      const needle = normalizeLabel(wanted);
      const score = (element) => {
        const candidate = normalizeLabel(element.text);
        if (!candidate) return 0;
        if (candidate === needle) return 4;
        if (candidate.startsWith(needle) || candidate.endsWith(needle)) return 3;
        if (candidate.includes(needle)) return 2;
        return 0;
      };
      const ranked = state.elements
        .map((element) => ({ element, score: score(element) + (element.clickable ? 0.5 : 0) }))
        .filter((entry) => entry.score >= 2)
        .sort((left, right) => right.score - left.score);
      if (ranked.length === 0) {
        throw new Error(`Nothing on screen is labelled "${wanted}". Read the screen again and use a label from it.`);
      }
      const { element } = ranked[0];
      return { x: element.center.x, y: element.center.y, windowId: element.windowId ?? state.lastWindow?.windowId };
    }
    if (Number.isFinite(Number(args.element))) {
      const element = state.elements[Number(args.element)];
      if (!element) throw new Error(`No element ${args.element} in the last screen reading. Call screen again.`);
      return { x: element.center.x, y: element.center.y, windowId: element.windowId ?? state.lastWindow?.windowId };
    }
    if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
      return { x: Math.round(Number(args.x)), y: Math.round(Number(args.y)), windowId: args.windowId };
    }
    throw new Error("Give text (the label from the last screen reading), or element, or x and y.");
  };

  const tools = [
    {
      name: "run",
      description:
        "Run a command line in PowerShell and get back stdout, stderr and the exit code. This is the " +
        "fastest way to do almost anything on Windows — installing software (winget), files, services, " +
        "processes, network, registry, scheduled tasks, opening apps and URLs. Prefer it over clicking.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The full command line, exactly as you would type it" },
          cwd: { type: "string", description: "Working directory (defaults to the last one used)" },
          timeoutMs: { type: "number", description: "Kill the command after this long (default 90000)" }
        },
        required: ["command"]
      },
      preview: (args) => args.command,
      execute: async (args) => {
        if (args.cwd) state.cwd = args.cwd;
        const result = await adapter.executeCommand(state.cwd, args.command, [], {
          timeoutMs: Number(args.timeoutMs) || 90000
        });
        return result;
      },
      render: (result) => {
        if (result.blocked) return `REFUSED: ${result.stderr}`;
        const parts = [];
        if (result.stdout?.trim()) parts.push(clip(result.stdout.trim()));
        if (result.stderr?.trim()) parts.push(`stderr: ${clip(result.stderr.trim(), 1500)}`);
        parts.push(result.timedOut ? "(timed out)" : `exit ${result.exitCode}`);
        return parts.join("\n");
      }
    },
    {
      name: "screen",
      description:
        "Look at the screen: reads a window's visible text (OCR) and lists what is on it, each with a " +
        "label you can click by. Use it to see what is there, to find something to click, and to check " +
        "what an action actually did — a delivered keystroke is not proof anything happened.",
      parameters: {
        type: "object",
        properties: {
          application: { type: "string", description: "Process name, e.g. \"notepad\", \"chrome\". Omit for the foreground window" },
          windowId: { type: "string" }
        },
        required: []
      },
      preview: (args) => args.application ?? "foreground window",
      execute: async (args) => {
        const result = await runCapability("screen.read", { ...args, maxElements: 200 });
        // A reading that found nothing is a dead end unless it says what IS
        // there. Without this the agent's only move is to try the same name
        // again, or relaunch the application it already has open.
        if (!result?.read) {
          const windows = await adapter.listWindows?.().catch(() => []) ?? [];
          result.openWindows = windows
            .filter((window) => {
              const bounds = window.Bounds ?? window.bounds ?? {};
              return String(window.MainWindowTitle ?? window.title ?? "").trim()
                && Number(bounds.width ?? 0) > 10 && Number(bounds.height ?? 0) > 10;
            })
            .slice(0, 20)
            .map((window) => `${window.ProcessName ?? window.processName} — ${String(window.MainWindowTitle ?? window.title).slice(0, 60)} (windowId ${window.WindowHandle ?? window.windowId})`);
        }
        return result;
      },
      render: (result) => {
        if (!result.read) {
          // Whatever was last seen is no longer evidence of anything. Drop it,
          // so a click after a failed reading refuses rather than landing on
          // wherever that control used to be.
          state.elements = [];
          return [
            `Could not read that: ${result.reason ?? "no window resolved"}`,
            result.openWindows?.length
              ? `These windows are open — name one of them, or pass its windowId:\n${result.openWindows.join("\n")}`
              : "No windows are open."
          ].join("\n");
        }
        state.elements = [];
        state.lastWindow = { windowId: result.windowId, application: result.application };
        const lines = renderElements(result.elements ?? [], state.elements);
        return [
          `Window: ${result.application ?? "?"} — ${result.title ?? "?"} (windowId ${result.windowId})`,
          result.visibleText?.trim() ? `Visible text:\n${clip(result.visibleText.trim(), MAX_SCREEN_TEXT_CHARS)}` : null,
          lines.length ? `Elements (index| role "text" @x,y):\n${lines.join("\n")}` : null
        ].filter(Boolean).join("\n\n");
      }
    },
    {
      name: "click",
      description:
        "Click something from the last screen reading. Prefer `text` — the element's exact label — over " +
        "`element` (its index), and use x,y only for a place with no label at all. The window is brought " +
        "to the front first.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The element's label, copied from the last screen reading" },
          element: { type: "number", description: "Its index in the last screen reading" },
          x: { type: "number" },
          y: { type: "number" },
          application: { type: "string" },
          button: { type: "string", enum: ["left", "right"] },
          doubleClick: { type: "boolean" }
        },
        required: []
      },
      preview: (args) => (args.text ? `"${args.text}"` : args.element != null ? `element ${args.element}` : `(${args.x}, ${args.y})`),
      execute: async (args) => {
        const target = resolveTarget(args);
        return runCapability("pointer.clickAt", {
          ...target,
          application: args.application ?? state.lastWindow?.application,
          button: args.button ?? "left",
          doubleClick: args.doubleClick === true
        });
      },
      render: (result) => (result.performed === false
        ? `Click did not land: ${result.reason ?? "unknown"}`
        : `Clicked at ${result.x},${result.y}.`)
    },
    {
      name: "type",
      description: "Type text into whatever has keyboard focus. Click the field first if focus is not already there.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          into: { type: "string", description: "Label of the field to click first, from the last screen reading" },
          element: { type: "number", description: "Index of the field to click first" },
          application: { type: "string" }
        },
        required: ["text"]
      },
      preview: (args) => JSON.stringify(String(args.text).slice(0, 80)),
      execute: async (args) => {
        if (args.into != null || args.element != null) {
          // `into` names the field; `text` is what to type into it, so the
          // target must be resolved from `into` and never from `text`.
          const target = resolveTarget({ text: args.into, element: args.element });
          await runCapability("pointer.clickAt", { ...target, application: args.application ?? state.lastWindow?.application });
        }
        return runCapability("keyboard.type", {
          text: args.text,
          application: args.application ?? state.lastWindow?.application,
          windowId: state.lastWindow?.windowId
        });
      },
      render: (result) => (result.performed === false
        ? `Typing did not complete: ${result.reason ?? "unknown"}`
        : "Typed. Read the screen back if it matters that the text landed.")
    },
    {
      name: "key",
      description:
        "Press a key or a combination, named the way you would say it: \"enter\", \"tab\", \"escape\", " +
        "\"f5\", \"ctrl+s\", \"alt+f4\", \"ctrl+shift+escape\".",
      parameters: {
        type: "object",
        properties: { keys: { type: "string" }, application: { type: "string" } },
        required: ["keys"]
      },
      preview: (args) => args.keys,
      execute: async (args) => runCapability("keyboard.press", {
        keys: args.keys,
        application: args.application ?? state.lastWindow?.application,
        windowId: state.lastWindow?.windowId
      }),
      render: (result) => (result.performed === false ? `Key press failed: ${result.reason ?? "unknown"}` : "Sent.")
    },
    {
      name: "scroll",
      description: "Scroll a window with the mouse wheel. Negative notches scroll down.",
      parameters: {
        type: "object",
        properties: {
          notches: { type: "number" },
          application: { type: "string" },
          untilText: { type: "string", description: "Stop as soon as this text becomes visible" }
        },
        required: ["notches"]
      },
      preview: (args) => `${args.notches} notches`,
      execute: async (args) => runCapability("pointer.wheel", {
        notches: args.notches,
        untilText: args.untilText,
        application: args.application ?? state.lastWindow?.application,
        windowId: state.lastWindow?.windowId
      }),
      render: (result) => {
        if (result.performed === false) return `Scroll failed: ${result.reason ?? "unknown"}`;
        if (result.untilText) {
          return result.stoppedOnText
            ? `Scrolled until "${result.untilText}" came into view.`
            : `Scrolled, but "${result.untilText}" did not appear. Read the screen to see where you are.`;
        }
        return "Scrolled.";
      }
    },
    {
      name: "move_mouse",
      description: "Move the pointer without clicking — to hover, open a submenu, or reveal a tooltip.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Label from the last screen reading" },
          element: { type: "number" },
          x: { type: "number" },
          y: { type: "number" }
        },
        required: []
      },
      preview: (args) => (args.text ? `"${args.text}"` : args.element != null ? `element ${args.element}` : `(${args.x}, ${args.y})`),
      execute: async (args) => {
        const target = resolveTarget(args);
        return adapter.pointerAction("move", { x: target.x, y: target.y });
      },
      render: (result) => (result.performed === false ? "The pointer did not move." : `Pointer at ${result.x},${result.y}.`)
    },
    {
      name: "launch",
      description: "Open an application by name (\"notepad\", \"spotify\", \"chrome\") and wait for its window.",
      parameters: {
        type: "object",
        properties: { application: { type: "string" } },
        required: ["application"]
      },
      preview: (args) => args.application,
      execute: async (args) => runCapability("application.launch", { application: args.application }),
      render: (result) => {
        const window = result.windowIdentity ?? result.window;
        if (!window) {
          return result.failureCategory === "APPLICATION_NOT_INSTALLED"
            ? `${result.application} is not installed.`
            : `${result.application} started but no window was found yet.`;
        }
        state.lastWindow = {
          windowId: String(window.windowId ?? window.WindowHandle ?? ""),
          application: result.application
        };
        return `${result.application} is open (windowId ${state.lastWindow.windowId}).`;
      }
    },
    {
      name: "open_url",
      description: "Open a URL in the default browser.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      preview: (args) => args.url,
      // WHICH WINDOW DID IT OPEN IN?
      //
      // Start-Process hands the URL to the default browser and returns
      // immediately, saying nothing about where it went. With two Chrome windows
      // open, the page loaded in one and `screen chrome` read the other — so the
      // agent looked at a Mistral console tab four times over, concluded YouTube
      // had not loaded, and opened the same URL again. It spent its entire step
      // budget reading the wrong window.
      //
      // Waiting a moment and reporting the window that is now in front costs one
      // cheap call and tells the agent what it is about to be looking at.
      execute: async (args) => {
        const url = String(args.url);
        if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) URLs can be opened.");
        const launch = await adapter.executeCommand(state.cwd, `Start-Process ${JSON.stringify(url)}`, [], { timeoutMs: 15000 });
        if (launch.exitCode !== 0) return { ...launch, window: null };
        await new Promise((resolve) => setTimeout(resolve, 1800));
        const window = await adapter.getForegroundWindow?.().catch(() => null) ?? null;
        if (window?.windowId) {
          state.lastWindow = { windowId: String(window.windowId), application: window.processName };
        }
        return { ...launch, window };
      },
      render: (result) => {
        if (result.exitCode !== 0) return `Could not open it: ${clip(result.stderr, 400)}`;
        if (!result.window) return "Opened in the browser. Read the screen to see where it landed.";
        return `Opened. The window in front is now ${result.window.processName} — "${result.window.title}" ` +
          `(windowId ${result.window.windowId}). Call screen with no arguments to read it.`;
      }
    },
    {
      name: "windows",
      description: "List the open windows with their ids, titles and bounds.",
      parameters: { type: "object", properties: {}, required: [] },
      preview: () => "",
      execute: async () => runCapability("window.enumerate", {}),
      render: (result) => {
        const windows = (result.windows ?? []).filter((window) => String(window.MainWindowTitle ?? window.title ?? "").trim());
        if (windows.length === 0) return "No titled windows are open.";
        return windows.slice(0, 25).map((window) => {
          const bounds = window.Bounds ?? window.bounds ?? {};
          return `${window.WindowHandle ?? window.windowId} | ${window.ProcessName ?? window.processName} | ${String(window.MainWindowTitle ?? window.title).slice(0, 70)}` +
            `${window.Foreground ?? window.foreground ? " (foreground)" : ""} ${bounds.width}x${bounds.height}`;
        }).join("\n");
      }
    },
    {
      name: "focus",
      description: "Bring a window to the front so keyboard and mouse land on it.",
      parameters: {
        type: "object",
        properties: { application: { type: "string" }, windowId: { type: "string" } },
        required: []
      },
      preview: (args) => args.application ?? args.windowId ?? "",
      execute: async (args) => {
        const result = await runCapability("window.activate", args);
        if (result?.performed !== false) {
          state.lastWindow = { windowId: args.windowId ?? result?.windowId, application: args.application };
        }
        return result;
      },
      render: (result) => (result.performed === false ? `Could not focus it: ${result.reason ?? "unknown"}` : "Focused.")
    },
    {
      name: "window_state",
      description: "Maximize, minimize or restore a window.",
      parameters: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["maximize", "minimize", "restore"] },
          application: { type: "string" },
          windowId: { type: "string" }
        },
        required: ["state"]
      },
      preview: (args) => `${args.state} ${args.application ?? ""}`.trim(),
      execute: async (args) => runCapability(`window.${args.state}`, {
        application: args.application ?? state.lastWindow?.application,
        windowId: args.windowId ?? state.lastWindow?.windowId
      }),
      render: (result) => (result.performed === false ? `That did not work: ${result.reason ?? "unknown"}` : "Done.")
    },
    {
      name: "read_file",
      description: "Read a text file from disk.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      preview: (args) => args.path,
      execute: async (args) => runCapability("filesystem.read", { filePath: args.path }),
      render: (result) => clip(result.contents ?? result.content ?? JSON.stringify(result))
    },
    {
      name: "write_file",
      description: "Write a text file to disk, creating or overwriting it.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, contents: { type: "string" } },
        required: ["path", "contents"]
      },
      preview: (args) => args.path,
      // The capability's input is `content`, singular. Getting this wrong writes
      // an empty file and reports success.
      execute: async (args) => runCapability("filesystem.write", { filePath: args.path, content: args.contents }),
      render: (result) => `Wrote ${result.filePath}${result.existed ? " (replacing what was there)" : ""}.`
    },
    {
      name: "clipboard",
      description: "Read the clipboard, or write text to it.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Omit to read" } },
        required: []
      },
      preview: (args) => (args.text == null ? "read" : "write"),
      execute: async (args) => (args.text == null
        ? runCapability("clipboard.read", {})
        : runCapability("clipboard.write", { text: args.text })),
      render: (result) => (result.text != null ? clip(result.text, 4000) : "Clipboard set.")
    },
    {
      name: "play_music",
      description: "Play a track on Spotify by name and confirm it is actually playing.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Track, or \"track artist\"" } },
        required: ["query"]
      },
      preview: (args) => args.query,
      execute: async (args) => {
        const result = await runCapability("spotify.track.play", { query: args.query });
        return { ...result, requested: args.query };
      },
      // "SOMETHING IS PLAYING" IS NOT "THE REQUESTED TRACK IS PLAYING".
      //
      // Asked for Señorita while Hamari Adhuri Kahani was already playing, this
      // reported `Playing "Hamari Adhuri Kahani"` — twice, as a success, for a
      // track it had not played. Spotify was still playing the previous song and
      // `playback.playing` was perfectly true.
      //
      // The capability's own verify() compares the live title against the
      // request and exists precisely to catch this; the agent loop calls
      // execute() directly and so never ran it. Comparing here restores that
      // check at the only place the loop can see it.
      render: (result) => {
        if (result.available === false) return result.reason ?? "Spotify is not installed.";
        const playback = result.playback ?? {};
        const nowPlaying = playback.nowPlaying ?? playback.title ?? result.title ?? "";
        if (!playback.playing) {
          return `Spotify is not playing: ${result.reason ?? playback.reason ?? "no track started"}. ` +
            "The window is open — read the screen and click the track.";
        }
        if (!matchesTrackQuery(nowPlaying, result.requested)) {
          return `Spotify is still playing "${nowPlaying}", which is NOT what was asked for ` +
            `("${result.requested}"). The track did not start. Read the screen and click the right result.`;
        }
        return `Playing "${nowPlaying}".`;
      }
    },
    {
      name: "wait",
      description: "Wait a moment for something to finish loading or appearing.",
      parameters: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
      preview: (args) => `${args.ms}ms`,
      execute: async (args) => {
        const ms = Math.min(30000, Math.max(0, Number(args.ms) || 0));
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { waited: ms };
      },
      render: (result) => `Waited ${result.waited}ms.`
    }
  ];

  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // WHY EVERY TOOL TAKES A `say`.
  //
  // The product is supposed to answer the way a person does — "sure, opening
  // Spotify now" — and then do the thing. The obvious way to get that is to ask
  // the model to write a sentence before calling a tool, and the system prompt
  // does ask. Measured against the configured model, it does not comply: a turn
  // that calls a tool comes back with `content: ""` almost every time, which is
  // ordinary behaviour for this class of model and not something a stronger
  // instruction fixes.
  //
  // The alternative was a second, parallel model request purely to produce the
  // acknowledgement. That works and it is what this codebase did before, but it
  // doubles the request count against a rate-limited account to say one line.
  //
  // Asking for the sentence as an ARGUMENT costs nothing extra: it arrives in
  // the same streamed tool call, roughly a second in, while the tool it
  // describes has not run yet. The model reliably fills it, because filling in
  // a declared parameter is the one thing a tool-calling model is good at.
  const SAY_PARAMETER = {
    type: "string",
    description: "One short sentence telling the user what you are doing, e.g. \"Opening Spotify.\" Shown to them immediately."
  };

  return {
    // The wire format the model is shown.
    definitions: tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          ...tool.parameters,
          properties: { say: SAY_PARAMETER, ...tool.parameters.properties }
        }
      }
    })),

    has: (name) => byName.has(name),

    previewOf(name, args) {
      const tool = byName.get(name);
      try { return tool?.preview?.(args ?? {}) ?? ""; } catch { return ""; }
    },

    /**
     * Run one tool call. Never throws: a failure is a result the model reads and
     * works around, exactly like a non-zero exit code.
     */
    async execute(name, args = {}) {
      const tool = byName.get(name);
      if (!tool) {
        return { ok: false, text: `There is no tool called "${name}". Use one of: ${[...byName.keys()].join(", ")}.` };
      }
      const startedAt = Date.now();
      try {
        // `say` is narration for the user, not an input to the operation.
        const { say, ...inputs } = args;
        const result = await tool.execute(inputs);
        const text = tool.render(result ?? {});
        return { ok: true, text, raw: result, durationMs: Date.now() - startedAt };
      } catch (error) {
        return {
          ok: false,
          text: `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
          durationMs: Date.now() - startedAt
        };
      }
    }
  };
}
