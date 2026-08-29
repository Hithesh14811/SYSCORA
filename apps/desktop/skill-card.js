// THE ROUTE IT JUST WORKED OUT, OFFERED AS SOMETHING TO KEEP.
//
// `docs/skills.md` calls this "the thing that turns SYSCORA from a demo into
// infrastructure", the production plan calls it "the actual moat", and until
// this file existed no user could accept one. The chain was: the loop offers a
// route (SKILL_OFFERED), the daemon has POST /api/skills to save it, and NOTHING
// IN THE UI RENDERED THE OFFER. The only code in the repository that ever
// accepted one was the eval harness — whose own comment reads "accepting it is a
// separate, explicit step, because in the product a person does that." In the
// product there was nowhere for a person to do that, and the skills directory on
// the real machine was empty.
//
// WHY IT IS OFFERED AND NOT SAVED. Saving silently would put a thing that drives
// the user's machine onto their disk without them agreeing to it, and then replay
// it. §9 says offered, §11 says never hide them. So this card is the consent, and
// the panel next to it is the correction: a skill the user cannot read, rename or
// delete is one they cannot fix when it starts doing the wrong thing.
//
// WHAT THE CARD HAS TO SHOW, and why it shows the steps rather than a summary:
// this is the moment the user decides whether a sequence of actions is allowed to
// run again WITHOUT a model deciding anything. "Save this route?" over a title
// alone asks them to agree to something they cannot see. The steps are the thing
// being agreed to, the same argument as showing a command verbatim on an
// approval card.

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const ICONS = {
  route: '<path d="M6.5 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/><path d="M17.5 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/><path d="M17.5 9.5v3a3 3 0 0 1-3 3h-5a3 3 0 0 0-3 3"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  check: '<path d="M4.8 12.6l4.6 4.6L19 6.8"/>'
};

function svg(name, size = 16) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.7");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  // Constants in this file, never anything a model wrote.
  node.innerHTML = ICONS[name] ?? ICONS.route;
  return node;
}

// One step, in words rather than JSON. A saved route is meant to be readable —
// §2: "a skill the user cannot read is a skill they cannot correct" — and a row
// of `{"tool":"click","args":{"text":"Send"}}` is not reading, it is decoding.
//
// The placeholder braces are kept, because they are the whole point: `{contact}`
// is what makes this a route rather than a recording of one afternoon.
function describeStep(step) {
  const args = step?.args ?? {};
  const target = args.text ?? args.application ?? args.path ?? args.query ?? args.url ?? args.keys ?? null;
  switch (step?.tool) {
    case "launch": return `Open ${target ?? "an application"}`;
    case "focus": return `Bring ${target ?? "it"} to the front`;
    case "click": return `Click ${target ? `"${target}"` : "a control"}${args.section ? ` under "${args.section}"` : ""}`;
    case "type": return `Type ${target ? `"${target}"` : "text"}`;
    case "key": return `Press ${target ?? "a key"}`;
    case "write_file": return `Write ${args.path ?? "a file"}`;
    case "edit_file": return `Edit ${args.path ?? "a file"}`;
    case "read_file": return `Read ${args.path ?? "a file"}`;
    case "run": return `Run ${target ?? "a command"}`;
    case "new_document": return "Start a new document";
    case "window_state": return `${args.state ?? "Resize"} the window`;
    case "open_url": return `Open ${target ?? "a page"}`;
    default: return `${step?.tool ?? "step"}${target ? ` — ${target}` : ""}`;
  }
}

/**
 * The card offering one route. `skill` is the candidate from SKILL_OFFERED.
 *
 * `fetchImpl` is injected so this can be exercised without a daemon; the real
 * call goes through the same authenticated helper every other request uses.
 */
export function skillCard(skill, { fetchImpl = fetch, onSaved = null } = {}) {
  const root = el("div", "skill-card");

  const chip = el("div", "skill-icon");
  chip.appendChild(svg("route", 22));

  const body = el("div", "skill-body");
  body.appendChild(el("div", "skill-name", skill?.title || skill?.id || "A route that worked"));

  const steps = Array.isArray(skill?.steps) ? skill.steps : [];
  const parameters = Array.isArray(skill?.parameters) ? skill.parameters : [];
  const facts = [
    `${steps.length} step${steps.length === 1 ? "" : "s"}`,
    parameters.length ? `${parameters.length} thing${parameters.length === 1 ? "" : "s"} it asks for` : null,
    "replays with no model call"
  ].filter(Boolean);
  body.appendChild(el("div", "skill-facts", facts.join(" · ")));

  // THE STEPS, VISIBLE BEFORE THE YES. Collapsed by default because most routes
  // are short and the answer is usually obvious, open-able because the one time
  // it is not obvious is the time it matters.
  if (steps.length) {
    const details = el("details", "skill-steps");
    const summary = el("summary", "skill-steps-summary", "What it will do");
    details.appendChild(summary);
    const list = el("ol", "skill-step-list");
    for (const step of steps.slice(0, 40)) {
      const item = el("li", "skill-step", describeStep(step));
      // An irreversible step is the one the user most needs to see before
      // agreeing that it may run again unattended. §4.2.
      if (step?.irreversible) item.appendChild(el("span", "skill-step-flag", "cannot be undone"));
      list.appendChild(item);
    }
    details.appendChild(list);
    body.appendChild(details);
  }

  const actions = el("div", "skill-actions");
  const note = el("div", "skill-note", "");

  const button = (label, icon, handler, className = "") => {
    const control = el("button", `skill-button ${className}`.trim());
    control.type = "button";
    control.append(svg(icon), el("span", null, label));
    control.addEventListener("click", handler);
    return control;
  };

  let noteTimer = null;
  const say = (text, tone = "") => {
    clearTimeout(noteTimer);
    note.textContent = text;
    note.className = `skill-note ${tone}`.trim();
  };

  const save = button("Save this route", "save", async () => {
    save.disabled = true;
    dismiss.disabled = true;
    try {
      const response = await fetchImpl("/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skill })
      });
      const json = await response.json().catch(() => ({}));
      // THE SERVER'S ANSWER, NOT THE REQUEST HAVING RETURNED. `writeSkill`
      // refuses a route that cannot be replayed safely — a positional step, a
      // check with nothing to look for — and reports why. Saying "saved" over a
      // 400 would be the same lie the whole evidence layer exists to prevent.
      if (!response.ok || !json.saved) {
        throw new Error((json.problems ?? []).join("; ") || json.error || `The daemon answered ${response.status}.`);
      }
      root.classList.add("saved");
      actions.replaceChildren();
      const done = el("div", "skill-saved");
      done.append(svg("check", 15), el("span", null, "Saved. Next time this will replay without asking the model."));
      actions.appendChild(done);
      say("You can rename or delete it in Skills, and it retires itself if it stops working.", "ok");
      onSaved?.(json.skill ?? skill);
    } catch (error) {
      say(error?.message ?? String(error), "bad");
      save.disabled = false;
      dismiss.disabled = false;
    }
  }, "primary");

  const dismiss = button("Not now", "close", () => {
    root.remove();
  });

  actions.append(save, dismiss);
  root.append(chip, body, actions, note);
  return root;
}

/**
 * A card rebuilt from a saved transcript.
 *
 * The offer belonged to a run that has finished. Re-offering it on reload would
 * let the same route be saved twice under two ids, and the candidate in an old
 * transcript may no longer match what the machine looks like. So a replayed card
 * says what it was rather than pretending the decision is still open.
 */
export function sealReplayedSkill(card) {
  for (const button of card.querySelectorAll(".skill-button")) button.disabled = true;
  card.classList.add("replayed");
  const note = card.querySelector(".skill-note");
  if (note) note.textContent = "Offered in an earlier conversation. Ask again to be offered it once more.";
  return card;
}
