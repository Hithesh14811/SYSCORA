// What the agent has learned about this person and this machine.
//
// Everything else it knows dies with the request. The machine profile is read
// from Windows, the screen is read from the screen, and the conversation belongs
// to the client — so across sessions the agent starts from nothing, every time,
// and re-derives the same facts it derived yesterday: which folder the user
// means by "my project", that their mother's chat is under a different name than
// "Amma", that they want prices in rupees, that the work laptop signs into a
// different account.
//
// This is the small, durable part. Not a transcript and not a knowledge base:
// a short list of facts the agent chose to write down, put in front of the model
// with the machine profile, and bounded hard — because it is paid for on every
// step of every task, exactly like the system prompt.
//
// Deliberately a plain markdown list in the user's own state directory. They can
// read it, edit it in Notepad, or delete it, and nothing about that surprises
// them. A memory the user cannot inspect is a memory they cannot correct.

import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../shared-types/src/state-path.js";

// Roughly 375 tokens at the ceiling. It sits in the prompt for the life of every
// task, so this is a real budget rather than a formality.
export const MAX_NOTES_CHARS = 1500;
export const MAX_NOTES = 40;
// One fact should be one sentence. Anything longer is a transcript.
export const MAX_NOTE_CHARS = 200;

export function notesPath(basePath) {
  return path.join(resolveStateDir(basePath), "notes.md");
}

function normalize(fact) {
  return String(fact ?? "").replace(/\s+/g, " ").trim().replace(/^[-*]\s*/, "");
}

// Same fact, written twice. Case and a trailing full stop are the whole
// difference between "Prices should be in rupees." and "prices should be in
// rupees", and remembering both would spend the budget saying one thing twice.
function comparable(fact) {
  return normalize(fact).toLowerCase().replace(/[.!?;:,]+$/, "").trim();
}

function sameFact(left, right) {
  return comparable(left) === comparable(right);
}

/**
 * The remembered facts, oldest first. Never throws; no file means no facts.
 *
 * Only bulleted lines are facts. The file's own heading and the sentence telling
 * the user they may edit it are not — and without this they were read back as
 * two more things the agent had learned, then written out again beneath a fresh
 * copy of the heading, growing by two lines every time anything was remembered.
 */
export async function readNotes(basePath) {
  try {
    const raw = await fs.readFile(notesPath(basePath), "utf8");
    return raw
      .split(/\r?\n/)
      .filter((line) => /^\s*[-*]\s+\S/.test(line))
      .map((line) => normalize(line))
      .filter(Boolean)
      .slice(-MAX_NOTES);
  } catch {
    return [];
  }
}

async function writeNotes(basePath, notes) {
  const file = notesPath(basePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const header = "# What SYSCORA has learned\n\n" +
    "One fact per line, each starting with a dash. Edit or delete anything here; it is read fresh on\n" +
    "every request. Lines that are not bulleted are ignored, so this note is not one of the facts.\n\n";
  await fs.writeFile(file, `${header}${notes.map((note) => `- ${note}`).join("\n")}\n`, "utf8");
}

/**
 * Write a fact down. Returns what is now remembered, and what fell off the end.
 *
 * Bounded two ways, because an unbounded prompt section is how this codebase
 * previously reached four million characters: a cap on how many facts are kept,
 * and a cap on the total size. When it is full, the OLDEST goes — a fact the
 * agent has not thought about in weeks is the one least likely to matter.
 */
export async function rememberNote(basePath, fact) {
  const note = normalize(fact).slice(0, MAX_NOTE_CHARS);
  if (!note) return { added: false, reason: "empty", notes: await readNotes(basePath) };
  const existing = await readNotes(basePath);
  if (existing.some((other) => sameFact(other, note))) {
    return { added: false, reason: "already-known", notes: existing };
  }
  const notes = [...existing, note];
  const dropped = [];
  while (notes.length > MAX_NOTES || notes.join("\n").length > MAX_NOTES_CHARS) {
    const removed = notes.shift();
    if (removed === undefined) break;
    dropped.push(removed);
  }
  await writeNotes(basePath, notes);
  return { added: true, note, notes, dropped };
}

/** Drop every fact containing `match`, case-insensitively. */
export async function forgetNote(basePath, match) {
  const needle = normalize(match).toLowerCase();
  const existing = await readNotes(basePath);
  if (!needle) return { removed: [], notes: existing };
  const removed = existing.filter((note) => note.toLowerCase().includes(needle));
  if (removed.length === 0) return { removed, notes: existing };
  const notes = existing.filter((note) => !removed.includes(note));
  await writeNotes(basePath, notes);
  return { removed, notes };
}

/** The prompt block, or "" when there is nothing to say. */
export function describeNotes(notes) {
  if (!notes?.length) return "";
  return [
    "WHAT YOU HAVE LEARNED BEFORE — written down on earlier requests by this user. " +
    "Treat it as true unless what you see now says otherwise, and correct it with `remember` when it is wrong.",
    ...notes.map((note) => `- ${note}`)
  ].join("\n");
}
