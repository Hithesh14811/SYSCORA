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

  const screen = await toolset.execute("screen", {});
  assert.match(screen.text, /Window: notepad/);
  assert.match(screen.text, /0\| Button "Save" @30,25/);
  assert.match(screen.text, /1\| Edit "Text Editor" @100,90/);

  const click = await toolset.execute("click", { element: 1 });
  assert.equal(click.ok, true);
  assert.match(click.text, /Clicked at 100,90/);
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
  const screen = await toolset.execute("screen", {});
  const listed = screen.text.match(/^\d+\| /gm) ?? [];
  assert.equal(listed.length, 4, `six raw elements, four real controls, got:\n${screen.text}`);
  assert.equal((screen.text.match(/"Eight"/g) ?? []).length, 1);
});

test("clicking by label lands on that control, whatever its position in the list", async () => {
  const toolset = calculatorToolset();
  await toolset.execute("screen", {});
  const eight = await toolset.execute("click", { text: "Eight" });
  assert.equal(eight.ok, true);
  assert.match(eight.text, /Clicked at 660,1089/);
  const multiply = await toolset.execute("click", { text: "Multiply by" });
  assert.match(multiply.text, /Clicked at 1009,580/);
});

test("clicking a label that is not on screen refuses rather than clicking the nearest thing", async () => {
  const toolset = calculatorToolset();
  await toolset.execute("screen", {});
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

  await toolset.execute("screen", {});
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
