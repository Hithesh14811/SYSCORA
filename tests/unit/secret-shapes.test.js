// A CREDENTIAL THE AGENT READS OFF A WINDOW MUST NOT REACH THE MODEL.
//
// Found 22 Aug 2026, live. The user moved a model API key between devices
// through a WhatsApp chat, so it sat in the chat list PREVIEW — which means it
// was one of the 131 elements in the `screen` reading of WhatsApp, and every
// eval run that looked at WhatsApp posted it to the model endpoint.
//
// The redaction that should have caught it enumerated VENDOR PREFIXES —
// sk / gsk / ghp / github_pat / xox / AKIA. The key began `rn37EXgy.` and
// matched none of them, which is the house rule about a guard that enumerates
// phrasings being a race it cannot win: there is a new inference vendor every
// month and each one invents its own prefix.
//
// So the rule here is the SHAPE, and the shape is the thing every API key has
// and no English has: a long unbroken run of letters and digits containing
// upper case AND lower case AND a digit.
//
// THE SECOND TABLE IS THE IMPORTANT ONE. Over-redaction has cost this project
// more than under-redaction ever has — `***REDACTED_EMAIL***` was typed into a
// login form, `%USERPROFILE%` was typed into PowerShell as a relative path and
// burned a whole task budget, and `/token/i` destroyed the cost metrics of
// 1,673 sessions. A rule that eats file paths, UI Automation class names, UUIDs
// or commit hashes would break the agent's actual work, so each of those is
// pinned here as something that must survive UNCHANGED.

import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeExternalContext } from "../../packages/shared-types/src/external-context.js";
import { ConsentAwareModelProvider } from "../../packages/model-providers/src/index.js";

// Every value here is SYNTHETIC — same shape as the real vendor's, no real key
// is in this repository.
const MUST_NOT_REACH_THE_MODEL = [
  ["a Baseten key, the one this was found by", "ab12CDef.QrsT7uVwXy9zAbCdEf1GhIjKlMnOpQr"],
  ["a Google API key", "AIzaSyD9xQ2mNbVcXz1aSdFgHjKlPoIuYtReWq"],
  ["a Hugging Face token", "hf_QwErTyUiOp1234567890AsDfGhJkLzXcVbNm"],
  ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzNDU2Nzg5MCJ9.aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"],
  ["an OpenAI project key", "sk-proj-AbCd1234EfGh5678IjKl9012MnOp3456QrSt"],
  ["a bare high-entropy token with no prefix at all", "X7kQm2Rv9TzLp4Nw8YbC1JdF6HgS3aEu5Ki0oPqW"]
];

const MUST_SURVIVE_UNCHANGED = [
  ["a Windows path with a year in it", "C:\\Users\\hithe\\Documents\\Project2024\\src\\main.js"],
  ["a POSIX path with a year in it", "/home/hithe/Projects2024/beautify-ecommerce/src"],
  ["a UI Automation class name", "Microsoft.UI.Xaml.Controls.Button2"],
  ["a WebView2 window class", "Chrome_WidgetWin_1"],
  ["a lower-case UUID, which is what an automationId often is", "550e8400-e29b-41d4-a716-446655440000"],
  ["an upper-case UUID", "550E8400-E29B-41D4-A716-446655440000"],
  ["a git commit hash", "6ebd181a2c3d4e5f60718293a4b5c6d7e8f90123"],
  ["the user's own email address, which is the subject of the work", "hitheshs096@gmail.com"],
  ["a long URL with no credential in it", "https://www.google.com/about/careers/applications/jobs"],
  ["an ordinary sentence from a chat", "Hey Kasharp Family! The badminton court is ready, the price is 250"],
  ["a long readable automation id", "ChatListItemGridViewItemContainer"],
  // Live, 23 Aug 2026: the agent saved this file, listed the folder to find it
  // again, and was handed `***REDACTED***.txt`. It called read_file on the
  // placeholder, got ENOENT, and spent five steps working around its own
  // redactor. 32 characters, upper and lower case and a digit — the credential
  // shape exactly, and an entirely ordinary filename.
  ["a file the agent saved itself", "J1_Internships_Software_Engineer.txt"],
  ["a downloaded document", "Hithesh_4CB23AI034_RESUME_Final.pdf"],
  ["a branch name", "feature/Add-Support-For-Windows11-Snap"],
  ["an environment variable a script sets", "SYSCORA_STATE_DIR_Override2026"]
];

test("a credential shaped like any vendor's key never reaches the model", () => {
  for (const [what, secret] of MUST_NOT_REACH_THE_MODEL) {
    // Wrapped in the sentence a screen reading would actually carry it in, so
    // this tests the string as it occurs rather than in isolation.
    const reading = `dataitem "Amma 1:40 pm ${secret}" @849,801`;
    const sent = sanitizeExternalContext(reading);
    assert.ok(
      !sent.includes(secret),
      `${what} survived the trip to the model: ${sent}`
    );
    assert.match(sent, /REDACTED/, `${what} should leave a visible placeholder`);
    // The rest of the reading has to survive, or the agent cannot tell which
    // chat it is looking at.
    assert.match(sent, /dataitem "Amma 1:40 pm/, `${what} took the surrounding reading with it`);
    assert.match(sent, /@849,801/, `${what} took the element's coordinates with it`);
  }
});

test("nothing the agent needs to do its job is mistaken for a credential", () => {
  for (const [what, innocent] of MUST_SURVIVE_UNCHANGED) {
    const sent = sanitizeExternalContext(`the element reads ${innocent} and is clickable`);
    assert.ok(
      sent.includes(innocent),
      `${what} was redacted — this is how "***REDACTED_EMAIL***" got typed into a login form: ${sent}`
    );
  }
});

// The whole reading, not one field: a chat list is where this was found, and the
// agent has to come out of it still able to name and click the right row.
test("a WhatsApp chat list keeps every chat name while losing the key in one of them", () => {
  const reading = [
    'Window: WhatsApp.Root - (134) WhatsApp (windowId 133084)',
    'dataitem "Amma 1:40 pm ab12CDef.QrsT7uVwXy9zAbCdEf1GhIjKlMnOpQr" @849,801',
    'dataitem "CEC 2023 Batch Fourth Years 1:24 pm Adobe X Krutanic organised" @849,972',
    'dataitem "Kasharp Fitness 10:33 am the badminton court is ready" @849,1447',
    'edit "Search or start a new chat" @907,575'
  ].join("\n");
  const sent = sanitizeExternalContext(reading);

  assert.ok(!sent.includes("ab12CDef.QrsT7uVwXy9zAbCdEf1GhIjKlMnOpQr"), "the key is still in the reading");
  for (const needle of ["Amma", "CEC 2023 Batch Fourth Years", "Kasharp Fitness", "Search or start a new chat"]) {
    assert.ok(sent.includes(needle), `"${needle}" was lost, so the agent can no longer find that chat`);
  }
  assert.ok(sent.includes("windowId 133084"), "the window identity was lost");
});

// A CORRECT REDACTOR NOTHING CALLS IS THIS PROJECT'S MOST COMMON BUG.
//
// Ten sessions running, the biggest find has been machinery that was right and
// unreachable — `autoApprove` never read on the hot path, `close()` called by
// nothing but probes. So this does not read the source and conclude the
// sanitizer is wired up. It builds the object the loop is actually handed —
// `reasoningEngine.modelProvider` is a ConsentAwareModelProvider, and
// FastAgent calls `.chat()` on it — puts a key in a message, and checks what
// arrives at the far side.
test("the provider the agent loop is given redacts before the request leaves", async () => {
  const secret = "ab12CDef.QrsT7uVwXy9zAbCdEf1GhIjKlMnOpQr";
  let received = null;
  const provider = new ConsentAwareModelProvider({
    provider: {
      name: "recording-stub",
      capabilities: () => ({ remote: true }),
      chat: async (request) => { received = request; return { text: "ok" }; }
    },
    consentScopes: ["EXTERNAL_AI_SANITIZED_REASONING", "EXTERNAL_AI_STRUCTURED_UI_CONTEXT"]
  });

  await provider.chat({
    messages: [
      { role: "user", content: "send Amma a message" },
      { role: "tool", content: `dataitem "Amma 1:40 pm ${secret}" @849,801` }
    ]
  });

  assert.ok(received, "the request never reached the provider underneath");
  const delivered = JSON.stringify(received.messages);
  assert.ok(!delivered.includes(secret), `the key reached the endpoint: ${delivered}`);
  assert.match(delivered, /REDACTED/, "nothing was redacted at all — is the sanitizer still called here?");
  assert.match(delivered, /send Amma a message/, "the user's own request must survive intact");
});
