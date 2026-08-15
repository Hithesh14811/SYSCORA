import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import { MAX_NOTES_CHARS, notesPath, readNotes } from "../../packages/fast-agent/src/notes.js";

const workspace = async () => fs.mkdtemp(path.join(os.tmpdir(), "syscora-notes-"));
const toolsetIn = (basePath) => buildToolset({ registry: { get: () => null }, adapter: {}, basePath });

// Across sessions the agent knew nothing about the person it worked for: which
// folder they meant by "my project", which of two accounts was theirs. All of it
// was worked out at cost, used once, and thrown away when the request ended.
test("a fact written down on one request is in the prompt on the next", async () => {
  const basePath = await workspace();

  const first = toolsetIn(basePath);
  const wrote = await first.execute("remember", { fact: "Projects live in OneDrive/Documents/check." });
  assert.equal(wrote.ok, true);
  assert.match(wrote.text, /Remembered/);

  // A different toolset entirely — a new process, as far as this is concerned.
  const later = toolsetIn(basePath);
  const block = await later.notes();
  assert.match(block, /Projects live in OneDrive\/Documents\/check\./);
  assert.match(block, /WHAT YOU HAVE LEARNED BEFORE/);
});

test("nothing is remembered twice", async () => {
  const basePath = await workspace();
  const toolset = toolsetIn(basePath);
  await toolset.execute("remember", { fact: "Prices should be in rupees." });
  const again = await toolset.execute("remember", { fact: "prices   should be in rupees" });
  assert.match(again.text, /Already remembered/);
  assert.equal((await readNotes(basePath)).length, 1);
});

test("a fact that turned out to be wrong can be taken back", async () => {
  const basePath = await workspace();
  const toolset = toolsetIn(basePath);
  await toolset.execute("remember", { fact: "Amma's chat is titled Amma." });
  await toolset.execute("remember", { fact: "The default browser is Chrome." });

  const forgotten = await toolset.execute("remember", { fact: "Amma", forget: true });
  assert.match(forgotten.text, /Forgotten/);

  const left = await readNotes(basePath);
  assert.deepEqual(left, ["The default browser is Chrome."]);

  const nothing = await toolset.execute("remember", { fact: "something never written", forget: true });
  assert.match(nothing.text, /nothing was removed/);
});

// This block is in the prompt on every step of every task, so it is a budget
// rather than a formality: an unbounded prompt section is how this codebase
// previously reached four million characters.
test("what is remembered is bounded, oldest first out", async () => {
  const basePath = await workspace();
  const toolset = toolsetIn(basePath);
  for (let index = 0; index < 60; index += 1) {
    await toolset.execute("remember", { fact: `Fact number ${index}, which is about something or other.` });
  }
  const kept = await readNotes(basePath);
  assert.ok(kept.join("\n").length <= MAX_NOTES_CHARS, `notes must stay under the ceiling, got ${kept.join("\n").length}`);
  assert.ok(kept.length < 60, "the oldest must fall off");
  assert.match(kept.at(-1), /Fact number 59/, "the newest is always kept");
});

// The file is the user's, in their own state directory, and they may edit it.
// Its heading is not a fact, and reading it back as one made the file grow by
// two lines every time anything was remembered.
test("the file's own heading is never mistaken for something the agent learned", async () => {
  const basePath = await workspace();
  const toolset = toolsetIn(basePath);
  await toolset.execute("remember", { fact: "One real fact." });
  await toolset.execute("remember", { fact: "Another real fact." });

  const raw = await fs.readFile(notesPath(basePath), "utf8");
  assert.equal(raw.match(/# What SYSCORA has learned/g).length, 1, "one heading, not one per write");

  const kept = await readNotes(basePath);
  assert.deepEqual(kept, ["One real fact.", "Another real fact."]);
});

test("no notes file means no prompt section at all", async () => {
  const basePath = await workspace();
  assert.equal(await toolsetIn(basePath).notes(), "");
});
