// Proving a replayed step actually did something.
//
// A step without verification is a step that cannot be trusted to have worked,
// and the replayer must not go past one — that is the whole safety argument for
// driving somebody's machine with no model in the loop.
//
// THREE STATES, NOT TWO. VERIFIED means the machine says so. FAILED means the
// machine says otherwise. UNCONFIRMED means we could not tell, which is neither
// — and this codebase has been bitten by every gate that collapsed the third
// into the second and threw away correct work. The replayer hands over on
// anything that is not VERIFIED, so an unconfirmed step costs a handover rather
// than a wrong claim, and the reason it gives says which of the two it was.

const verdict = (status, message, evidence = null) => ({ status, message, evidence });

const VERIFIED = (message, evidence) => verdict("VERIFIED", message, evidence);
const FAILED = (message, evidence) => verdict("FAILED", message, evidence);
const UNCONFIRMED = (message) => verdict("UNCONFIRMED", message);

function labelsFrom(readingText) {
  // The reading lists one element per line as `index| role "text" @x,y`. The
  // labels are what a step can be written against, so they are what a check
  // looks at.
  return [...String(readingText ?? "").matchAll(/^\s*\d+\|\s*\S+\s+"([^"]*)"/gm)].map((match) => match[1]);
}

function titleFrom(readingText) {
  const found = String(readingText ?? "").match(/^Window:\s*(.*)$/m);
  return found ? found[1] : "";
}

const includesFold = (haystack, needle) =>
  String(haystack ?? "").toLowerCase().includes(String(needle ?? "").toLowerCase());

/**
 * Check one step's `verify` clause against the machine.
 *
 * `execute` is the toolset's, so a check runs the same tools everything else
 * does — but never the tool it is checking: a click is proved by a READING, and
 * a typed message by asking the application what its focused control holds.
 * Verification that shares a code path with the thing it verifies can be fooled
 * by the same bug.
 */
export async function verifyReplayStep(check, { execute, focusedValue = null, lastResult = null } = {}) {
  if (!check?.kind) return VERIFIED("no check was asked for");
  const value = check.value ?? check.text ?? "";

  switch (check.kind) {
    case "element-present":
    case "element-absent": {
      const reading = await execute("screen", {});
      if (!reading?.ok) return UNCONFIRMED(`the screen could not be read: ${String(reading?.text ?? "").slice(0, 120)}`);
      // An empty `value` means "did anything come back at all" — which is what a
      // launch or a click with nothing specific to look for can honestly claim.
      const labels = labelsFrom(reading.text);
      if (!value) {
        return labels.length > 0
          ? VERIFIED(`${labels.length} elements are on screen`)
          : UNCONFIRMED("the reading listed nothing, so there is no evidence either way");
      }
      const present = labels.some((label) => includesFold(label, value));
      if (check.kind === "element-absent") {
        return present ? FAILED(`"${value}" is still on screen`) : VERIFIED(`"${value}" is gone`);
      }
      return present
        ? VERIFIED(`"${value}" is on screen`)
        : FAILED(`nothing on screen is labelled "${value}"`);
    }

    case "window-title-contains": {
      const reading = await execute("screen", {});
      if (!reading?.ok) return UNCONFIRMED("the screen could not be read");
      const title = titleFrom(reading.text);
      if (!title) return UNCONFIRMED("the reading did not say which window it was");
      return includesFold(title, value)
        ? VERIFIED(`the window is "${title}"`)
        : FAILED(`the window is "${title}", which does not contain "${value}"`);
    }

    // SENDING IS NOT TYPING. Words on screen do not mean a message went: text
    // sitting unsent in the box looks exactly the same.
    //
    // BUT AN EMPTY BOX DOES NOT MEAN IT WENT EITHER, AND THIS USED TO SAY IT DID.
    // Measured on WhatsApp: the message box publishes value="\n" WHEN IT IS
    // EMPTY. Trimmed, that is "", so this returned VERIFIED for a box that had
    // never held anything — which is precisely the run where the text went into
    // the search field and the agent announced a message it had not sent.
    //
    // Emptiness can only ever REFUTE a send, never prove one. The proof is
    // `message-in-conversation` below, which reads the chat instead.
    case "input-empty": {
      if (typeof focusedValue !== "function") return UNCONFIRMED("nothing here can read the focused control");
      if (!String(value)) return UNCONFIRMED("the check does not say which text should have left the box");
      const held = await focusedValue();
      if (held === null || held === undefined) {
        return UNCONFIRMED("the application did not say what the focused control holds");
      }
      const text = String(held).trim();
      return includesFold(text, value)
        ? FAILED(`the text is still sitting in the box: ${JSON.stringify(text.slice(0, 60))}`)
        : UNCONFIRMED(
          `the box does not hold ${JSON.stringify(String(value).slice(0, 40))} — but an empty box is not ` +
          "evidence of a send, only of an empty box");
    }

    // THE ONLY HONEST CONFIRMATION OF A SEND: THE MESSAGE IS IN THE CONVERSATION.
    //
    // Deliberately a different code path from everything the send used. The
    // keystroke went through the input engine; the box was read through UIA's
    // focused element; this reads the window. A check that shares a path with
    // the thing it checks fails the same way it does.
    //
    // This became possible on 16 Aug: Chromium publishes message text with
    // IsControlElement=false, so a reading used to show `group "You:"` and never
    // the words. See Get-HiddenTextTargets in restore-host.ps1.
    case "message-in-conversation": {
      if (!String(value)) return UNCONFIRMED("the check does not say which message to look for");
      const reading = await execute("screen", {});
      if (!reading?.ok) return UNCONFIRMED(`the screen could not be read: ${String(reading?.text ?? "").slice(0, 120)}`);
      // The INPUT BOX also matches the words. Only a line that is not the box
      // counts — the whole point is telling a sent bubble from unsent text.
      const lines = String(reading.text ?? "").split("\n").filter((line) => /^\s*\d+\|/.test(line));
      const inConversation = lines.filter((line) =>
        includesFold(line, value) && !/^\s*\d+\|\s*(edit|combobox|searchbox)\b/i.test(line));
      if (inConversation.length === 0) {
        const inBox = lines.some((line) => includesFold(line, value));
        return FAILED(inBox
          ? "the message is on screen ONLY in the input box — it was never sent"
          : `nothing in the conversation reads ${JSON.stringify(String(value).slice(0, 40))}`);
      }
      return VERIFIED(`the conversation shows it: ${inConversation[0].trim().slice(0, 100)}`);
    }

    case "file-exists":
    case "file-contains": {
      const path = check.path ?? value;
      if (!path) return UNCONFIRMED("no path was given to check");
      const result = check.kind === "file-exists"
        ? await execute("run", { command: `Test-Path '${String(path).replace(/'/g, "''")}'` })
        : await execute("run", { command: `Get-Content '${String(path).replace(/'/g, "''")}' -Raw` });
      if (!result?.ok) return FAILED(`could not read ${path}`);
      if (check.kind === "file-exists") {
        return /true/i.test(String(result.text))
          ? VERIFIED(`${path} exists`)
          : FAILED(`${path} does not exist`);
      }
      return includesFold(result.text, check.contains ?? value)
        ? VERIFIED(`${path} contains it`)
        : FAILED(`${path} does not contain ${JSON.stringify(String(check.contains ?? value).slice(0, 40))}`);
    }

    case "command-output-contains": {
      // The step's own result, not a second run of it: running a command twice
      // to check it ran is how something gets installed, or sent, twice.
      const text = String(lastResult?.text ?? "");
      if (!text) return UNCONFIRMED("the step returned nothing to check");
      // AN EMPTY NEEDLE MATCHES EVERYTHING, WHICH IS NOT EVIDENCE OF ANYTHING.
      //
      // Recorded routes carry this check with no value, and `"".includes("")`
      // is true — so the first skill ever replayed here wrote its file to a
      // corrupted path, produced no output worth the name, and reported the
      // step VERIFIED. The eval caught it only because verification checks the
      // machine. A check with nothing to look for cannot pass.
      if (!String(value)) return UNCONFIRMED("the check does not say what the output should contain");
      return includesFold(text, value)
        ? VERIFIED("the output contains it")
        : FAILED(`the output does not contain ${JSON.stringify(String(value).slice(0, 40))}`);
    }

    default:
      // An unknown check is not a pass. A skill file the user has edited can
      // name anything, and treating that as proof is exactly the false success
      // this whole mechanism exists to prevent.
      return UNCONFIRMED(`"${check.kind}" is not a check this knows how to make`);
  }
}
