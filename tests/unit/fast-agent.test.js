import test from "node:test";
import assert from "node:assert/strict";
import { FastAgent, buildToolset, claimsWithoutEvidence, looksUnfinished, wasTruncated } from "../../packages/fast-agent/src/index.js";

// A provider that plays back scripted turns. Each turn is what a real endpoint
// would stream: some prose, then zero or more tool calls.
function scriptedProvider(turns) {
  const seen = [];
  return {
    seen,
    supportsChat: () => true,
    async chat({ messages, tools, onTextDelta }) {
      seen.push(structuredClone(messages));
      const turn = turns.shift() ?? { text: "Done." };
      assert.ok(Array.isArray(tools), "the loop must send the tool definitions");
      // Stream the prose the way the wire does, a fragment at a time.
      for (const word of String(turn.text ?? "").match(/\S+\s*/g) ?? []) onTextDelta?.(word);
      return {
        text: turn.text ?? "",
        toolCalls: (turn.toolCalls ?? []).map((call, index) => ({
          id: `call_${index}`,
          name: call.name,
          arguments: JSON.stringify(call.args ?? {})
        })),
        // A turn can declare its own — "length" is what a provider says when it
        // cut the reply off at the token ceiling, and the loop has to notice.
        finishReason: turn.finishReason ?? (turn.toolCalls?.length ? "tool_calls" : "stop")
      };
    }
  };
}

function stubToolset(handlers = {}) {
  return {
    definitions: [{ type: "function", function: { name: "run", description: "", parameters: {} } }],
    has: (name) => name in handlers,
    previewOf: () => "",
    async execute(name, args) {
      const handler = handlers[name];
      if (!handler) return { ok: false, text: `There is no tool called "${name}".` };
      return handler(args);
    }
  };
}

test("the model's words stream out before any tool has finished", async () => {
  const events = [];
  const agent = new FastAgent({
    provider: scriptedProvider([{ text: "I'll check that for you." }]),
    toolset: stubToolset(),
    onEvent: (event) => events.push(event)
  });

  const outcome = await agent.run("what version of node is installed");

  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.message, "I'll check that for you.");
  const deltas = events.filter((event) => event.type === "AGENT_DELTA");
  assert.ok(deltas.length > 1, "prose must arrive in fragments, not one block at the end");
  assert.equal(deltas.map((event) => event.details.text).join("").trim(), "I'll check that for you.");
});

test("a tool call runs and its output goes back into the same conversation", async () => {
  const provider = scriptedProvider([
    { text: "Checking.", toolCalls: [{ name: "run", args: { command: "node --version" } }] },
    { text: "Node 22.3.0 is installed." }
  ]);
  const events = [];
  const agent = new FastAgent({
    provider,
    toolset: stubToolset({ run: async (args) => ({ ok: true, text: `v22.3.0\nexit 0`, durationMs: 12, raw: args }) }),
    onEvent: (event) => events.push(event)
  });

  const outcome = await agent.run("which node version do I have");

  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.message, "Node 22.3.0 is installed.");
  assert.equal(outcome.toolCalls, 1);

  // The second request must carry the assistant's tool call AND its result, so
  // the model is continuing one conversation rather than being re-prompted.
  const second = provider.seen[1];
  const assistant = second.find((message) => message.role === "assistant" && message.tool_calls);
  assert.ok(assistant, "the assistant turn with its tool call must be replayed");
  assert.equal(assistant.tool_calls[0].function.name, "run");
  const toolResult = second.find((message) => message.role === "tool");
  assert.match(toolResult.content, /v22\.3\.0/);

  const started = events.find((event) => event.type === "TOOL_STARTED");
  const finished = events.find((event) => event.type === "TOOL_FINISHED");
  assert.equal(started.details.tool, "run");
  assert.equal(finished.details.ok, true);
});

test("a failing tool is reported to the model as a result, not as the end of the task", async () => {
  const provider = scriptedProvider([
    { text: "Trying.", toolCalls: [{ name: "run", args: { command: "nope" } }] },
    { text: "That command does not exist here; nothing was changed." }
  ]);
  const agent = new FastAgent({
    provider,
    toolset: stubToolset({ run: async () => ({ ok: false, text: "run failed: not recognised" }) })
  });

  const outcome = await agent.run("run nope");

  assert.equal(outcome.status, "COMPLETED");
  assert.match(provider.seen[1].find((message) => message.role === "tool").content, /not recognised/);
});

test("an invented tool name is answered with the real list instead of ending the run", async () => {
  const provider = scriptedProvider([
    { text: "", toolCalls: [{ name: "os_api.disk_space", args: {} }] },
    { text: "Recovered." }
  ]);
  const agent = new FastAgent({ provider, toolset: stubToolset({ run: async () => ({ ok: true, text: "ok" }) }) });

  const outcome = await agent.run("how much disk space");

  assert.equal(outcome.status, "COMPLETED");
  assert.match(provider.seen[1].find((message) => message.role === "tool").content, /no tool called/i);
});

// Live, told "(699, 1186) is outside Restore pages?", the model clicked the same
// coordinate again, got the same error, and clicked it a third time. Nothing had
// changed between them, so nothing could.
test("an identical call that already failed is refused instead of repeated", async () => {
  let runs = 0;
  const provider = scriptedProvider([
    { text: "", toolCalls: [{ name: "run", args: { command: "click there" } }] },
    { text: "", toolCalls: [{ name: "run", args: { command: "click there" } }] },
    { text: "Tried something else instead." }
  ]);
  const events = [];
  const agent = new FastAgent({
    provider,
    toolset: stubToolset({
      run: async () => { runs += 1; return { ok: false, text: "(699, 1186) is outside Restore pages?" }; }
    }),
    onEvent: (event) => events.push(event)
  });

  await agent.run("click the field");

  assert.equal(runs, 1, "the second identical call must not reach the machine");
  const refusal = events.filter((event) => event.type === "TOOL_FINISHED").at(-1);
  assert.equal(refusal.details.repeated, true);
  assert.match(refusal.details.output, /already ran exactly this/i);
  // And the model is told what it failed with, so it can choose a real alternative.
  assert.match(refusal.details.output, /outside Restore pages/);
  assert.match(refusal.details.output, /Change something/);
});

// A REFUSAL THAT NEVER EXPIRES IS A TASK THAT CANNOT RECOVER.
//
// Click "Save" — not on screen. Open the File menu. Click "Save" again: refused,
// "you already ran exactly this and it failed", for a reason that stopped being
// true when the menu opened. The guard exists to stop a loop of identical
// attempts with nothing in between, and a successful call in between is exactly
// what makes the next attempt a different one.
test("a call that failed can be tried again once something else has worked", async () => {
  const attempted = [];
  const provider = scriptedProvider([
    { text: "", toolCalls: [{ name: "click", args: { text: "Save" } }] },
    { text: "", toolCalls: [{ name: "menu", args: { open: "File" } }] },
    { text: "", toolCalls: [{ name: "click", args: { text: "Save" } }] },
    { text: "Saved." }
  ]);
  const agent = new FastAgent({
    provider,
    toolset: stubToolset({
      click: async (args) => {
        attempted.push("click");
        // It works once the menu has been opened.
        return attempted.includes("menu")
          ? { ok: true, text: "Clicked Save." }
          : { ok: false, text: 'Nothing on screen is labelled "Save".' };
      },
      menu: async () => { attempted.push("menu"); return { ok: true, text: "File menu open." }; }
    })
  });

  const outcome = await agent.run("save the file");
  assert.deepEqual(attempted, ["click", "menu", "click"],
    "the second Save must reach the machine, because the world changed in between");
  assert.equal(outcome.status, "COMPLETED");
});

// A different argument is a different attempt and must still run.
test("a changed argument is a real second attempt, not a repeat", async () => {
  let runs = 0;
  const provider = scriptedProvider([
    { text: "", toolCalls: [{ name: "run", args: { command: "a" } }] },
    { text: "", toolCalls: [{ name: "run", args: { command: "b" } }] },
    { text: "Done." }
  ]);
  const agent = new FastAgent({
    provider,
    toolset: stubToolset({ run: async () => { runs += 1; return { ok: false, text: "nope" }; } })
  });

  await agent.run("try twice");
  assert.equal(runs, 2);
});

// The narration is shown on its own line; repeating it as the tool's argument
// rendered rows reading `windows  Checking all open windows to find the...`.
test("narration is not shown as if it were an argument", async () => {
  const provider = scriptedProvider([
    {
      text: "",
      toolCalls: [{
        name: "run",
        args: { saw: "Port 3000 is held by PID 41292.", say: "Looking up that process.", command: "dir" }
      }]
    },
    { text: "Done." }
  ]);
  const events = [];
  const agent = new FastAgent({
    provider,
    toolset: stubToolset({ run: async () => ({ ok: true, text: "ok" }) }),
    onEvent: (event) => events.push(event)
  });

  await agent.run("look");

  const started = events.find((event) => event.type === "TOOL_STARTED");
  assert.deepEqual(started.details.args, { command: "dir" }, "only real arguments reach the tool row");

  // The observation and the intent are carried separately, so the surface can
  // show what was read as the evidence for what is being done.
  const said = events.find((event) => event.type === "AGENT_SAYS");
  assert.equal(said.details.observed, "Port 3000 is held by PID 41292.");
  assert.equal(said.details.text, "Looking up that process.");
});

test("every tool asks for the observation as well as the intent", async () => {
  const { buildToolset: build } = await import("../../packages/fast-agent/src/tools.js");
  const toolset = build({ registry: { get: () => null }, adapter: {} });
  for (const definition of toolset.definitions) {
    const properties = definition.function.parameters.properties;
    assert.ok(properties.saw, `${definition.function.name} must ask what was observed`);
    assert.ok(properties.say, `${definition.function.name} must ask what is being done`);
    assert.match(properties.saw.description, /backward-looking/,
      "the field must be described backwards, or it gets filled in with a plan");
    // Left optional, both were dropped on exactly the steps that mattered: `say`
    // on the first action, when the user is definitely watching, and `saw` on the
    // steps following a result it had not really read.
    for (const field of ["saw", "say"]) {
      assert.ok(definition.function.parameters.required.includes(field),
        `${definition.function.name} must REQUIRE ${field}; asking for it in the prompt is not enough`);
    }
  }
});

// The user's stop button. A queued sequence of clicks and keystrokes must not
// keep landing after they have asked it to stop.
test("stopping takes effect before the next tool runs, not after the queue drains", async () => {
  const controller = new AbortController();
  const ran = [];
  const provider = scriptedProvider([{
    text: "Working.",
    toolCalls: [
      { name: "run", args: { command: "first" } },
      { name: "run", args: { command: "second" } },
      { name: "run", args: { command: "third" } }
    ]
  }]);
  const agent = new FastAgent({
    provider,
    signal: controller.signal,
    toolset: stubToolset({
      run: async (args) => {
        ran.push(args.command);
        if (args.command === "first") controller.abort();
        return { ok: true, text: "ok" };
      }
    })
  });

  const outcome = await agent.run("do three things");

  assert.equal(outcome.status, "CANCELLED");
  assert.deepEqual(ran, ["first"], "the queued calls after the stop must not run");
  assert.match(outcome.message, /still in place/);
});

// Pressing stop aborts the in-flight request, which reaches the loop as a
// provider error. Reporting "all configured model providers failed" blames the
// endpoint for something the user did.
test("stopping is reported as stopping, not as the model provider failing", async () => {
  const controller = new AbortController();
  const agent = new FastAgent({
    signal: controller.signal,
    toolset: stubToolset({ run: async () => ({ ok: true, text: "ok" }) }),
    provider: {
      supportsChat: () => true,
      async chat() {
        controller.abort();
        throw new Error("All configured model providers failed: mistral: This operation was aborted");
      }
    }
  });

  const outcome = await agent.run("something long");

  assert.equal(outcome.status, "CANCELLED");
  assert.match(outcome.message, /^Stopped\./);
  assert.doesNotMatch(outcome.message, /providers failed/);
});

test("the loop stops at its step ceiling and keeps what it already did", async () => {
  const turns = Array.from({ length: 10 }, () => ({ text: "again", toolCalls: [{ name: "run", args: {} }] }));
  const agent = new FastAgent({
    provider: scriptedProvider(turns),
    toolset: stubToolset({ run: async () => ({ ok: true, text: "ok" }) }),
    maxSteps: 3
  });

  const outcome = await agent.run("loop forever");

  assert.equal(outcome.status, "PARTIALLY_COMPLETED");
  assert.equal(outcome.steps, 3);
  assert.match(outcome.message, /still in place/);
});

test("an unreachable model after real work is partial progress, not a flat failure", async () => {
  const provider = {
    supportsChat: () => true,
    calls: 0,
    async chat() {
      this.calls += 1;
      if (this.calls === 1) {
        return { text: "Opening it.", toolCalls: [{ id: "c0", name: "run", arguments: "{}" }], finishReason: "tool_calls" };
      }
      throw new Error("aborted");
    }
  };
  const agent = new FastAgent({
    provider,
    toolset: stubToolset({ run: async () => ({ ok: true, text: "done" }) })
  });

  const outcome = await agent.run("do a thing");

  assert.equal(outcome.status, "PARTIALLY_COMPLETED");
  assert.match(outcome.message, /already did is still in place/);
});

// ---- The toolset -------------------------------------------------------------

function stubRegistry(capabilities) {
  return { get: (name) => (capabilities[name] ? { execute: capabilities[name] } : null) };
}

test("a screen reading indexes its elements so a click never needs a guessed coordinate", async () => {
  const toolset = buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true,
        windowId: "77",
        application: "notepad",
        title: "Untitled - Notepad",
        visibleText: "Hello world",
        elements: [
          { role: "Button", text: "Save", bounds: { x: 10, y: 20, width: 40, height: 10 }, clickable: true },
          { role: "Edit", text: "Text Editor", bounds: { x: 0, y: 40, width: 200, height: 100 }, clickable: true }
        ]
      }),
      "pointer.clickAt": async (inputs) => ({ performed: true, x: inputs.x, y: inputs.y })
    }),
    adapter: {}
  });

  const screen = await toolset.execute("screen", { application: "the app under test" });
  assert.match(screen.text, /Window: notepad/);
  assert.match(screen.text, /0\| Button "Save" @30,25/);
  assert.match(screen.text, /1\| Edit "Text Editor" @100,90/);

  const click = await toolset.execute("click", { element: 1 });
  assert.equal(click.ok, true);
  assert.match(click.text, /at 100,90/);
  // A click by index also says WHAT it landed on. Indices renumber on every
  // look, and a bare coordinate has nothing in it to notice a stale one by:
  // `click {element: 6}` against a superseded reading landed on Redo, reported
  // "Clicked at 927,277", and the model carried on believing it had selected
  // the Rectangle tool.
  assert.match(click.text, /Clicked "Text Editor"/);
});

test("clicking an element that was never observed fails instead of clicking somewhere", async () => {
  const toolset = buildToolset({ registry: stubRegistry({}), adapter: {} });
  const click = await toolset.execute("click", { element: 4 });
  assert.equal(click.ok, false);
  assert.match(click.text, /No element 4/);
});

// Live, the model picked the index next to the one it wanted and pressed 7 for
// 8 — "47 × 89" became "74 × 79" with every coordinate exactly right. Clicking
// by label removes the counting.
function calculatorToolset() {
  const button = (name, x, y) => ({
    role: "Button", text: name, source: "UIA", clickable: true,
    bounds: { x, y, width: 340, height: 160 }
  });
  return buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true, windowId: "9", application: "Calculator", title: "Calculator", visibleText: "0",
        elements: [
          button("Seven", 141, 1009),
          button("Eight", 490, 1009),
          button("Nine", 839, 1009),
          // The same buttons again as OCR lines, which is what a real fused
          // reading contains and what made the list twice as long as it needed.
          { role: "text", text: "Seven", source: "OCR", bounds: { x: 145, y: 1015, width: 330, height: 150 } },
          { role: "text", text: "Eight", source: "OCR", bounds: { x: 494, y: 1015, width: 330, height: 150 } },
          button("Multiply by", 839, 500)
        ]
      }),
      "pointer.clickAt": async (inputs) => ({ performed: true, x: inputs.x, y: inputs.y })
    }),
    adapter: {}
  });
}

test("the same control seen by both UI Automation and OCR is listed once", async () => {
  const toolset = calculatorToolset();
  const screen = await toolset.execute("screen", { application: "the app under test" });
  const listed = screen.text.match(/^\d+\| /gm) ?? [];
  assert.equal(listed.length, 4, `six raw elements, four real controls, got:\n${screen.text}`);
  assert.equal((screen.text.match(/"Eight"/g) ?? []).length, 1);
});

test("clicking by label lands on that control, whatever its position in the list", async () => {
  const toolset = calculatorToolset();
  await toolset.execute("screen", { application: "the app under test" });
  const eight = await toolset.execute("click", { text: "Eight" });
  assert.equal(eight.ok, true);
  assert.match(eight.text, /Clicked "Eight" at 660,1089/);
  const multiply = await toolset.execute("click", { text: "Multiply by" });
  assert.match(multiply.text, /Clicked "Multiply by" at 1009,580/);
});

test("clicking a label that is not on screen refuses rather than clicking the nearest thing", async () => {
  const toolset = calculatorToolset();
  await toolset.execute("screen", { application: "the app under test" });
  const result = await toolset.execute("click", { text: "Square root" });
  assert.equal(result.ok, false);
  assert.match(result.text, /Nothing on screen is labelled "Square root"/);
});

test("typing into a named field clicks the field, not the text being typed", async () => {
  const clicks = [];
  const toolset = buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true, windowId: "3", application: "app", title: "Login", visibleText: "",
        elements: [
          { role: "Edit", text: "Username", clickable: true, bounds: { x: 0, y: 0, width: 200, height: 40 } },
          { role: "Edit", text: "Password", clickable: true, bounds: { x: 0, y: 100, width: 200, height: 40 } }
        ]
      }),
      "pointer.clickAt": async (inputs) => { clicks.push(inputs); return { performed: true, x: inputs.x, y: inputs.y }; },
      "keyboard.type": async () => ({ performed: true })
    }),
    adapter: {}
  });

  await toolset.execute("screen", { application: "the app under test" });
  const typed = await toolset.execute("type", { into: "Password", text: "Username" });
  assert.equal(typed.ok, true);
  assert.deepEqual(
    { x: clicks[0].x, y: clicks[0].y },
    { x: 100, y: 120 },
    "it must click the field named by `into`, not the field whose name matches the text being typed"
  );
});

test("a refused command comes back as the reason, not as a crash", async () => {
  const toolset = buildToolset({
    registry: stubRegistry({}),
    adapter: {
      executeCommand: async () => ({ blocked: true, exitCode: -1, stdout: "", stderr: "I won't run this command because it formats a disk." })
    }
  });

  const result = await toolset.execute("run", { command: "format C:" });
  // It comes back as text the model reads rather than as an exception — and it
  // is a failure, so sending the identical command again is refused by the
  // loop's repeat guard instead of being tried a second and third time.
  assert.equal(result.ok, false);
  assert.match(result.text, /^REFUSED: I won't run this/);
});

test("command output is passed back with its exit code and clipped, not dumped whole", async () => {
  const toolset = buildToolset({
    registry: stubRegistry({}),
    adapter: { executeCommand: async () => ({ stdout: "x".repeat(20000), stderr: "", exitCode: 0 }) }
  });

  const result = await toolset.execute("run", { command: "big" });
  assert.ok(result.text.length < 8000, `tool output must be bounded, got ${result.text.length}`);
  assert.match(result.text, /more characters/);
  assert.match(result.text, /exit 0/);
});

// NOTHING IS CHANGING, AND IT HAS NOT NOTICED.
//
// Asked to add an emoji reaction in WhatsApp, the agent hovered, read, clicked a
// guessed coordinate, read, hovered four pixels away, read — 48 steps and
// 692,000 tokens, with the reading saying "nothing at all has changed on screen"
// over and over. The react button is an icon with no text: invisible to a text
// reading, and no amount of hovering was ever going to reveal it.
//
// The repeat guard could not catch it, because every call was slightly
// different. What was identical was the OUTCOME.
test("a screen that never changes ends the run instead of being hunted forever", async () => {
  const unchanging = [{
    role: "text", text: "Team Rezoni", clickable: true,
    bounds: { x: 1100, y: 1350, width: 200, height: 24 }
  }];
  const toolset = buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true, windowId: "198130", application: "WhatsApp", title: "WhatsApp",
        visibleText: "", elements: unchanging
      })
    }),
    adapter: {}
  });

  // Hover somewhere a few pixels away, read, repeat — exactly the live shape.
  const turns = [];
  for (let index = 0; index < 30; index += 1) {
    turns.push({ text: "trying", toolCalls: [{ name: "move_mouse", args: { x: 1300 + index * 4, y: 400 - index * 3 } }] });
    turns.push({ text: "checking", toolCalls: [{ name: "screen", args: { application: "WhatsApp" } }] });
  }

  const agent = new FastAgent({ provider: scriptedProvider(turns), toolset, maxSteps: 60 });
  const outcome = await agent.run("react 😊 on the latest message");

  assert.ok(outcome.steps < 25, `it must give up early, took ${outcome.steps} steps`);
  assert.equal(outcome.status, "PARTIALLY_COMPLETED");
  assert.match(outcome.message, /has not changed/);
  assert.match(outcome.message, /icon/, "and it must say WHY, because this is not a failure the user can guess");
  assert.match(outcome.message, /Nothing was changed/);
});

// Repetition is how a long list gets scrolled and how a picture gets drawn, so
// the guards above must not mistake either for going in circles.
test("scrolling and drawing may repeat as much as they need to", async () => {
  const scrolls = [];
  const toolset = stubToolset({
    scroll: async (args) => { scrolls.push(args); return { ok: true, text: "Scrolled." }; }
  });
  const turns = Array.from({ length: 8 }, () => ({
    text: "looking further down",
    toolCalls: [{ name: "scroll", args: { direction: "down", notches: 6 } }]
  }));
  turns.push({ text: "found it", toolCalls: [] });

  const agent = new FastAgent({ provider: scriptedProvider(turns), toolset, maxSteps: 20 });
  await agent.run("find the thing at the bottom of the list");

  assert.equal(scrolls.length, 8, "every identical scroll must actually run");
});

// A STOP WITHOUT A QUESTION OR A REASON IS INDISTINGUISHABLE FROM A CRASH.
//
// The flagship run, measured: four steps and 43,214 tokens into "send jingalala
// ho to amma on whatsapp" it settled COMPLETED having only clicked the search
// box. Nothing had failed and nothing had been asked; the user typed "continue"
// and it carried straight on, which is the proof it had not finished.
test("narrating the next step instead of taking it is not finishing", async () => {
  const clicks = [];
  const toolset = stubToolset({
    click: async (args) => { clicks.push(args); return { ok: true, text: "Clicked." }; },
    type: async () => ({ ok: true, text: "Typed." })
  });
  const turns = [
    { text: "Opening the chat.", toolCalls: [{ name: "click", args: { text: "Amma" } }] },
    // The stall: prose about what comes next, no call.
    { text: "I've clicked the search box. Now I'll type the contact's name." },
    // After the nudge it does the work.
    { text: "Typed it.", toolCalls: [{ name: "type", args: { text: "Amma" } }] },
    { text: "Done — the message is in the conversation at 9:52 pm." }
  ];

  const agent = new FastAgent({ provider: scriptedProvider(turns), toolset, maxSteps: 20 });
  const outcome = await agent.run("send jingalala ho to amma on whatsapp");

  assert.equal(outcome.status, "COMPLETED");
  assert.equal(clicks.length, 1);
  assert.match(outcome.message, /9:52 pm/, "it must carry on to the real answer, not stop at the narration");
});

// One nudge, once. A model that stalls twice is not COMPLETED, and saying it is
// would also offer the stall to the recorder as a route worth saving.
test("a run that stalls and stays stalled is reported as unfinished", async () => {
  const toolset = stubToolset({ click: async () => ({ ok: true, text: "Clicked." }) });
  const turns = [
    { text: "Opening it.", toolCalls: [{ name: "click", args: { text: "Amma" } }] },
    { text: "I've clicked the search box. Now I'll type the name." },
    { text: "Next, I'll press enter to send it." }
  ];

  const agent = new FastAgent({ provider: scriptedProvider(turns), toolset, maxSteps: 20 });
  const outcome = await agent.run("send jingalala ho to amma on whatsapp");

  assert.equal(outcome.status, "PARTIALLY_COMPLETED");
  assert.match(outcome.message, /stopped before finishing/);
});

// Asking IS a reason to stop. The run is waiting on the user, and nudging a
// question costs a step and answers nothing.
test("a question to the user ends the run without a nudge", async () => {
  const toolset = stubToolset({ click: async () => ({ ok: true, text: "Clicked." }) });
  const turns = [
    { text: "Opening it.", toolCalls: [{ name: "click", args: { text: "Amma" } }] },
    { text: "There are two chats called Amma. Which one did you mean?" }
  ];

  const agent = new FastAgent({ provider: scriptedProvider(turns), toolset, maxSteps: 20 });
  const outcome = await agent.run("send jingalala ho to amma on whatsapp");

  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.steps, 2, "no extra step was spent nudging a question");
  assert.match(outcome.message, /Which one did you mean\?/);
});

// And an ordinary finished answer must not pay for any of this.
test("a finished answer settles on the spot", async () => {
  const toolset = stubToolset({ run: async () => ({ ok: true, text: "v22.23.1" }) });
  const turns = [
    { text: "Checking.", toolCalls: [{ name: "run", args: { command: "node -v" } }] },
    { text: "Node is v22.23.1." }
  ];

  const agent = new FastAgent({ provider: scriptedProvider(turns), toolset, maxSteps: 20 });
  const outcome = await agent.run("what version of node is installed");

  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.steps, 2, "a finished answer must not cost an extra model call");
});

// THE CHEAPEST LIE IN THE PRODUCT, AND IT COST NOTHING TO TELL.
//
// Measured live, 16 Aug 2026, two turns apart. "now up tp 60" was answered with
// "Volume is now at 60%." in one step and no tool call; "mute" was answered with
// "Muted." the same way. Both false — the endpoint was at 20% and unmuted. The
// volume tool itself is honest: it reads Core Audio back after every write. The
// model simply never called it, and the backstop's patterns were anchored on the
// first person or a named object, which one-word answers do not have.
test("a bare acknowledgement with no tool call is not an answer", async () => {
  for (const said of ["Muted.", "Done.", "Okay, paused.", "Volume is now at 60%.", "It's at 28%."]) {
    assert.equal(claimsWithoutEvidence(said), true, `${JSON.stringify(said)} claims something`);
  }
  // Ordinary conversation still has to pass, or every chat costs an extra step.
  for (const said of [
    "I can mute it if you like.",
    "Muting changes the endpoint, not the app.",
    "What would you like me to set it to?"
  ]) {
    assert.equal(claimsWithoutEvidence(said), false, `${JSON.stringify(said)} is conversation`);
  }
});

test("\"mute\" answered without touching anything is chased, then actually done", async () => {
  const calls = [];
  const toolset = stubToolset({
    volume: async (args) => { calls.push(args); return { ok: true, text: "Volume is 28% (muted)." }; }
  });
  const turns = [
    { text: "Muted." },
    { text: "Muted — the endpoint reads 28% and muted.", toolCalls: [{ name: "volume", args: { mute: true } }] }
  ];

  const agent = new FastAgent({ provider: scriptedProvider(turns), toolset, maxSteps: 20 });
  // NOT the bare word "mute", which the local fast path now answers without a
  // model at all (see fast-path.js). This test is about the LOOP's backstop for
  // a model that claims to have done something without calling anything, so the
  // request has to be one that actually reaches the model.
  const outcome = await agent.run("mute everything");

  assert.equal(calls.length, 1, "the tool must actually run");
  assert.deepEqual(calls[0], { mute: true });
  assert.equal(outcome.status, "COMPLETED");
});

// And if it just says it again, the lie must not be handed to the user.
test("a repeated claim with still no tool call is reported as not done", async () => {
  const turns = [{ text: "Muted." }, { text: "Muted." }];
  const agent = new FastAgent({ provider: scriptedProvider(turns), toolset: stubToolset(), maxSteps: 20 });
  const outcome = await agent.run("mute");

  assert.equal(outcome.status, "FAILED");
  assert.match(outcome.message, /I did not do that/);
  assert.doesNotMatch(outcome.message, /^Muted/);
});

// ---- A reply that stopped is not a reply that finished ---------------------
//
// Measured live, 17 Aug 2026: a run settled COMPLETED on "The Amma chat is open.
// The last two messages in the chat are:" and nothing after the colon. The
// provider had cut the turn off at the 2,048-token ceiling (2,062 out) and the
// loop took the fragment as the finished answer. `looksUnfinished` could never
// have caught it — a truncated answer is not narration of a next step, it is a
// correct sentence that simply ends.

test("a cut-off answer is asked for again rather than published as the result", async () => {
  const turns = [
    { text: "The last two messages in the chat are:", finishReason: "length" },
    { text: "Two messages: \"aa dekhen zara\" at 2:53 pm and \"picture abhi baaki hai\" at 2:55 pm." }
  ];
  const agent = new FastAgent({ provider: scriptedProvider(turns), toolset: stubToolset(), maxSteps: 20 });
  const outcome = await agent.run("what are the last two messages");

  assert.equal(outcome.status, "COMPLETED");
  assert.match(outcome.message, /picture abhi baaki hai/, "the complete answer is what the user gets");
  assert.doesNotMatch(outcome.message, /are:$/, "the fragment must not be the final word");
});

test("a truncated turn is asked to be shorter, and says nothing was used", async () => {
  const provider = scriptedProvider([
    { text: "The last two messages are:", finishReason: "length" },
    { text: "Done." }
  ]);
  const agent = new FastAgent({ provider, toolset: stubToolset(), maxSteps: 20 });
  await agent.run("read them");

  const nudge = provider.seen.at(-1).map((message) => String(message.content ?? "")).join("\n");
  assert.match(nudge, /hit the output token limit/);
  assert.match(nudge, /nothing in it was used/);
  assert.match(nudge, /keep it SHORT/);
});

// HALF A DECISION IS NOT A DECISION. The arguments of a cut-off tool call are a
// JSON object the provider stopped writing — either unparseable, or worse,
// parseable and missing the field that made it safe. This loop runs `type`,
// `run` and `click` straight onto the user's machine.
test("the tool calls in a truncated turn do not run", async () => {
  const ran = [];
  const toolset = stubToolset({
    run: async (args) => { ran.push(args); return { ok: true, text: "ok" }; }
  });
  const turns = [
    { text: "Removing the folder.", finishReason: "length", toolCalls: [{ name: "run", args: { command: "Remove-Item -Recurse" } }] },
    { text: "I did not run anything." }
  ];
  const agent = new FastAgent({ provider: scriptedProvider(turns), toolset, maxSteps: 20 });
  const outcome = await agent.run("tidy up");

  assert.deepEqual(ran, [], "a half-written command must never reach the machine");
  assert.equal(outcome.status, "COMPLETED");
});

// Twice is a provider that will not be argued out of it. Keep what prose there
// is — half an answer with a warning on it beats nothing — and never call it
// done.
test("truncated twice is PARTIALLY_COMPLETED, with the fragment and a warning", async () => {
  const turns = [
    { text: "The messages are:", finishReason: "length" },
    { text: "The messages are: aa dekhen", finishReason: "length" }
  ];
  const agent = new FastAgent({ provider: scriptedProvider(turns), toolset: stubToolset(), maxSteps: 20 });
  const outcome = await agent.run("read them");

  assert.equal(outcome.status, "PARTIALLY_COMPLETED");
  assert.match(outcome.message, /aa dekhen/, "what did arrive is still worth showing");
  assert.match(outcome.message, /CUT OFF/);
});

test("an ordinary finish reason is not mistaken for truncation", () => {
  for (const reason of ["stop", "tool_calls", "STOP", null, undefined, ""]) {
    assert.equal(wasTruncated({ finishReason: reason }), false, String(reason));
  }
  for (const reason of ["length", "MAX_TOKENS", "max_tokens"]) {
    assert.equal(wasTruncated({ finishReason: reason }), true, reason);
  }
});

// ---- An answer that stops on a colon is not a finished answer ---------------
//
// Measured live, 17 Aug 2026, and NOT the truncation case above: the provider
// said "stop" and the output was 1,359 tokens against a 4,096 ceiling. The model
// announced a list — "The last two messages in the conversation are both ones
// you sent:" — and ended its turn. Nothing about the words is wrong, which is
// why every other guard here misses it: they look for a next step being
// narrated, and this narrates nothing.

test("a reply that ends on the punctuation that promises more is unfinished", () => {
  for (const said of [
    "The last two messages in the conversation are both ones you sent:",
    "Here is what I found:",
    "I checked three things,",
    "The window is open —",
    "It found the file;"
  ]) {
    assert.equal(looksUnfinished(said), true, said);
  }
});

// The false-positive risk is the whole cost of this guard: it fires a nudge, and
// a nudge on a complete answer is a wasted step. A finished sentence ends on
// punctuation that CAN end a thought, and a list that was actually delivered
// ends with the list rather than with the colon that introduced it.
test("a complete answer is not mistaken for one that stopped", () => {
  for (const said of [
    "The last two messages are both from you:\n\n1. \"aa dekhen zara\"\n2. \"picture abhi baaki hai\"\n\nBoth are marked as read.",
    "Python 3.12.4 is installed.",
    "You have 609.7 GB free on C:.",
    "I could not find that chat — what name is it filed under?",
    "Done.",
    "The file is at C:\Users\hithe\notes.txt"
  ]) {
    assert.equal(looksUnfinished(said), false, said);
  }
});

// ---- The lie wore bold -----------------------------------------------------
//
// From the user's own live transcript, 17 Aug 2026:
//
//   user: "make it 20"  ->  "Done — volume is now **20%**."
//                           1 step, ZERO tool calls, 11 output tokens
//
// The endpoint was still at 60%. The user had to reply "no iys not" to get the
// work done. STATE_ASSERTED matches "volume is now 20%" exactly and did not fire
// — because the model wrote `**20%**` and the pattern wants a digit after "now".
// A guard one character away from never firing is not a guard.

test("a claim dressed in markdown is still a claim", () => {
  for (const dressed of [
    "Done — volume is now **20%**.",
    "**Muted.**",
    "Done — the volume is **20%** now.",
    "I have **sent** it.",
    "`Volume` is now at **60%**.",
    "**Done.**",
    "- Volume is now **20%**",
    "*Opened* it."
  ]) {
    assert.equal(claimsWithoutEvidence(dressed), true, dressed);
  }
});

test("stripping the formatting does not invent claims out of ordinary prose", () => {
  for (const innocent of [
    "Python is a programming language.",
    "I can pause it if you like.",
    "The file uses snake_case names and 3 * 4 arithmetic.",
    "What would you like me to set it to?",
    "Would you like me to **send** it?"
  ]) {
    assert.equal(claimsWithoutEvidence(innocent), false, innocent);
  }
});

// The whole loop, not just the predicate: the turn that produced that sentence
// must not be allowed to settle as the answer.
test("\"volume is now **20%**\" with no tool call is chased, then actually done", async () => {
  const calls = [];
  const toolset = stubToolset({
    volume: async (args) => { calls.push(args); return { ok: true, text: "Volume is 20%." }; }
  });
  const turns = [
    { text: "Done — volume is now **20%**." },
    { text: "Volume is **20%** — the endpoint reads it back.", toolCalls: [{ name: "volume", args: { percent: 20 } }] }
  ];
  const agent = new FastAgent({ provider: scriptedProvider(turns), toolset, maxSteps: 20 });
  const outcome = await agent.run("make it 20");

  assert.deepEqual(calls, [{ percent: 20 }], "the endpoint must actually be set");
  assert.equal(outcome.status, "COMPLETED");
});
