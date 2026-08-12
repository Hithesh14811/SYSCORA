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

import fs from "node:fs/promises";
import { matchesTrackQuery } from "../../capability-registry/src/index.js";
import { VISIBLE_CHANGE, changedFraction, gridRegion, screenSignature } from "./screen-signature.js";
import { buildPath, flattenPath } from "./stroke-path.js";

const MAX_OUTPUT_CHARS = 6000;
const MAX_SCREEN_TEXT_CHARS = 2500;
// How many rows are LISTED. Everything observed stays clickable regardless (see
// renderElements). Sixty was too few for a real application: Paint's toolbar
// alone exceeds it, and the rows that fell off were the tools.
const MAX_ELEMENTS = 110;

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
  // EVERYTHING OBSERVED STAYS CLICKABLE; ONLY THE LISTING IS CUT.
  //
  // The cut used to apply to both, and the two are not the same decision. Paint
  // exposes well over sixty elements, so "Shapes" and "Brushes" fell outside it —
  // and because the target table was built from the survivors, they became
  // unreachable as well as unlisted. The agent could SEE "Brushes Shapes" in the
  // visible text, clicked it, and was told nothing on screen is labelled Shapes.
  // It tried three spellings, gave up, and clicked a guessed coordinate. Spotify's
  // "Dismiss" on the premium banner was lost the same way, which is why the
  // banner sat there through the whole session.
  //
  // So the table gets everything, and its indices are stable positions in it.
  // The listing shows the highest-ranked, each with its real index — a label read
  // out of the visible text still resolves even when its row did not make the cut.
  for (const { element } of candidates) table.push(element);
  const shown = new Set(
    [...candidates]
      .map((candidate, index) => ({ candidate, index }))
      .sort((left, right) => right.candidate.rank - left.candidate.rank || left.index - right.index)
      .slice(0, MAX_ELEMENTS)
      .map((entry) => entry.index)
  );
  for (const [index, { element, text, center }] of candidates.entries()) {
    if (!shown.has(index)) continue;
    const role = String(element.role ?? element.controlType ?? "").replace(/^ControlType\./, "");
    lines.push(`${index}| ${role}${text ? ` "${text.slice(0, 80)}"` : ""} @${center.x},${center.y}${element.enabled === false ? " (disabled)" : ""}`);
  }
  return lines;
}

// The windows a person would recognise as open: titled, and big enough to see.
// Offered whenever a reading fails, because "could not read that" with no list
// of what IS there leaves the model nothing to try but the same name again.
function describeWindows(windows) {
  return (windows ?? [])
    .filter((window) => {
      const bounds = window.Bounds ?? window.bounds ?? {};
      return String(window.MainWindowTitle ?? window.title ?? "").trim()
        && Number(bounds.width ?? 0) > 10 && Number(bounds.height ?? 0) > 10;
    })
    .slice(0, 20)
    .map((window) => `${window.ProcessName ?? window.processName} — ` +
      `${String(window.MainWindowTitle ?? window.title).slice(0, 60)} ` +
      `(windowId ${window.WindowHandle ?? window.windowId})`);
}

/**
 * Build the model-facing toolset.
 *
 * `registry` supplies the implementations; `adapter` is used directly for the
 * few primitives that have no capability worth the ceremony (moving the pointer,
 * waiting). Returns the OpenAI-format tool definitions plus one execute()
 * entry point.
 */
export function buildToolset({
  registry,
  adapter,
  basePath = process.cwd(),
  // Seam for tests: turning a captured PNG into a brightness grid. The real one
  // decodes the file; a test hands back a prepared grid rather than having to
  // synthesise valid PNGs.
  readSignature = async (path) => screenSignature(await fs.readFile(path))
} = {}) {
  // What the last look at the screen found, so a click can name an element
  // rather than a coordinate. Reset by every fresh observation.
  //
  // `freshWindows` are surfaces this run created — a window that did not exist
  // before we launched it, or a document we opened with new_document. Anything
  // else was already there when we arrived, and what is in it belongs to the
  // user. `ownedWindows` are the ones that question has already been settled
  // for, so it is asked once per window rather than before every keystroke.
  const state = {
    elements: [],
    cwd: basePath,
    lastWindow: null,
    freshWindows: new Set(),
    ownedWindows: new Set(),
    // Files this run has written. Rewriting one of our own is not overwriting
    // anybody's work, and must not be interrupted to ask.
    ownedPaths: new Set()
  };

  const runCapability = async (name, inputs, options = {}) => {
    const capability = registry.get(name);
    if (!capability) throw new Error(`Unknown capability ${name}`);
    return capability.execute(inputs, options);
  };

  // DID THE PICTURE CHANGE?
  //
  // Text perception cannot see a drawing. OCR of a canvas with a circle on it
  // and OCR of an empty canvas return the same nothing, so an agent that draws
  // and then "checks by reading the screen" learns absolutely nothing and says
  // it worked. Live: it selected a tool, dragged across the canvas, read the
  // screen, and reported "the shape is now visible on the canvas" — the canvas
  // was blank, and the tool had never been selected.
  //
  // Hashing the window's pixels before and after is the one check that works on
  // graphics, and it is deterministic: identical bytes mean nothing happened.
  // DID THE DOCUMENT CHANGE? ASK THE APPLICATION.
  //
  // Every attempt to answer this from pixels produced a new false positive: a
  // byte hash fired on the status bar's coordinate readout; a whole-window
  // brightness grid fired on a menu closing between the two captures; restricting
  // it to the dragged area still fired on a canvas that ground truth showed was
  // blank. Each was a plausible measure of "something looks different", and none
  // of them was a measure of "the drawing changed".
  //
  // The application already knows. Undo is disabled when there is nothing to
  // undo, and it becomes enabled the moment the document is modified — in Paint,
  // in Word, in an editor, in anything with an edit history. That is not a proxy
  // for "the document changed": it IS the application saying so, it costs one
  // accessibility read, and unlike a screenshot it cannot be confused by a
  // tooltip.
  // IS THERE ALREADY SOMETHING IN HERE, AND WHOSE IS IT?
  //
  // One accessibility read, answering the three questions that decide whether a
  // window is safe to type into — asked of the application rather than assumed
  // from its name, so it is the same question in Notepad, Word, an IDE or an
  // editor nobody has heard of:
  //
  //   Is this an editing surface at all?  A Document control, or an Edit control
  //     big enough to be the document rather than an address bar or a search box.
  //   Is there work in it?  The surface's own value, plus whether the
  //     application's Undo is enabled — undo enabled means unsaved edits exist,
  //     which is the application itself saying "someone has been working here".
  //   Is there a way to start fresh?  The application's own New/New tab control,
  //     if it publishes one.
  //
  // Nothing here knows what Notepad is. An application that offers a New tab
  // button gets a new tab; one that offers only File > New gets Ctrl+N; one that
  // is not an editor at all reports `editing: false` and is never gated.
  const DOCUMENT_ROLE = /(^|\.)Document$/i;
  // Edit only. ControlType.Text is a static label — a large one is a heading or
  // a paragraph of chrome, not something anybody is going to type into.
  const EDIT_ROLE = /(^|\.)Edit$/i;
  const NEW_CONTROL = /^(new|new tab|add new tab|new window|new document|new file|new text document)$/i;

  const boundsOf = (element) => element.bounds ?? element.boundingRect ?? null;

  const workspaceState = async ({ windowId, application } = {}) => {
    if (typeof adapter.inspectUi !== "function") return null;
    let ui = null;
    try {
      ui = await adapter.inspectUi({
        ...(windowId ? { windowId: String(windowId) } : { application }),
        maxElements: 240
      });
    } catch {
      return null;
    }
    const elements = ui?.elements ?? ui?.targets ?? [];
    if (!Array.isArray(elements) || elements.length === 0) return null;
    const window = (ui?.windows ?? [])[0] ?? null;
    const title = String(window?.MainWindowTitle ?? window?.title ?? "").trim();
    // "Big enough to be the document" has to be a fraction, not a pixel count —
    // a pixel count means something different on every screen. The window
    // publishes no bounds here, but its largest descendant fills it, so that is
    // the frame everything else is measured against.
    const areaOf = (element) => {
      const bounds = boundsOf(element);
      return bounds ? Number(bounds.width ?? 0) * Number(bounds.height ?? 0) : 0;
    };
    const windowArea = Math.max(1, ...elements.map(areaOf));

    const undo = elements.find((element) => /^undo\b/i.test(String(element.name ?? "").trim()));
    const newControl = elements.find((element) => {
      if (element.enabled === false) return false;
      const bounds = boundsOf(element);
      return bounds && NEW_CONTROL.test(String(element.name ?? "").trim());
    });

    let editing = false;
    let contentChars = 0;
    // WHETHER THE ANSWER IS ZERO, OR THERE IS NO ANSWER.
    //
    // Reading a surface's contents needs UI Automation's ValuePattern, and a
    // real editor may not implement it — Windows 11's Notepad hosts a rich edit
    // control that answers the value query with nothing at all. Treating that
    // silence as "zero characters" would say the document is empty in exactly
    // the application this whole problem was reported against.
    let contentReadable = false;
    for (const element of elements) {
      const role = String(element.controlType ?? element.role ?? "");
      if (!boundsOf(element)) continue;
      const area = areaOf(element);
      // A Document is the document. An Edit is only the document when it fills a
      // real part of the window — otherwise it is the omnibox, the search box or
      // a form field, and typing into one of those is not editing anyone's work.
      const isSurface = DOCUMENT_ROLE.test(role) || (EDIT_ROLE.test(role) && area / windowArea >= 0.25);
      if (!isSurface) continue;
      editing = true;
      const patterns = Array.isArray(element.supportedPatterns) ? element.supportedPatterns.join(" ") : "";
      if (typeof element.value === "string" || /value/i.test(patterns)) contentReadable = true;
      contentChars = Math.max(contentChars, String(element.value ?? "").trim().length);
    }

    return {
      title,
      editing: editing || Boolean(undo),
      contentChars,
      contentReadable,
      hasUndo: Boolean(undo),
      undoEnabled: undo ? undo.enabled !== false : null,
      newControl: newControl
        ? {
            name: String(newControl.name ?? "").trim(),
            center: {
              x: Math.round(boundsOf(newControl).x + boundsOf(newControl).width / 2),
              y: Math.round(boundsOf(newControl).y + boundsOf(newControl).height / 2)
            }
          }
        : null
    };
  };

  const undoAvailable = async (target) => {
    const workspace = await workspaceState(target);
    if (!workspace?.hasUndo) return null;
    return workspace.undoEnabled;
  };

  const windowLook = async ({ windowId, application } = {}) => {
    if ((!windowId && !application) || typeof adapter.captureScreen !== "function") return null;
    try {
      const capture = await adapter.captureScreen(
        windowId ? { windowId: String(windowId) } : { application: String(application) }
      );
      if (!capture?.captured || !capture.path) return null;
      const cells = await readSignature(capture.path);
      return cells ? { cells, bounds: capture.bounds ?? null } : null;
    } catch {
      return null;
    }
  };

  // THAT DOCUMENT IS ALREADY SOMEBODY'S.
  //
  // Asked to write something in Notepad, the agent launched Notepad, was handed
  // the window that was ALREADY OPEN — Windows had not started a second one —
  // and typed into the middle of the user's document. Every step of that reported
  // success, and every step of it was true: Notepad was open, the window was
  // grounded, the keystrokes were delivered. Nothing anywhere in the loop had
  // been told the difference between a window we opened and a window we walked
  // into, so there was no point at which it could have known.
  //
  // Hard-coding "in Notepad, press Ctrl+T first" would fix Notepad and nothing
  // else, and would be wrong the moment Notepad's window really was empty. What
  // was actually missing is an observation: this surface has work in it, and we
  // did not put it there. Given that, the model can decide — and it is asked to
  // decide explicitly, because the choice between adding to someone's document
  // and starting a new one is not one to make silently.
  //
  // The gate is asked once per window, only for windows we did not create, and
  // only where the application says it is an editing surface with something in
  // it. A browser, a music player, a search box, an empty document: no gate.
  const documentGate = async (args) => {
    // Whatever the typing is about to land in. A windowId when one is known;
    // otherwise the application named on the call, because `type {application:
    // "notepad"}` with no prior reading targets a window just as surely as a
    // handle does — and keying only on the handle let exactly that case through
    // ungated.
    const windowId = String(state.lastWindow?.windowId ?? "");
    const application = String(args.application ?? state.lastWindow?.application ?? "").trim();
    const target = windowId ? { windowId } : (application ? { application } : null);
    if (!target) return;
    const key = windowId || `application:${application.toLowerCase()}`;
    // The model has said what it means to do. That settles it for this window.
    const intent = String(args.existing ?? "").trim();
    if (intent) { state.ownedWindows.add(key); return; }
    if (state.freshWindows.has(key) || state.ownedWindows.has(key)) return;

    const workspace = await workspaceState(target);
    // UNCONFIRMED IS NOT OCCUPIED. If the application says nothing, that is not
    // evidence of a document, and refusing on it would block ordinary typing.
    if (!workspace?.editing) { state.ownedWindows.add(key); return; }
    // WHAT AN UNREADABLE SURFACE IS CALLED IS THE LAST THING LEFT TO GO ON.
    //
    // When the contents cannot be read and the application has nothing to undo,
    // a saved file sitting open looks exactly like a blank page — and typing
    // appends to the middle of somebody's file. Every Windows editor puts the
    // document's name in the title bar and calls an empty one Untitled, New or
    // Document1, so a title that is none of those is a document. It is a weaker
    // signal than the other two and is used only when they say nothing; the cost
    // of being wrong is one round trip, against losing a file.
    const named = String(workspace.title ?? "").split(" - ")[0].trim();
    const looksNamed = Boolean(named) && !/^(untitled|new (tab|document|file)|document\s*\d*|blank)$/i.test(named);
    const occupied = workspace.contentChars > 0
      || workspace.undoEnabled === true
      || (!workspace.contentReadable && workspace.undoEnabled !== true && looksNamed);
    if (!occupied) { state.ownedWindows.add(key); return; }

    const evidence = [
      workspace.title ? `its title is "${workspace.title}"` : null,
      workspace.contentChars > 0 ? `the document holds ${workspace.contentChars} characters` : null,
      workspace.undoEnabled === true ? "the application has unsaved edits it could undo" : null,
      !workspace.contentReadable && workspace.contentChars === 0
        ? "and it will not tell me what it contains, so I cannot assume it is empty"
        : null
    ].filter(Boolean).join(", and ");
    throw new Error(
      `This window was ALREADY OPEN before you got here, and there is work in it — ${evidence}. ` +
      "Typing now would edit the user's existing document, not write a new one.\n" +
      (workspace.newControl
        ? `This application offers "${workspace.newControl.name}" — call new_document to use it.\n`
        : "Call new_document to start a fresh one.\n") +
      "If you genuinely meant to write into what is already there, call type again with " +
      'existing: "append" (adding to it) or existing: "replace" (you have selected what it will overwrite).'
    );
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
        .map((element, index) => ({ element, index, score: score(element) + (element.clickable ? 0.5 : 0) }))
        .filter((entry) => entry.score >= 2)
        .sort((left, right) => right.score - left.score);
      if (ranked.length === 0) {
        // A bare "nothing is labelled that" is a dead end: told it three times,
        // the agent retried synonyms and then clicked a coordinate it invented.
        // Offer the nearest things actually on screen — usually one of them is
        // what was meant, under the name the application really uses.
        const scored = state.elements
          .map((element) => {
            const candidate = normalizeLabel(element.text);
            if (!candidate) return null;
            const shared = needle.split(" ").filter((word) => word && candidate.includes(word)).length;
            // Sharing no words at all is not a reason to say nothing. Ranking
            // actionable, named things above the rest still produces a useful
            // list, and a useful list is what turns a dead end into a next move.
            const overlap = shared + (element.clickable ? 0.25 : 0);
            return { element, overlap };
          })
          .filter(Boolean)
          .sort((left, right) => right.overlap - left.overlap)
          .slice(0, 10)
          .map(({ element }) => `  "${element.text}" @${element.center.x},${element.center.y}`);
        throw new Error(
          `Nothing on screen is labelled "${wanted}".` +
          (scored.length ? `\nThe closest labels actually present are:\n${scored.join("\n")}` : "") +
          "\nUse one of those, or read the screen again. Do not click a coordinate you have not read."
        );
      }
      // SEVERAL THINGS ANSWER TO THIS NAME. SAY SO; DO NOT PICK ONE.
      //
      // Asked to message Amma, the reading contained "Amma" three times — the
      // search box the name had just been typed into, the results header, and the
      // chat itself. All three scored identically, the first won on list order,
      // and the click landed on the SEARCH BOX. The chat never opened, the
      // message went to whatever conversation was already on screen, and the user
      // was told it had been sent to their mother.
      //
      // A silent tie-break is a guess wearing a decision's clothes. Naming the
      // candidates costs one cheap round trip and lets the model choose using
      // what it can see and the tie-break cannot: which one is in the chat list.
      const tied = ranked.filter((entry) => entry.score === ranked[0].score);
      if (tied.length > 1) {
        const options = tied
          .map((entry) => `  ${entry.index}| ${entry.element.role ?? ""} "${entry.element.text}" @${entry.element.center.x},${entry.element.center.y}`)
          .join("\n");
        throw new Error(
          `"${wanted}" matches ${tied.length} things on screen, and they are not the same thing:\n${options}\n` +
          "Pick the one you mean by its index."
        );
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
          application: { type: "string", description: "Process name, e.g. \"notepad\", \"chrome\". Omit to re-read the window you are working in" },
          windowId: { type: "string" },
          desktop: { type: "boolean", description: "Read whatever window is in front on the desktop instead, whichever it is" }
        },
        required: []
      },
      preview: (args) => args.application ?? (args.desktop ? "the desktop" : "the working window"),
      // READ THE WINDOW YOU ARE WORKING IN, NOT THE ONE IN FRONT.
      //
      // With no arguments this read the OS foreground window, and the OS
      // foreground window belongs to whoever is at the keyboard. The user
      // watches SYSCORA work, so the window in front is usually SYSCORA's own
      // chat — and this agent, mid-way through drawing in Paint, clicked a
      // toolbar, read "the screen", and got back a reading of the Claude window
      // with the conversation about itself in it. Every conclusion after that
      // was drawn from the wrong application.
      //
      // The window it has been working in is the one it means. `desktop: true`
      // asks the old question, for the rare case where "what is in front of me
      // right now" is genuinely what is wanted.
      execute: async (args) => {
        const named = args.windowId || args.application || args.desktop;
        // NO WINDOW NAMED AND NONE IN HAND IS NOT A QUESTION ABOUT THE DESKTOP.
        //
        // `screen.read` with nothing to go on falls through to whatever is in
        // front, and what is in front is SYSCORA's own chat window — the user is
        // watching it. On the first look of a task that produced a reading of
        // this conversation, which the model then reasoned about as if it were
        // the application it had been asked to use. Asking costs one cheap round
        // trip; guessing costs the whole task.
        if (!named && !state.lastWindow?.windowId) {
          const windows = await adapter.listWindows?.().catch(() => []) ?? [];
          return {
            read: false,
            reason: "you have not opened or read any window yet, so there is no working window to re-read",
            openWindows: describeWindows(windows)
          };
        }
        const target = named
          ? args
          : { ...args, windowId: state.lastWindow.windowId };
        // THE FAST LOOK FIRST, THE SLOW ONE ONLY IF IT IS NEEDED.
        //
        // Capture + OCR is the slow half of every look — about two of the three
        // seconds — and for an application with a real accessibility tree it
        // returns the same words again, misread, as a second pile of unclickable
        // elements. Every one of those costs tokens on every step afterwards.
        //
        // So: ask the tree. If it answered with a usable window, that is the
        // reading. A window with nothing accessible in it — a canvas, a game, a
        // remote session, an application that publishes no tree — is exactly when
        // pixels are worth three seconds, and only then are they paid for.
        let result = await runCapability("screen.read", { ...target, maxElements: 240, includeOcr: false });
        if (!result?.read || (result.elements ?? []).length < 6) {
          result = await runCapability("screen.read", { ...target, maxElements: 240 });
        }
        // A reading that found nothing is a dead end unless it says what IS
        // there. Without this the agent's only move is to try the same name
        // again, or relaunch the application it already has open.
        if (!result?.read) {
          const windows = await adapter.listWindows?.().catch(() => []) ?? [];
          result.openWindows = describeWindows(windows);
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
          // Only name the application when there is no handle. Sending both lets
          // a general name compete with an exact one, and with two windows of the
          // same browser open the general name is how a click on the page gets
          // validated against a dialog in the corner.
          ...(target.windowId ? {} : { application: args.application ?? state.lastWindow?.application }),
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
      description:
        "Type text into whatever has keyboard focus. Click the field first if focus is not already there. " +
        "If the window already contains a document that is not yours, this refuses and tells you so — " +
        "start a fresh one with new_document, or say what you meant with `existing`.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          into: { type: "string", description: "Label of the field to click first, from the last screen reading" },
          element: { type: "number", description: "Index of the field to click first" },
          existing: {
            type: "string",
            enum: ["append", "replace"],
            description:
              "Only when you mean to write into a document that is already open: \"append\" to add to it, " +
              "\"replace\" when you have selected what this will overwrite."
          },
          application: { type: "string" }
        },
        required: ["text"]
      },
      preview: (args) => JSON.stringify(String(args.text).slice(0, 80)),
      execute: async (args) => {
        await documentGate(args);
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
      name: "drag",
      // Without this, everything that is drawn rather than clicked was out of
      // reach: a shape in Paint, a selection across text, a slider, a file onto a
      // folder, a window by its title bar. Asked to draw a circle, the agent
      // selected the ellipse tool correctly and then had no verb for the one
      // motion the task consists of — so it looked, waited, looked again, and
      // reported that nothing had happened. It was right.
      description:
        "Press the mouse at one point, move to another, and release — the motion behind drawing a shape, " +
        "selecting a range, moving a slider, or dragging something onto something else. Give from/to as " +
        "element labels from the last reading, or as coordinates.",
      parameters: {
        type: "object",
        properties: {
          fromText: { type: "string", description: "Label to start from, from the last screen reading" },
          toText: { type: "string", description: "Label to finish on" },
          fromX: { type: "number" }, fromY: { type: "number" },
          toX: { type: "number" }, toY: { type: "number" },
          application: { type: "string" }
        },
        required: []
      },
      preview: (args) => `(${args.fromX ?? args.fromText}, ${args.fromY ?? ""}) → (${args.toX ?? args.toText}, ${args.toY ?? ""})`,
      execute: async (args) => {
        const from = resolveTarget({ text: args.fromText, x: args.fromX, y: args.fromY });
        const to = resolveTarget({ text: args.toText, x: args.toX, y: args.toY });
        // The host brings the named window to the front and delivers the whole
        // press-move-release itself, so there is nothing to click first.
        const windowId = from.windowId ?? to.windowId ?? state.lastWindow?.windowId;
        const application = args.application ?? state.lastWindow?.application;
        const target = windowId ? { windowId } : { application };
        // The application's own edit history, before and after. Cheap, and it
        // answers the actual question rather than a question about pixels.
        const undoBefore = await undoAvailable(target);
        // When there is nothing to undo yet, the undo delta answers this on its
        // own and the two screen captures — three seconds — are pure waste. They
        // are only needed when undo cannot settle it: no undo control at all, or
        // a document that already had history so gaining more proves nothing.
        const before = undoBefore === false ? null : await windowLook(target);
        const result = await adapter.pointerAction("drag", {
          ...target,
          fromX: from.x, fromY: from.y,
          toX: to.x, toY: to.y
        });
        const undoAfter = await undoAvailable(target);
        // Pixels only when the application exposes no undo state at all. Measured
        // WHERE THE DRAG HAPPENED, since a menu closing elsewhere is not evidence.
        const after = before ? await windowLook(target) : null;
        const region = before && after
          ? gridRegion({
              bounds: before.bounds ?? after.bounds,
              from: { x: from.x, y: from.y },
              to: { x: to.x, y: to.y }
            })
          : null;
        return {
          ...result,
          undoBefore,
          undoAfter,
          changedFraction: region ? changedFraction(before.cells, after.cells, { region }) : null
        };
      },
      render: (result) => {
        if (result.performed === false) return `The drag did not happen: ${result.reason ?? "unknown"}`;
        const where = `from ${result.from?.x},${result.from?.y} to ${result.to?.x},${result.to?.y}`;
        // The application's edit history is the strongest answer available.
        if (result.undoAfter === false) {
          return `Dragged ${where}, but the application still has NOTHING TO UNDO — so the document did ` +
            "not change and nothing was drawn. Almost always the tool you meant to use is not actually " +
            "active: in Paint, opening the Shapes group is not the same as selecting a shape from it. " +
            "Read the screen, confirm the tool is really selected, and check the drag was inside the canvas.";
        }
        if (result.undoAfter === true && result.undoBefore === false) {
          return `Dragged ${where}, and the application now has something to undo — the document changed, ` +
            "so it drew.";
        }
        const changed = result.changedFraction;
        if (changed == null) {
          return `Dragged ${where}. I cannot tell whether it drew anything — the application exposes no ` +
            "undo state and the window could not be compared. UNCONFIRMED: do not claim it worked. Check " +
            "some other way before saying it is done.";
        }
        if (changed < VISIBLE_CHANGE) {
          return `Dragged ${where}, and that area of the window is visually IDENTICAL afterwards. ` +
            "NOTHING WAS DRAWN there. Confirm the tool you meant to use is actually active.";
        }
        return `Dragged ${where}, and that area of the window changed. That is weak evidence — ` +
          "it can also mean a menu closed. Verify another way before claiming it drew.";
      }
    },
    {
      name: "draw",
      // A drag can only ever be a straight line, so every curve had to be spelled
      // as a series of drags — and the button comes up between drags. Asked for a
      // circle, the best an agent could do was a ring of disconnected chords, one
      // model round trip and one undo entry each. This is the verb for the thing
      // the request actually names: a shape, drawn in one motion.
      description:
        "Draw in one continuous motion, with the button held down the whole way — the verb for anything " +
        "drawn rather than clicked. Name a `shape` (circle, ellipse, arc, rect, square, polygon, line, " +
        "polyline, freehand) with its measurements, or give `points`. Use `strokes` to draw a figure that " +
        "lifts the pen, in one call. Select the tool you want first; this only moves the mouse.",
      parameters: {
        type: "object",
        properties: {
          shape: {
            type: "string",
            enum: ["circle", "ellipse", "arc", "rect", "square", "polygon", "line", "polyline", "freehand"]
          },
          cx: { type: "number", description: "Centre, for circle, ellipse, arc and polygon" },
          cy: { type: "number" },
          radius: { type: "number" },
          radiusX: { type: "number", description: "Ellipse half-width" },
          radiusY: { type: "number", description: "Ellipse half-height" },
          x: { type: "number", description: "Top-left, for rect and square" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          fromX: { type: "number", description: "Line endpoints" },
          fromY: { type: "number" },
          toX: { type: "number" },
          toY: { type: "number" },
          sides: { type: "number", description: "Polygon side count" },
          startDegrees: { type: "number", description: "Arc start, 0 is east and angles run clockwise" },
          sweepDegrees: { type: "number", description: "Arc extent" },
          points: {
            type: "array",
            description: "Vertices for polyline, or points to curve through for freehand",
            items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } }
          },
          closed: { type: "boolean", description: "Join the last point back to the first" },
          strokes: {
            type: "array",
            description: "Several strokes, each one of these shapes, drawn in a single call with the pen lifted between them",
            items: { type: "object" }
          },
          durationMs: { type: "number", description: "Roughly how long the whole motion should take" },
          application: { type: "string" }
        },
        required: []
      },
      preview: (args) => {
        if (Array.isArray(args.strokes)) return `${args.strokes.length} strokes`;
        const where = args.cx != null ? `at ${args.cx},${args.cy}` : args.fromX != null ? `${args.fromX},${args.fromY} → ${args.toX},${args.toY}` : "";
        return `${args.shape ?? "path"} ${where}`.trim();
      },
      execute: async (args) => {
        const specs = Array.isArray(args.strokes) && args.strokes.length > 0
          ? args.strokes
          : [args];
        const paths = specs.map((spec) => buildPath(spec));
        const points = paths.reduce((total, path) => total + path.length, 0);
        // How long the motion takes is the caller's to choose, and the default is
        // the host's. Asking for a duration sets the pace per point rather than a
        // sleep at the end, so the stroke is spread evenly instead of being drawn
        // instantly and then waited on.
        const pacingMicros = Number.isFinite(Number(args.durationMs))
          ? Math.max(0, Math.min(5000, Math.round((Number(args.durationMs) * 1000) / Math.max(1, points))))
          : 250;
        const windowId = state.lastWindow?.windowId;
        const application = args.application ?? state.lastWindow?.application;
        const target = windowId ? { windowId } : { application };
        // The same evidence a drag collects, for the same reason: OCR cannot see
        // a drawing, so "read the screen back" learns nothing here. The
        // application's own undo state answers it when there is one, and the
        // pixels over the area the stroke covered answer it when there is not.
        const undoBefore = await undoAvailable(target);
        const before = undoBefore === false ? null : await windowLook(target);
        const result = await adapter.pointerStroke({
          ...target,
          paths: paths.map(flattenPath),
          pacingMicros
        });
        const undoAfter = await undoAvailable(target);
        const after = before ? await windowLook(target) : null;
        // The whole figure's bounding box, so the comparison looks where the
        // drawing is and nowhere else.
        const all = paths.flat();
        const box = {
          from: { x: Math.min(...all.map((p) => p.x)), y: Math.min(...all.map((p) => p.y)) },
          to: { x: Math.max(...all.map((p) => p.x)), y: Math.max(...all.map((p) => p.y)) }
        };
        const region = before && after ? gridRegion({ bounds: before.bounds ?? after.bounds, ...box }) : null;
        return {
          ...result,
          shape: specs.length > 1 ? `${specs.length} strokes` : String(specs[0].shape ?? "path"),
          plannedPoints: points,
          box,
          undoBefore,
          undoAfter,
          changedFraction: region ? changedFraction(before.cells, after.cells, { region }) : null
        };
      },
      render: (result) => {
        if (result.performed === false) return `Nothing was drawn: ${result.reason ?? "unknown"}`;
        const what = `Drew ${result.shape} — ${result.plannedPoints} points in ${result.strokes ?? 1} ` +
          `stroke${(result.strokes ?? 1) === 1 ? "" : "s"} over ${Math.round(result.durationMs ?? 0)}ms, ` +
          `from ${result.box.from.x},${result.box.from.y} to ${result.box.to.x},${result.box.to.y}`;
        if (result.undoAfter === false) {
          return `${what}, but the application still has NOTHING TO UNDO — so the document did not change ` +
            "and nothing was drawn. Almost always the tool you meant to use is not actually active: in " +
            "Paint, opening the Shapes group is not the same as selecting a shape from it. Read the " +
            "screen, confirm the tool is really selected, and check the stroke was inside the canvas.";
        }
        if (result.undoAfter === true && result.undoBefore === false) {
          return `${what}, and the application now has something to undo — the document changed, so it drew.`;
        }
        const changed = result.changedFraction;
        // UNCONFIRMED IS NOT FAILED. Neither check being available means the
        // result is unknown, and saying so is the only honest thing to report.
        if (changed == null) {
          return `${what}. I cannot tell whether it drew anything — the application exposes no undo state ` +
            "and the window could not be compared. UNCONFIRMED: do not claim it worked. Check some other " +
            "way before saying it is done.";
        }
        if (changed < VISIBLE_CHANGE) {
          return `${what}, and that area of the window is visually IDENTICAL afterwards. NOTHING WAS ` +
            "DRAWN there. Confirm the tool you meant to use is actually active.";
        }
        return `${what}, and that area of the window changed — which is consistent with it having drawn, ` +
          "but a menu closing would also change it. Verify another way before claiming it drew.";
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
        const windowId = String(window.windowId ?? window.WindowHandle ?? "");
        state.lastWindow = { windowId, application: result.application };
        // "IT IS OPEN" HIDES THE ONLY THING THAT MATTERED.
        //
        // Launching an application that is already running usually does not
        // start a second one — it hands back the window that was already there,
        // with whatever the user was doing still in it. The adapter knows which
        // happened, because it listed the windows before it launched; the model
        // was told neither way and reasonably assumed it had a fresh one.
        const reused = Array.isArray(result.before?.windowIds)
          && result.before.windowIds.includes(windowId);
        if (!reused) state.freshWindows.add(windowId);
        const title = String(window.title ?? window.MainWindowTitle ?? "").trim();
        return reused
          ? `${result.application} was ALREADY RUNNING — this is the window that was already open ` +
            `(windowId ${windowId}${title ? `, "${title}"` : ""}), not a new one. Whatever is in it is the ` +
            "user's, so do not assume it is empty: if you are starting something new, use new_document."
          : `${result.application} is open in a new window (windowId ${windowId}).`;
      }
    },
    {
      name: "new_document",
      // The verb that did not exist. Without it, "write a poem in Notepad" had
      // exactly one route — type into whatever was on screen — so that is what
      // happened, to a document the user had open.
      description:
        "Start a fresh document, tab or file in the application you are working in, so you write somewhere " +
        "new instead of into work that is already open. Uses the application's own New/New tab control when " +
        "it publishes one, and Ctrl+N when it does not.",
      parameters: {
        type: "object",
        properties: { application: { type: "string" }, windowId: { type: "string" } },
        required: []
      },
      preview: (args) => args.application ?? "the working window",
      execute: async (args) => {
        const windowId = String(args.windowId ?? state.lastWindow?.windowId ?? "");
        const application = args.application ?? state.lastWindow?.application;
        const target = windowId ? { windowId } : { application };
        const before = await workspaceState(target);
        // ASK THE APPLICATION WHAT IT OFFERS, DO NOT ASSUME.
        //
        // Ctrl+N is the convention, but in a tabbed application it opens a whole
        // new window when a new tab is what was wanted — and some applications
        // do not bind it at all. The control the application publishes is what
        // the application actually means by "new", whatever that turns out to be.
        let route;
        if (before?.newControl) {
          await runCapability("pointer.clickAt", { ...before.newControl.center, ...target });
          route = `its own "${before.newControl.name}" control`;
        } else {
          await runCapability("keyboard.press", { keys: "ctrl+n", ...target });
          route = "Ctrl+N";
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
        const after = await workspaceState(target);
        // Ctrl+N may have opened a separate window, in which case the one we
        // measured is unchanged and the new surface is the one now in front.
        // Only askable when we knew which window we started in: without that,
        // "the foreground is a different window" compares against nothing.
        const foreground = windowId
          ? await adapter.getForegroundWindow?.().catch(() => null) ?? null
          : null;
        const movedWindow = foreground?.windowId && String(foreground.windowId) !== windowId
          ? { windowId: String(foreground.windowId), application: foreground.processName, title: foreground.title }
          : null;
        return { route, before, after, movedWindow, windowId, application };
      },
      render: (result) => {
        const target = result.movedWindow ?? { windowId: result.windowId };
        const workspace = result.movedWindow ? null : result.after;
        // Empty is empty whichever way it is measured: nothing in the surface,
        // and nothing for the application to undo.
        const empty = workspace
          ? workspace.contentChars === 0 && workspace.undoEnabled !== true
          : null;
        if (result.movedWindow) {
          state.lastWindow = { windowId: target.windowId, application: result.movedWindow.application };
          state.freshWindows.add(target.windowId);
          return `Used ${result.route}, and a new window is now in front — ${result.movedWindow.application} ` +
            `"${result.movedWindow.title ?? ""}" (windowId ${target.windowId}). That is where typing will go.`;
        }
        // Whatever happened, this is the window being worked in now — so a
        // following `type` is judged against it rather than against whatever was
        // last read.
        if (result.windowId) {
          state.lastWindow = { windowId: String(result.windowId), application: result.application };
        }
        if (empty === true) {
          state.freshWindows.add(String(result.windowId));
          return `Used ${result.route}, and the surface is now empty with nothing to undo — this is a fresh ` +
            "document. Type here.";
        }
        if (empty === false) {
          return `Used ${result.route}, but the window still holds ${result.after.contentChars} characters` +
            `${result.after.title ? ` and is titled "${result.after.title}"` : ""} — so a new document did NOT ` +
            "open. Read the screen and find the application's own New command, or use its File menu.";
        }
        return `Used ${result.route}. I cannot tell whether a new document opened — the application exposes ` +
          "nothing to check it by. UNCONFIRMED: read the screen before typing anything into it.";
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
      description:
        "Write a text file to disk. Creates it, or — if a file with something in it is already there — " +
        "stops and tells you, so you can say whether to replace it or add to it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          contents: { type: "string" },
          existing: {
            type: "string",
            enum: ["replace", "append"],
            description:
              "Only when a file is already there: \"replace\" to overwrite it, \"append\" to add to the end " +
              "of what it already holds."
          }
        },
        required: ["path", "contents"]
      },
      preview: (args) => args.path,
      // THE SAME QUESTION THE DOCUMENT GATE ASKS, ABOUT A FILE.
      //
      // "Wrote notes.txt (replacing what was there)" is an obituary. It is
      // printed after the only copy of whatever was there has gone, and the
      // model — which had no idea a file existed — has no reason to read it and
      // every reason to move on. Asking first costs one file read, and only when
      // there is something to lose.
      execute: async (args) => {
        const filePath = String(args.path);
        const key = filePath.toLowerCase();
        const intent = String(args.existing ?? "").trim();
        // A file this run already wrote is ours to rewrite.
        const readCurrent = async () => {
          try {
            const current = await runCapability("filesystem.read", { filePath });
            return String(current?.contents ?? current?.content ?? "");
          } catch {
            // Missing is the ordinary case and reads as "nothing to lose".
            return "";
          }
        };
        let current = "";
        if (intent || !state.ownedPaths.has(key)) current = await readCurrent();
        if (!intent && !state.ownedPaths.has(key) && current.trim()) {
          const firstLine = current.trim().split(/\r?\n/)[0].slice(0, 80);
          throw new Error(
            `${filePath} already exists and holds ${current.length} characters, starting "${firstLine}". ` +
            "Writing now would destroy it.\n" +
            'Call write_file again with existing: "replace" to overwrite it, or existing: "append" to add ' +
            "to the end of it — or write to a different path."
          );
        }
        const content = intent === "append" && current
          ? `${current}${current.endsWith("\n") ? "" : "\n"}${String(args.contents ?? "")}`
          : String(args.contents ?? "");
        // The capability's input is `content`, singular. Getting this wrong writes
        // an empty file and reports success.
        const result = await runCapability("filesystem.write", { filePath, content });
        state.ownedPaths.add(key);
        return { ...result, appended: intent === "append" && Boolean(current) };
      },
      render: (result) => (result.appended
        ? `Added to the end of ${result.filePath}, keeping what was already in it.`
        : `Wrote ${result.filePath}${result.existed ? " (replacing what was there)" : ""}.`)
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
  // It is NOT "what I am about to do". It is "what I just saw, and what I am
  // therefore doing" — because the first is a caption and the second is
  // reasoning, and the difference is the whole feel of the product.
  //
  // A transcript of captions reads: "Opening WhatsApp." "Looking for Amma."
  // "Opening Amma's chat." "Typing the message." Every one of those lines could
  // have been written before the task started — and when the third step silently
  // clicked the wrong thing, nothing in the narration could have revealed it,
  // because none of it referred to anything actually on screen.
  //
  // The same steps said properly: "WhatsApp is open on the chat list, 138
  // unread. Searching for Amma." "Three things match Amma — the search box, the
  // header, and a chat under Chats. Opening the chat." That is a colleague
  // thinking out loud, and it is checkable: the user can see it about to go
  // wrong.
  // TWO FIELDS, BECAUSE ONE ALWAYS PRODUCED A CAPTION.
  //
  // Asked for "what you saw and what you are doing about it" in a single field,
  // the model wrote the second half and dropped the first, every time: "Selecting
  // all text in Notepad." "Copying the haiku to clipboard." "Reading the
  // clipboard." Perfectly true, entirely forward-looking, and impossible to check
  // — a transcript of those lines is identical whether the previous step worked
  // or silently did nothing. That is exactly how a click on the wrong element got
  // reported as a message sent to someone's mother.
  //
  // A field NAMED for the backward reference cannot be filled in with a plan.
  // "saw" has to be about something that already happened, and quoting it is the
  // one thing that proves the last result was actually read.
  const SAW_PARAMETER = {
    type: "string",
    description:
      "What you are working from RIGHT NOW, quoted concretely. If a tool has just run, it is that result — " +
      "the number, the name, the error, what is on screen: \"Port 3000 is held by PID 41292.\" " +
      "\"Three things match Amma: the search box, the header, and a chat.\" " +
      "\"Rejected: the coordinate is outside the Restore pages dialog, which is in front.\" " +
      "On your very first action, it is what the request itself tells you. Always backward-looking, never a plan."
  };
  const SAY_PARAMETER = {
    type: "string",
    description:
      "What you are doing about it, in one short first-person sentence. \"Looking up what that process is.\" " +
      "\"Opening the chat rather than the search box.\" \"Closing the dialog first.\""
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
          properties: { saw: SAW_PARAMETER, say: SAY_PARAMETER, ...tool.parameters.properties },
          // REQUIRED, not merely asked for.
          //
          // As an optional property the model filled it most of the time and
          // dropped it exactly when a step was routine — so the transcript went
          // silent at the start of a task, which is the one moment the user is
          // definitely watching. The prompt asked for it in three places and lost
          // to the schema, as guidance always does here.
          //
          // `saw` is required for the same reason, and it was the harder lesson:
          // left optional it was dropped on precisely the steps where it mattered
          // most — the ones following a result it had not really read. Requiring
          // it is what makes the transcript checkable rather than decorative.
          required: [...new Set([...(tool.parameters.required ?? []), "saw", "say"])]
        }
      }
    })),

    has: (name) => byName.has(name),

    // A NEW TURN INVALIDATES WHAT IS ON SCREEN, AND NOTHING ELSE.
    //
    // The toolset outlives a single request so the agent keeps its place on the
    // machine between messages. What it must NOT keep is the element table: the
    // user has been at the keyboard since, and a click resolved against a
    // reading taken before their last message lands on wherever that control
    // used to be. Everything else — the working window, the windows we opened,
    // the terminal's directory — is still true, and is what makes "now write a
    // poem in it" mean anything.
    beginTurn() {
      state.elements = [];
    },

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
        const { say, saw, ...inputs } = args;
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
