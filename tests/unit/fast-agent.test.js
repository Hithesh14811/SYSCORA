import test from "node:test";
import assert from "node:assert/strict";
import { FastAgent, buildToolset } from "../../packages/fast-agent/src/index.js";

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
        finishReason: turn.toolCalls?.length ? "tool_calls" : "stop"
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
  assert.equal(result.ok, true);
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
