import test from "node:test";
import assert from "node:assert/strict";
import { FastAgent, buildToolset, claimsWithoutEvidence, looksUnfinished, wasDiscarded, wasTruncated } from "../../packages/fast-agent/src/index.js";

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

test("a failed action followed by a confirmed recovery becomes generalized outcome memory", async () => {
  const provider = scriptedProvider([
    { text: "Trying the direct route.", toolCalls: [{ name: "play_music", args: { query: "a private song title" } }] },
    { text: "Using the visible result.", toolCalls: [{ name: "click", args: { text: "Play" } }] },
    { text: "It is playing now." }
  ]);
  const recorded = [];
  const toolset = stubToolset({
    play_music: async () => ({ ok: false, text: "matching-track-not-found", raw: { reason: "matching-track-not-found" } }),
    click: async () => ({
      ok: true,
      text: "Clicked Play and playback changed.",
      raw: { evidence: { verdict: "CONFIRMED", observed: "playback changed" } }
    })
  });
  toolset.isActingTool = (name) => ["play_music", "click"].includes(name);
  const memory = {
    retrieveAdaptiveGuidance: async () => [],
    recordAdaptivePattern: async (pattern) => { recorded.push(pattern); }
  };
  const agent = new FastAgent({ provider, toolset, memory });

  const outcome = await agent.run("play some music");

  assert.equal(outcome.status, "COMPLETED");
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    tool: "play_music",
    application: "spotify",
    failureClass: "matching-track-not-found",
    recoverySequence: ["click"],
    recovered: true
  });
  // `failedAt` is the run's own clock, used to tell "too early" from "wrong
  // thing" while the run is happening. It must not reach the store: a wall-clock
  // reading from one afternoon means nothing to a pattern meant to be reused.
  assert.equal("failedAt" in recorded[0], false,
    "live-run timing is a signal, not a fact worth persisting");
  assert.equal(JSON.stringify(recorded).includes("private song title"), false,
    "adaptive memory must not retain queries, message text or other user content");
});

// ---- Learning from mistakes, not memorising routes -------------------------
//
// The taxonomy below is derived from all 113 failed tool calls in the 178 real
// sessions on this machine. Before this, 38% of them classified as the catch-all
// `tool-failed`, which is why 30 of the 39 patterns the store had learned said
// `tool-failed` and taught nothing.

test("a boundary is never learned as a technique to get around", async () => {
  // THE SAFETY HALF. The policy floor, the approval card and this loop's own
  // repeat guard all arrive looking exactly like a tool that would not work.
  // Recording them as "it failed, here is what worked afterwards" teaches one
  // thing only: how to get past the thing that said no. shell-rules.js records a
  // live session where a refusal produced four attempts to route around it, two
  // of them successful.
  for (const refusal of [
    "This command can change the system, so workspace terminal access needs your approval.",
    "The command was not approved, so no process was spawned.",
    "This is the 3rd time you have run exactly this in one request, and it has not got you anywhere.",
    "You already ran exactly this and it failed: the command needs Developer terminal access."
  ]) {
    const recorded = [];
    const provider = scriptedProvider([
      { text: "", toolCalls: [{ name: "run", args: { command: "x" } }] },
      { text: "", toolCalls: [{ name: "click", args: {} }] },
      { text: "Done." }
    ]);
    const toolset = stubToolset({
      run: async () => ({ ok: false, text: refusal, raw: { reason: refusal } }),
      click: async () => ({ ok: true, text: "Clicked.", raw: { evidence: { verdict: "CONFIRMED", observed: "focus moved" } } })
    });
    toolset.isActingTool = (name) => ["run", "click"].includes(name);
    await new FastAgent({
      provider, toolset, memory: { retrieveAdaptiveGuidance: async () => [], recordAdaptivePattern: async (p) => recorded.push(p) }
    }).run("do the thing");

    assert.equal(recorded.length, 0, `a boundary must not become a lesson: ${JSON.stringify(refusal)}`);
  }
});

test("a failure that only needed time is learned as needing time", async () => {
  // The user's own example, and this machine's commonest failure: eighteen of
  // its 113 recorded failures are "no track started" against a window that was
  // already open. The app had not finished getting ready. A recovery stored as a
  // list of tool names cannot say that; `neededTime` can.
  const recorded = [];
  const provider = scriptedProvider([
    { text: "", toolCalls: [{ name: "play_music", args: {} }] },
    { text: "", toolCalls: [{ name: "wait", args: { until: "appears" } }] },
    { text: "", toolCalls: [{ name: "play_music", args: {} }] },
    { text: "Playing." }
  ]);
  let attempts = 0;
  const toolset = stubToolset({
    play_music: async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, text: "Spotify is not playing: no track started. The window is open.", raw: { reason: "no track started" } }
        : { ok: true, text: "Playing.", raw: { evidence: { verdict: "CONFIRMED", observed: "the transport shows it playing" } } };
    },
    wait: async () => ({ ok: true, text: "It appeared.", raw: { evidence: { verdict: "CONFIRMED", observed: "the control appeared" } } })
  });
  toolset.isActingTool = (name) => name === "play_music";
  await new FastAgent({
    provider, toolset, memory: { retrieveAdaptiveGuidance: async () => [], recordAdaptivePattern: async (p) => recorded.push(p) }
  }).run("play something");

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].failureClass, "nothing-started",
    "\"no track started\" used to classify as the catch-all, 18 times on this machine");
  assert.equal(recorded[0].neededTime, true,
    "an explicit wait, and the same tool succeeding afterwards, both mean the lesson is TIME");
});

test("the commonest real failures no longer collapse into the catch-all", async () => {
  // Every string here is a real failure shape counted in the session store, with
  // the content stripped. Each one used to classify as `tool-failed`.
  const cases = [
    ["Spotify is not playing: no track started. The window is open.", "nothing-started"],
    ["The click did not land on Sign in: the element could not be clicked.", "click-did-not-land"],
    ["Spotify is still playing Peaches, which is not what was asked for.", "not-what-was-asked"],
    ["open_url failed: only http(s) urls can be opened. That looks like a local file.", "wrong-tool-for-target"],
    ["Not focused. The window in front is Notepad (windowId 4), which is not the one asked for.", "wrong-window"],
    ["web_type failed: no field on this page matches Email.", "target-not-found"],
    ["click failed: Play matches 3 things on screen, and they are not the same control.", "ambiguous-target"]
  ];
  for (const [text, expected] of cases) {
    const recorded = [];
    const provider = scriptedProvider([
      { text: "", toolCalls: [{ name: "click", args: {} }] },
      { text: "", toolCalls: [{ name: "type", args: {} }] },
      { text: "Done." }
    ]);
    const toolset = stubToolset({
      click: async () => ({ ok: false, text, raw: { reason: text } }),
      type: async () => ({ ok: true, text: "Typed.", raw: { evidence: { verdict: "CONFIRMED", observed: "the field holds it" } } })
    });
    toolset.isActingTool = (name) => ["click", "type"].includes(name);
    await new FastAgent({
      provider, toolset, memory: { retrieveAdaptiveGuidance: async () => [], recordAdaptivePattern: async (p) => recorded.push(p) }
    }).run("do the thing");

    assert.equal(recorded[0]?.failureClass, expected, `${JSON.stringify(text)} should classify as ${expected}`);
  }
});

test("relevant adaptive guidance is present before the model's first decision", async () => {
  const provider = scriptedProvider([{ text: "Done." }]);
  const memory = {
    retrieveAdaptiveGuidance: async () => [{ content: {
      application: "spotify", tool: "play_music", failureClass: "target-not-found",
      recoverySequence: ["screen", "click"], counts: { observations: 2, recoveries: 2 }
    } }],
    recordAdaptivePattern: async () => {}
  };
  const agent = new FastAgent({ provider, toolset: stubToolset(), memory });

  await agent.run("play music on spotify");

  assert.match(provider.seen[0][0].content, /WHAT HAS GONE WRONG ON THIS MACHINE BEFORE/);
  assert.match(provider.seen[0][0].content, /screen -> click/);
  assert.match(provider.seen[0][0].content, /not permission/);
});

test("a lesson whose fix was time says so, instead of reciting the route", async () => {
  // The same record, differing only in `counts.neededTime`. A route is what was
  // done last time; "it was not ready yet" is what to do differently this time,
  // and only the second one changes the next action.
  const provider = scriptedProvider([{ text: "Done." }]);
  await new FastAgent({
    provider,
    toolset: stubToolset(),
    memory: {
      recordAdaptivePattern: async () => {},
      retrieveAdaptiveGuidance: async () => [{ content: {
        application: "spotify", tool: "play_music", failureClass: "nothing-started",
        recoverySequence: ["wait", "play_music"],
        counts: { observations: 4, recoveries: 4, neededTime: 3 }
      } }]
    }
  }).run("play music on spotify");

  const system = provider.seen[0][0].content;
  assert.match(system, /what fixed it was TIME/);
  assert.match(system, /3\/4/, "the evidence for a lesson is part of the lesson");
  assert.match(system, /wait \{until, text\}/, "it must name the tool that does the waiting");
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
  toolset.setAccessPolicy({ developerMode: true, shellExecutionMode: "host" });
  toolset.setConfirmer(async () => true);

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
  toolset.setAccessPolicy({ developerMode: true, shellExecutionMode: "host" });
  toolset.setConfirmer(async () => true);

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

test("Android screen reads are repeatable observations, not repeated actions", async () => {
  let reads = 0;
  const turns = [200, 400, 700, 300].map((maxNodes) => ({
    text: "checking",
    toolCalls: [{ name: "android_screen", args: { serial: "phone-1", maxNodes } }]
  }));
  turns.push({ text: "The accessible screen stayed unchanged, so I need a different route." });
  const events = [];
  const agent = new FastAgent({
    provider: scriptedProvider(turns),
    toolset: stubToolset({
      android_screen: async () => {
        reads += 1;
        return {
          ok: true,
          text: reads === 1 ? "Android controls." : "IDENTICAL to the last hierarchy.",
          raw: { screenUnchanged: reads > 1, evidence: { verdict: "CONFIRMED" } }
        };
      }
    }),
    onEvent: (event) => events.push(event)
  });
  const outcome = await agent.run("inspect my Android phone");
  assert.equal(outcome.status, "COMPLETED");
  assert.equal(reads, 4);
  assert.equal(events.some((event) => event.details?.repeated === true), false,
    "changing a read limit or using repeated observation must not trip the action-repeat guard");
});

test("ignoring the repeated-action warning is enforced by the controller", async () => {
  let clicks = 0;
  const repeated = Array.from({ length: 6 }, () => ({
    text: "trying",
    toolCalls: [{ name: "click", args: { text: "Search" } }]
  }));
  const agent = new FastAgent({
    provider: scriptedProvider(repeated),
    toolset: stubToolset({ click: async () => { clicks += 1; return { ok: true, text: "Clicked." }; } })
  });
  const outcome = await agent.run("open search");
  assert.equal(outcome.status, "PARTIALLY_COMPLETED");
  assert.equal(clicks, 2, "the third call is refused and a fourth ignored warning ends the run");
  assert.ok(outcome.steps <= 4, `controller enforcement should stop promptly, took ${outcome.steps}`);
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
  // FOUR TURNS, NOT THREE, SINCE 24 AUG 2026. A run that narrates twice is now
  // asked once for the ANSWER instead of another step — a real audit was losing
  // ten files of work to a "Partly done" card carrying nothing but the
  // narration (see unfinished-wrapup.test.js). "Stays stalled" therefore means
  // it keeps narrating through that ask too, which is what the fourth turn is.
  const turns = [
    { text: "Opening it.", toolCalls: [{ name: "click", args: { text: "Amma" } }] },
    { text: "I've clicked the search box. Now I'll type the name." },
    { text: "Next, I'll press enter to send it." },
    { text: "Now I'll press enter to send it." }
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

// This used to assert the nudge said "keep it SHORT … the smallest arguments
// that do the job". That instruction was measured against the live endpoint and
// changed nothing — truncation continued at 3 of 6 with it against 3 of 8
// without — because the arguments were never what overran. What the retry must
// do now is name thinking as the cause and ask for the NEXT action only.
test("a truncated turn is told what actually overran, and that nothing was used", async () => {
  const provider = scriptedProvider([
    { text: "The last two messages are:", finishReason: "length" },
    { text: "Done." }
  ]);
  const agent = new FastAgent({ provider, toolset: stubToolset(), maxSteps: 20 });
  await agent.run("read them");

  const nudge = provider.seen.at(-1).map((message) => String(message.content ?? "")).join("\n");
  assert.match(nudge, /output token limit/);
  assert.match(nudge, /nothing in it was used/);
  assert.match(nudge, /THINKING/, "the retry must name the half of the budget that actually overran");
  assert.match(nudge, /do not plan the entire task again/i);
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

// ---- The output ceiling is shared with the model's thinking -----------------
//
// `max_tokens` bounds reasoning AND the tool call together, and reasoning is
// emitted first, so a turn that deliberates past the ceiling never reaches the
// call. Measured against the live endpoint on 21 Aug 2026 with one real drawing
// decision (scripts/probe-reasoning-budget.mjs, n=8): at a 4,096 ceiling 3 of 8
// turns came back `length` carrying ZERO tool calls, and the unconstrained
// reasoning distribution was 1,062 · 1,943 · 2,517 · 5,219 · 6,350 · 6,626 ·
// 6,983 · 11,891 — a median of 6,350, well above the ceiling meant to hold it.
//
// The retry that existed asked for "the smallest arguments that do the job",
// which argued with the wrong half of the budget and measured as no
// improvement. These two tests pin the mechanism instead of the wording.
function ceilingRecordingProvider(turns) {
  const ceilings = [];
  const timeouts = [];
  return {
    ceilings,
    timeouts,
    supportsChat: () => true,
    async chat({ maxTokens, tools, timeoutMs }) {
      assert.ok(Array.isArray(tools), "the loop must send the tool definitions");
      ceilings.push(maxTokens);
      timeouts.push(timeoutMs);
      const turn = turns.shift() ?? { text: "Done." };
      return {
        text: turn.text ?? "",
        toolCalls: [],
        finishReason: turn.finishReason ?? "stop"
      };
    }
  };
}

// THE ORDINARY TURN KEEPS THE MEASURED CEILING. This assertion is the scar from
// the first attempt at the fix, which raised the ceiling for EVERY turn: a
// reasoning model given more room thinks longer and then attempts more, and a
// full eval measured draw-shape-in-paint falling from 3/3 to 1/3 at 3x the
// tokens, app-type doubling its steps, and the pass rate going 100% → 91%.
//
// 4,096 → 8,192 ON 3 SEP 2026, AND THE BOUNDS ARE WHAT THIS TEST NOW PINS.
//
// The floor exists because 4,096 sat one third of the way into an ordinary file
// write: a 14 KB stylesheet is ~5,000 output tokens in one `write_file`, and at
// 4,096 this endpoint discarded the whole turn silently rather than reporting
// `length`. A run built one file of three and settled COMPLETED.
//
// The ceiling exists because the warning above is still true. Measured with
// `scripts/probe-output-ceiling.mjs`, thinking off: every ordinary decision is
// flat to within 2% from 4,096 to 16,384 — including draw-a-shape, the row that
// regressed — but `arithmetic`, which must answer with NO tool call, went 2/3 to
// 0/3 at 16,384. So there is a band, and this holds the value inside it.
test("an ordinary turn is given the measured ceiling — enough to write a file, not more", async () => {
  const provider = ceilingRecordingProvider([{ text: "Done." }]);
  await new FastAgent({ provider, toolset: stubToolset(), maxSteps: 4 }).run("say hello");

  assert.ok(
    provider.ceilings[0] >= 5000,
    `an ordinary turn must have room to write a real file in one call — a 14 KB stylesheet is ~5,000 ` +
    `output tokens, and this endpoint DISCARDS the turn rather than truncating it. Got ${provider.ceilings[0]}.`
  );
  assert.ok(
    provider.ceilings[0] <= 8192,
    `8,192 is the largest ceiling measured to change nothing else; at 16,384 the arithmetic case stopped ` +
    `answering without a tool. Got ${provider.ceilings[0]}. Re-run scripts/probe-output-ceiling.mjs before raising it.`
  );
});

test("the retry ceiling clears the measured reasoning median", async () => {
  const provider = ceilingRecordingProvider([
    { text: "", finishReason: "length" },
    { text: "Done." }
  ]);
  await new FastAgent({ provider, toolset: stubToolset(), maxSteps: 6 }).run("draw a detailed car");

  // 6,350 is the measured p50 of reasoning alone for a real drawing decision. A
  // retry at or under it re-truncates on most of the distribution it exists to
  // hold, which is what made the retry useless before.
  assert.ok(
    provider.ceilings[1] > 6350,
    `the retry must clear the measured reasoning median of 6,350, got ${provider.ceilings[1]}`
  );
});

test("a truncated turn is retried with MORE room, not a request to be brief", async () => {
  const provider = ceilingRecordingProvider([
    // Truncated with no tool calls at all: reasoning ate the whole budget.
    { text: "", finishReason: "length" },
    { text: "Done." }
  ]);
  await new FastAgent({ provider, toolset: stubToolset(), maxSteps: 6 }).run("draw a detailed car");

  // Not an assertion on the CALL COUNT: a turn that comes back with no tool
  // calls also trips the no-evidence backstop, which asks again. What matters is
  // the ceiling on the call that follows the truncation.
  assert.ok(provider.ceilings.length >= 2, "the truncated turn must be retried");
  assert.ok(
    provider.ceilings[1] > provider.ceilings[0],
    `the retry after a truncation must raise the ceiling — got ${provider.ceilings[0]} then ${provider.ceilings[1]}. ` +
    "Asking the model to be shorter was measured to change nothing, because what overran was its reasoning."
  );
});

// A FIX CAN ITSELF BE UNREACHABLE.
//
// The retry above is allowed 16,384 output tokens. This endpoint generates at
// roughly 107 tokens/second (measured: 11,891 reasoning tokens in 111.6s), so
// using that budget takes about 153 seconds — and the loop used to cap every
// request at 90. The retry would have been aborted before it could deliver, and
// the whole fix would have measured as no fix at all.
test("the request deadline is not shorter than the retry ceiling needs", async () => {
  const provider = ceilingRecordingProvider([
    { text: "", finishReason: "length" },
    { text: "Done." }
  ]);
  await new FastAgent({
    provider, toolset: stubToolset(), maxSteps: 6, maxElapsedMs: 6 * 60 * 1000
  }).run("draw a detailed car");

  const retryCeiling = provider.ceilings[1];
  // 90 tokens/s is a deliberately pessimistic floor against the 107 measured, so
  // this stays true on a slower day rather than only on the day it was written.
  const secondsNeeded = retryCeiling / 90;
  assert.ok(
    provider.timeouts[1] >= secondsNeeded * 1000,
    `a ${retryCeiling}-token ceiling needs ~${Math.round(secondsNeeded)}s to generate, ` +
    `but the request was given ${Math.round(provider.timeouts[1] / 1000)}s`
  );
});

// ---- The turn the endpoint threw away without saying so --------------------
//
// Measured against the configured endpoint 3 Sep 2026, streaming, on the real
// decision that shipped the bug — "write the stylesheet for the page you just
// wrote", which is ~5,000 output tokens:
//
//   max_tokens  4,096   21-31s, [DONE], finish_reason NULL, usage 1 token,
//                       no tool call and no text. The turn is discarded.
//   max_tokens 16,384   finish_reason "tool_calls", write_file, 14,647 bytes.
//
// `wasTruncated` cannot see the first row, so the loop read it as the model
// having finished and settled the run COMPLETED with two of three files missing.
// These tests pin the detector and the recovery.

// A provider that can return a turn exactly as the endpoint really returned it,
// including a null finish reason — which `scriptedProvider` cannot express,
// because it defaults to "stop".
function discardingProvider(turns) {
  const ceilings = [];
  return {
    ceilings,
    supportsChat: () => true,
    async chat({ maxTokens }) {
      ceilings.push(maxTokens);
      const turn = turns.shift() ?? { text: "Done.", finishReason: "stop" };
      return {
        text: turn.text ?? "",
        toolCalls: (turn.toolCalls ?? []).map((call, index) => ({
          id: `call_${index}`, name: call.name, arguments: JSON.stringify(call.args ?? {})
        })),
        // Deliberately NOT defaulted. `null` is the value under test.
        finishReason: turn.finishReason ?? null,
        usage: turn.usage ?? { completion_tokens: 1 }
      };
    }
  };
}

test("a turn with nothing in it and no finish reason is a discarded turn", () => {
  assert.equal(wasDiscarded({ finishReason: null, toolCalls: [], text: "" }), true);
  assert.equal(wasDiscarded({ finishReason: undefined, toolCalls: [], text: "  \n " }), true,
    "whitespace is not text — the endpoint sent \"\\n\\n\" on the measured failure");
});

test("an ordinary end of turn is never mistaken for a discarded one", () => {
  // The commonest turn there is: the model answers in words and stops. Retrying
  // it would put an extra step on every completed conversation.
  assert.equal(wasDiscarded({ finishReason: "stop", toolCalls: [], text: "" }), false,
    "a provider that said how the turn ended is not hiding anything");
  assert.equal(wasDiscarded({ finishReason: null, toolCalls: [], text: "Python 3.12 is installed." }), false,
    "prose arrived, so the turn delivered something");
  assert.equal(wasDiscarded({ finishReason: null, toolCalls: [{ name: "run" }], text: "" }), false,
    "a tool call arrived, so the turn delivered something");
});

test("a discarded turn is retried with more room, not settled as an answer", async () => {
  const provider = discardingProvider([
    // The measured shape: nothing at all, and the endpoint will not say why.
    { text: "", toolCalls: [], finishReason: null },
    { text: "Wrote the stylesheet.", finishReason: "stop" }
  ]);
  const outcome = await new FastAgent({ provider, toolset: stubToolset(), maxSteps: 6 })
    .run("build me a three file web app");

  assert.ok(provider.ceilings.length >= 2, "a discarded turn must be retried, not settled on");
  assert.ok(
    provider.ceilings[1] > provider.ceilings[0],
    `the retry must raise the ceiling — got ${provider.ceilings[0]} then ${provider.ceilings[1]}. ` +
    "The turn was thrown away for being too large; asking again with the same room asks for the same failure."
  );
  assert.equal(outcome.status, "COMPLETED");
});

test("a discarded turn twice is reported, never settled COMPLETED on old prose", async () => {
  // THE EXACT SHAPE THAT SHIPPED. A tool call succeeds, the model narrates the
  // next file, and the turn that would have written it is discarded — twice.
  // Settling COMPLETED here is how "Now the CSS:" became the final answer of a
  // run that had built one file of three.
  const provider = discardingProvider([
    { text: "Writing the HTML.", toolCalls: [{ name: "run", args: {} }], finishReason: "tool_calls" },
    { text: "", toolCalls: [], finishReason: null },
    { text: "", toolCalls: [], finishReason: null }
  ]);
  const outcome = await new FastAgent({
    provider,
    toolset: stubToolset({ run: () => ({ ok: true, text: "Wrote index.html." }) }),
    maxSteps: 8
  }).run("build me a three file web app");

  assert.equal(
    outcome.status, "PARTIALLY_COMPLETED",
    "a run that never got its tool call made is not a completed one, whatever the last sentence said"
  );
  assert.match(
    outcome.message, /smaller pieces/,
    "the user must be told the recovery, because the run cannot take it themselves"
  );
});

test("an empty turn that did nothing never reports Done", async () => {
  // OBSERVED LIVE, 4 SEP 2026, in the real UI. "create a file at ...
  // daily-note.txt" settled COMPLETED with the single word "Done." — 1 step,
  // zero tool calls, and no file on disk. The model had returned an empty turn,
  // and `lastText || "Done."` supplied the word out of thin air. The evidence
  // backstop could not catch it: it reads the MODEL's text, and the model had
  // not said anything. The claim was the loop's own.
  const provider = scriptedProvider([{ text: "", toolCalls: [] }]);
  const outcome = await new FastAgent({ provider, toolset: stubToolset(), maxSteps: 3 })
    .run("create a file at C:/tmp/note.txt saying hello");

  assert.notEqual(outcome.status, "COMPLETED", "nothing ran, so the run did not complete");
  assert.equal(/^\s*done\.?\s*$/i.test(outcome.message), false,
    `a run that called no tool and said nothing must not answer "Done." — got ${JSON.stringify(outcome.message)}`);
  assert.match(outcome.message, /did nothing/i);
});

test("an empty turn AFTER real work still reports what was done", async () => {
  // The other half, and why this is not just "refuse empty turns". A model that
  // ran the tools and simply had no closing remark has receipts in the
  // transcript; "Done." is true there, and removing it would turn every quiet
  // success into a failure.
  const provider = scriptedProvider([
    { text: "", toolCalls: [{ name: "run", args: {} }] },
    { text: "", toolCalls: [] }
  ]);
  const outcome = await new FastAgent({
    provider,
    toolset: stubToolset({ run: async () => ({ ok: true, text: "wrote it" }) }),
    maxSteps: 4
  }).run("write the file");

  assert.equal(outcome.status, "COMPLETED");
  assert.match(outcome.message, /done/i);
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

// THE SIXTH TIME THIS CLASS SHIPPED, AND THE PATTERN WAS TWO WORDS SHORT.
//
// Live, 21 Aug 2026: "now at 20" -> "Volume is now set to 20%." in one step with
// ZERO tool calls and 10 output tokens. The endpoint was at 100%. The user
// answered "no its not", a reading was taken, and it was 100.
//
// "Volume is now 20%" was caught. "Volume is now SET TO 20%" was not, because
// each previous fix had added exactly one more optional word to the middle of
// the pattern — `now`, then `at` — and the model reached one word wider.
//
// These cases are the phrasings, not the sentence. A fix that only adds "set to"
// passes the first line here and loses to the next transcript.
test("a machine value asserted with no tool call is a claim, however it is phrased", () => {
  for (const said of [
    "Volume is now set to 20%.",          // the live one
    "Volume is now set to 20 percent.",   // spelled out
    "The volume is now set to 20%.",      // with an article
    "Volume set to 20%.",                 // no copula at all
    "Volume currently 40%.",
    "The volume is back at 100%.",
    "It is already muted."
  ]) {
    assert.equal(claimsWithoutEvidence(said), true,
      `${JSON.stringify(said)} states a level nothing read — it must not reach the user unchallenged`);
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

// THE HONESTY LAYER LAPSED THE MOMENT A RUN DID ANYTHING.
//
// Every tool result carries a typed receipt and a tool's success sentence is
// reachable only through `confirmed()`. Then the run ends and the product prints
// `lastText` — free prose from the model, checked by nothing. Both call sites of
// `claimsWithoutEvidence` were guarded by `toolCalls === 0`, so the guarantee
// covered a run that did nothing and lapsed for every run that did something.
//
// Five tool calls, all REFUTED, closing on "I've sent the message" was published
// under a green tick: the original defect of this project — a message reported
// sent while the text sat unsent in a search box — with steps in front of it.
function actingToolset(results) {
  let index = 0;
  return {
    definitions: [{ type: "function", function: { name: "key", description: "", parameters: {} } }],
    has: () => true,
    previewOf: () => "",
    isActingTool: () => true,
    async execute() {
      const next = results[Math.min(index, results.length - 1)];
      index += 1;
      return next;
    }
  };
}

const refutedResult = {
  ok: false,
  text: "the message is not in the conversation",
  raw: { evidence: { verdict: "REFUTED", observed: "not found", method: "screen.read" } }
};
const confirmedResult = {
  ok: true,
  text: "sent",
  raw: { evidence: { verdict: "CONFIRMED", observed: "found in the conversation", method: "screen.read" } }
};

test("a claim of having acted, on a run where nothing was confirmed, is not published as COMPLETED", async () => {
  const agent = new FastAgent({
    provider: scriptedProvider([
      { text: "Sending it.", toolCalls: [{ name: "key", args: { keys: "enter" } }] },
      { text: "I've sent the message." }
    ]),
    toolset: actingToolset([refutedResult]),
    maxSteps: 6
  });

  const outcome = await agent.run("send it");

  assert.equal(outcome.status, "PARTIALLY_COMPLETED");
  assert.match(outcome.message, /I've sent the message\./, "the model's words must still be shown");
  assert.match(outcome.message, /reported that it did NOT work/i);
  assert.match(outcome.message, /none of them confirmed/i);
});

// THE OTHER HALF, AND IT IS WHY THIS COUNTS RECEIPTS RATHER THAN TOOL CALLS.
// After real work the model says "I've saved it" and it is TRUE, because an
// acting tool confirmed it. A guard that fires on that is one that gets switched
// off — the defect class this codebase has paid for seven times.
test("the same sentence goes through untouched when an acting tool confirmed it", async () => {
  const agent = new FastAgent({
    provider: scriptedProvider([
      { text: "Sending it.", toolCalls: [{ name: "key", args: { keys: "enter" } }] },
      { text: "I've sent the message." }
    ]),
    toolset: actingToolset([confirmedResult]),
    maxSteps: 6
  });

  const outcome = await agent.run("send it");

  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.message, "I've sent the message.");
});

// An ordinary answer that claims nothing must not be touched either, however
// little was confirmed — a lookup confirms nothing and is not claiming anything.
test("a run that claims nothing is unaffected by the receipt check", async () => {
  const agent = new FastAgent({
    provider: scriptedProvider([
      { text: "Looking.", toolCalls: [{ name: "key", args: {} }] },
      { text: "There are four windows open at the moment." }
    ]),
    toolset: actingToolset([refutedResult]),
    maxSteps: 6
  });

  const outcome = await agent.run("what is open");

  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.message, "There are four windows open at the moment.");
});
