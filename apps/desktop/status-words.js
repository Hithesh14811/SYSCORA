// THE WORDS THE SURFACE USES FOR WHAT THE AGENT IS DOING.
//
// Extracted so the chat and the floating pill say the SAME thing. They were the
// chat's alone; the pill invented its own three words ("Connecting", "Working",
// "Writing") and the result was a bar that said "Working" while the chat beside
// it said "Searching the web" — two surfaces describing one run differently,
// which is exactly the drift a shared table exists to prevent.
//
// Three tenses, and the distinction is load-bearing:
//
//   PENDING  the model is still WRITING the call. Nothing has touched the
//            machine, so "Writing the file" here would be the same class of
//            claim as a message reported sent while it sits in a box.
//   RUNNING  it is happening now.
//   PAST     it happened. This is what the transcript rows are titled with.
//
// A TOOL MISSING FROM THESE TABLES IS RENDERED "Ran a step", which is worse than
// it sounds: the transcript exists so the user can follow what is happening, and
// an anonymous row tells them nothing. Every verb the loop adds needs a line.

export const VERB = [
  [/^command\.run$|^developer\.command\.run$/, "Ran"],
  [/^screen\.(read|capture)$|^ocr\./, "Looked at the screen"],
  [/^ui\.(inspect|find|extract|resolveTarget|verifyValue)$/, "Inspected the window"],
  [/^ui\.action$/, "Used a control"],
  [/^pointer\.(click|clickAt)$/, "Clicked"],
  [/^pointer\.wheel$/, "Scrolled"],
  [/^pointer\.(drag|move)$/, "Moved the pointer"],
  [/^keyboard\.type$/, "Typed"],
  [/^keyboard\.press$/, "Pressed a key"],
  [/^clipboard\./, "Used the clipboard"],
  [/^window\./, "Adjusted a window"],
  [/^application\.launch$|^process\.launch$/, "Opened"],
  [/^application\.close$/, "Closed"],
  [/^filesystem\.(read|list|search)$/, "Read from disk"],
  [/^filesystem\.(write|createDirectory|delete)$/, "Wrote to disk"],
  [/^browser\.(navigate|launch|connect)$/, "Opened a page"],
  [/^browser\.(read|extract|find|inspect|currentState|research|search)$/, "Read the page"],
  [/^browser\./, "Used the browser"],
  [/^system\./, "Checked the system"],
  [/^package\./, "Checked packages"],
  [/^spotify\./, "Used Spotify"]
];

// The agent loop's tools are already named the way a person would name them, so
// these are just the past tense.
// A TOOL MISSING FROM HERE IS RENDERED "Ran a step".
//
// Which is worse than it sounds: the transcript exists so the user can follow
// what is happening, and four of the loop's verbs — including the two that draw
// and the one that does everything at once — showed up as an anonymous row.
// Every entry the loop adds needs a line here.
export const TOOL_VERB = {
  run: "Ran",
  run_jobs: "Checked a background command",
  screen: "Looked at the screen",
  click: "Clicked",
  type: "Typed",
  key: "Pressed",
  scroll: "Scrolled",
  drag: "Dragged",
  draw: "Drew",
  move_mouse: "Moved the pointer",
  launch: "Opened",
  new_document: "Started a new document",
  open_url: "Opened a page",
  windows: "Listed the windows",
  focus: "Focused a window",
  window_state: "Adjusted a window",
  close_app: "Closed",
  read_file: "Read a file",
  write_file: "Wrote a file",
  edit_file: "Edited a file",
  clipboard: "Used the clipboard",
  play_music: "Played",
  volume: "Set the volume",
  search: "Searched the web",
  web_open: "Opened a page",
  web_read: "Read the page",
  web_click: "Clicked on the page",
  web_type: "Typed on the page",
  web_scroll: "Scrolled the page",
  batch: "Ran several steps",
  wait: "Waited",
  github: "Read a repository",
  capability: "Used a saved capability",
  // "Prepared", never "Sent". The row is the transcript's record of what the
  // tool did, and this tool draws a card — see email_draft in tools.js.
  email_draft: "Prepared an email"
};

export function verbFor(capability) {
  const name = String(capability ?? "");
  if (TOOL_VERB[name]) return TOOL_VERB[name];
  for (const [pattern, verb] of VERB) if (pattern.test(name)) return verb;
  return "Ran a step";
}

// WHAT IT IS DOING, IN THE PRESENT TENSE, WHILE IT IS DOING IT.
//
// Every row used to be written in the past tense the moment it opened — a search
// that had not answered yet said "Searched the web", which is the same class of
// claim as reporting a message sent while it sits in a box. The row is rewritten
// to the past tense in finishStep, when it has actually finished.
export const TOOL_VERB_RUNNING = {
  search: "Searching the web",
  web_open: "Reading the page",
  web_read: "Reading the page",
  run: "Running",
  run_jobs: "Checking a background command",
  screen: "Looking at the screen",
  read_file: "Reading the file",
  write_file: "Writing the file",
  launch: "Opening",
  github: "Reading the repository",
  capability: "Using a saved capability",
  email_draft: "Writing an email"
};

// ---- What a tool LOOKS like --------------------------------------------------
//
// These were emoji — 🌐, 📄, 📁 — and emoji are the fastest way to make a
// professional surface look like a hobby project: they are colour pictures from
// a system font, at a different size and weight from everything around them,
// and they cannot be tinted to say whether the step worked. These are line
// icons on the same 24-unit grid as every other icon in this window, drawn in
// `currentColor` so the row's state colours them.

export function runningVerbFor(capability) {
  return TOOL_VERB_RUNNING[String(capability ?? "")] ?? verbFor(capability);
}

// BEFORE IT RUNS IS A THIRD TENSE, AND IT IS NOT "RUNNING".
//
// A pending row is drawn while the model is still WRITING the call — nothing has
// touched the machine, so "Writing the file" would be the same class of claim as
// a message reported sent while it sits in a box. These say what is actually
// happening, which is that the model is composing something.
export const TOOL_VERB_PENDING = {
  write_file: "Composing the file",
  edit_file: "Composing the edit",
  new_document: "Composing the document",
  email_draft: "Composing the email",
  run: "Composing the command",
  type: "Composing the text",
  draw: "Composing the strokes",
  batch: "Composing several steps"
};

export function pendingVerbFor(capability) {
  return TOOL_VERB_PENDING[String(capability ?? "")] ?? "Preparing";
}

/** How much of the call has been written so far. Bytes of JSON, said plainly. */

// THE STATUS LINE'S OWN WORDS, for the moments that are not a tool call.
//
// "Connecting…" and not "Thinking…" until a reasoning token actually arrives:
// measured against this endpoint, the first byte comes back at 631ms and the
// first reasoning token at 1,430ms, so for a second and a half "thinking"
// described a request sitting on a wire.
export const STATUS = Object.freeze({
  CONNECTING: "Connecting…",
  THINKING: "Thinking…",
  WRITING: "Writing…",
  APPROVAL: "Waiting for your approval…"
});
