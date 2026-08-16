// THE ONE PLACE A SKILL REACHES THE DISK.
//
// A skill drives the user's machine unattended, so it must arrive there only
// because they said yes — never because a task happened to succeed. These go
// through the real daemon, because that is where the yes is turned into a file,
// and because a refusal that gets softened somewhere between the store and the
// HTTP response is a macro on somebody's disk.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startServer } from "../../apps/daemon/src/server.js";

const goodSkill = {
  id: "open-chintu",
  title: "Open the chat with Chintu",
  match: { examples: ["open the chat with {contact}"] },
  steps: [{ tool: "click", args: { text: "{contact}", section: "Chats" }, verify: { kind: "element-present" } }]
};

async function withServer(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-skills-api-"));
  const token = `test-${Math.random().toString(16).slice(2)}`;
  process.env.SYSCORA_API_TOKEN = token;
  // Nothing here reaches the screen, and warming the automation host costs a
  // second of PowerShell startup per test file for no benefit.
  const server = startServer({ port: 0, basePath: workspace, warmHost: false });
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, route, body) => fetch(`${base}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-syscora-token": token },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  try {
    await run({ call, base, workspace });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a skill the user accepts is kept, and can be listed and deleted", async () => {
  await withServer(async ({ call }) => {
    const empty = await (await call("GET", "/api/skills")).json();
    assert.deepEqual(empty.skills, [], "nothing is saved until somebody says yes");

    const saved = await (await call("POST", "/api/skills", { skill: goodSkill })).json();
    assert.equal(saved.saved, true);

    const listed = await (await call("GET", "/api/skills")).json();
    assert.equal(listed.skills.length, 1);
    assert.equal(listed.skills[0].id, "open-chintu");
    assert.equal(listed.skills[0].stats.runs, 0);

    const removed = await (await call("DELETE", "/api/skills/open-chintu")).json();
    assert.equal(removed.deleted, true);
    assert.deepEqual((await (await call("GET", "/api/skills")).json()).skills, []);
  });
});

// A COORDINATE MUST NOT SURVIVE THE ROUND TRIP. This is the failure mode the
// whole design exists to prevent: a recorded click(718, 1151) that lands on a
// blank pixel after somebody resizes a window, and reports success.
test("a route containing a coordinate is refused, with the reason intact", async () => {
  await withServer(async ({ call }) => {
    const response = await call("POST", "/api/skills", {
      skill: { ...goodSkill, steps: [{ tool: "click", args: { x: 718, y: 1151 } }] }
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.saved, false);
    assert.match(body.problems.join(" "), /positional/);
    assert.match(body.problems.join(" "), /perception/, "the reason must survive to the caller");
    assert.deepEqual((await (await call("GET", "/api/skills")).json()).skills, []);
  });
});

test("nonsense is refused rather than written", async () => {
  await withServer(async ({ call }) => {
    assert.equal((await (await call("POST", "/api/skills", {})).json()).saved, false);
    assert.equal((await (await call("POST", "/api/skills", { skill: { id: "x" } })).json()).saved, false);
    assert.deepEqual((await (await call("GET", "/api/skills")).json()).skills, []);
  });
});

// The daemon is 127.0.0.1 only and token-gated; a route that drives the machine
// must not be the one that forgets it.
test("the skills routes are behind the token like everything else", async () => {
  await withServer(async ({ base }) => {
    const withoutToken = await fetch(`${base}/api/skills`);
    assert.notEqual(withoutToken.status, 200, "no token, no skills");
  });
});
