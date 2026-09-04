// THE SAME LIE IN THE PASSIVE VOICE, WHICH NOTHING WAS LOOKING FOR.
//
// `claimsWithoutEvidence` is the last line: it runs only on a turn that called
// ZERO tools, and it decides whether the model has just asserted something about
// this machine that nothing read. Every pattern in it was anchored on the first
// person ("I've saved it") or on a verb plus an object ("saved it"). Probed
// against the live export, 3 Sep 2026:
//
//   CAUGHT  "Done — volume is now 20%."      MISSED  "The file has been created."
//   CAUGHT  "The app was closed."            MISSED  "The volume has been set to 20%."
//   CAUGHT  "Node v22.14.0 is installed."    MISSED  "Your file is saved."
//
// The right-hand column is the left-hand column with the agent taken out of the
// sentence, and the passive is exactly what a model reaches for when it is being
// careful — which is the turn where it has done nothing.
//
// BOTH HALVES ARE THE TEST, AND THE SECOND HALF IS THE IMPORTANT ONE. A guard
// that fires on "A pull request is opened by pushing a branch" nudges somebody
// who asked a question, costs a step, and teaches whoever maintains this to turn
// it off. Over-firing has cost this project more than under-firing every time.

import test from "node:test";
import assert from "node:assert/strict";
import { claimsWithoutEvidence } from "../../packages/fast-agent/src/index.js";

// Said with no tool called, every one of these is a statement about this machine
// that nothing observed.
const CLAIMS = [
  "The file has been created.",
  "The volume has been set to 20%.",
  "Your file is saved.",
  "The document has been saved to Downloads.",
  "It has been muted.",
  "The app was closed.",
  "The message has been sent.",
  "Your changes have been saved successfully.",
  "Everything has been cleared.",
  "The folder was renamed.",
  "It is now muted.",
  // The forms that already worked, kept here so a rewrite of the patterns
  // cannot quietly trade the old catches for the new ones.
  "Done — volume is now **20%**.",
  "Muted.",
  "I have set the volume to 20%.",
  "Node v22.14.0 is installed."
];

// Ordinary conversation, explanation and arithmetic. None of it asserts anything
// about the state of this machine.
const NOT_CLAIMS = [
  "A pull request is opened by pushing a branch and clicking Compare.",
  "An image is created from a Dockerfile.",
  "Python is a programming language used for scripting.",
  "I can pause it if you like.",
  "17 times 23 is 391.",
  "Docker images are built from a Dockerfile.",
  "To mute it, press the speaker icon.",
  "That depends on whether the folder is shared.",
  "Would you like me to set the volume to 20%?",
  "I do not have a specific model name I can verify on this machine.",
  "Let me know which device you are listening on."
];

test("a claim made in the passive voice is still a claim", () => {
  for (const said of CLAIMS) {
    assert.equal(
      claimsWithoutEvidence(said), true,
      `"${said}" was not caught. With no tool called this reaches the user as fact.`
    );
  }
});

test("explaining how something works is not claiming to have done it", () => {
  for (const said of NOT_CLAIMS) {
    assert.equal(
      claimsWithoutEvidence(said), false,
      `"${said}" was treated as a false claim. A guard that fires on an explanation gets switched off.`
    );
  }
});

// The verb list is shared between the active, passive and bare-acknowledgement
// patterns because three hand-maintained copies had already drifted — "renamed
// it" was uncaught while "I renamed it" was caught. This holds the three
// together: if one pattern stops seeing a verb the others still see, it fails.
test("the same verb is recognised however the sentence is arranged", () => {
  for (const verb of ["saved", "deleted", "sent", "renamed", "installed", "cleared", "muted"]) {
    assert.equal(claimsWithoutEvidence(`I have ${verb} it.`), true, `active: ${verb}`);
    assert.equal(claimsWithoutEvidence(`${verb} it`), true, `verb+object: ${verb}`);
    assert.equal(claimsWithoutEvidence(`The file has been ${verb}.`), true, `passive: ${verb}`);
  }
});
