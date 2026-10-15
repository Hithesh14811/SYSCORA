// THE MODEL A STRANGER CONFIGURED, NOT THE ONE THIS PROJECT WAS BUILT ON.
//
// A fresh clone set up with someone's own GPT or Claude key showed "Auto chose
// DeepSeek V4 Flash" under every message, refused every image as if the model
// were blind, and — before anything was saved — answered "Test connection" with
// "Connection verified." about the offline mock. Found 15 Oct 2026 by running a
// clean clone against a stand-in endpoint. These pin each piece:
//
//   1. the picker describes the configured model, and claims no choice it did
//      not make
//   2. an image goes through only to a model that can see, and only when the
//      agent can reach the file — read_file then hands the model the picture
//   3. every transport carries that picture, Gemini included
//   4. the daemon reports whether the model can see, and will not "verify" a
//      provider that was never saved

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AUTO, CONFIGURED, MODELS, applyConfiguredModel, checkAttachments, chooseModel, requirementsFor
} from "../../apps/desktop/models.js";
import { describeAttachments } from "../../apps/desktop/attachments.js";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import { CONFIRMED, REFUTED } from "../../packages/fast-agent/src/evidence.js";
import {
  ConsentAwareModelProvider, GeminiModelProvider, createModelProviderChain
} from "../../packages/model-providers/src/index.js";
import { startServer } from "../../apps/daemon/src/server.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);
const image = (extra = {}) => ({ kind: "image", name: "shot.png", dataUrl: "data:image/png;base64,AAA", ...extra });

test.afterEach(() => applyConfiguredModel({}));

test("the picker names the configured model, never a built-in one", () => {
  assert.equal(MODELS.length, 1);
  assert.equal(MODELS[0].id, CONFIGURED);
  assert.ok(!MODELS.some((model) => /deepseek/i.test(`${model.id} ${model.label}`)),
    "a hard-coded model name is what every stranger's chat was labelled with");

  applyConfiguredModel({ provider: "openai", model: "gpt-4o-mini", vision: true });
  assert.equal(MODELS[0].label, "gpt-4o-mini");
  assert.equal(MODELS[0].capabilities.images, true);

  applyConfiguredModel({ provider: "anthropic", model: null, vision: false });
  assert.equal(MODELS[0].label, "Anthropic", "no model name falls back to the provider, not to a guess");
  assert.equal(MODELS[0].capabilities.images, false);

  applyConfiguredModel({});
  assert.equal(MODELS[0].label, "Your model");
  assert.equal(MODELS[0].capabilities.images, false, "unknown means it cannot see");
});

test("with one model, Auto says nothing about having chosen", () => {
  applyConfiguredModel({ provider: "openai", model: "gpt-4o-mini" });
  const { model, reason } = chooseModel(requirementsFor({ attachments: [] }));
  assert.equal(model?.id, CONFIGURED);
  assert.equal(reason, null);
});

test("an image reaches a model that can see, when the agent can open the file", () => {
  applyConfiguredModel({ provider: "openai", model: "gpt-4o", vision: true });
  const withPath = image({ path: "C:\\Users\\someone\\shot.png" });
  for (const choice of [AUTO, CONFIGURED]) {
    assert.equal(checkAttachments(choice, [withPath]).ok, true, `${choice} refused an image a seeing model could open`);
  }
  const described = describeAttachments([withPath]);
  assert.match(described, /Attached image: shot\.png at C:\\Users\\someone\\shot\.png/);
  assert.match(described, /read_file \{path: "C:\\\\Users\\\\someone\\\\shot\.png"\}/,
    "the agent has to be told how to look, or the picture is never opened");
});

test("an image is refused, saying why, when it would not be looked at", () => {
  applyConfiguredModel({ provider: "openai", model: "gpt-4o", vision: true });
  // A plain browser gives no path, and the picture travels only as a file.
  for (const choice of [AUTO, CONFIGURED]) {
    const verdict = checkAttachments(choice, [image()]);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /cannot give SYSCORA the image file/);
  }
  applyConfiguredModel({ provider: "deepseek", model: "deepseek-chat", vision: false });
  const blind = checkAttachments(AUTO, [image({ path: "C:\\x\\shot.png" })]);
  assert.equal(blind.ok, false);
  assert.match(blind.reason, /reads text, not pictures/);
});

function toolsetWithVision(available) {
  const registry = { get: () => null };
  const toolset = buildToolset({ registry, adapter: {}, basePath: os.tmpdir(), confirm: async () => true });
  toolset.setAccessPolicy?.({ developerMode: true, workspaceRoots: [] });
  toolset.setVisionAvailable(available);
  return toolset;
}

test("read_file shows an image to a model that can see, and refuses plainly when it cannot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-image-"));
  try {
    const file = path.join(dir, "shot.png");
    await fs.writeFile(file, PNG);

    const seen = await toolsetWithVision(true).execute("read_file", { path: file });
    assert.equal(seen.ok, true, seen.text);
    assert.equal(seen.raw.imageAttachment.mediaType, "image/png");
    assert.equal(Buffer.from(seen.raw.imageAttachment.data, "base64").equals(PNG), true);
    assert.match(seen.raw.imageAttachment.caption, /image file you opened/);
    assert.equal(seen.raw.evidence.verdict, CONFIRMED);
    assert.doesNotMatch(seen.text, /\uFFFD/, "the bytes must not be read as text");

    const blind = await toolsetWithVision(false).execute("read_file", { path: file });
    // Reported the way an unreadable document is: the receipt says nothing was
    // shown, and the text says why and what to do instead.
    assert.equal(blind.raw.evidence.verdict, REFUTED);
    assert.equal(blind.raw.imageAttachment, undefined, "a blind model sent an image fails the whole request");
    assert.match(blind.text, /cannot see images/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// The unit tests for `screen {vision}` hand the loop a bare provider. The daemon
// hands it ConsentAware(Failover([...])), and neither wrapper said what the
// model could do — so in the running app every model was "blind". Built here
// exactly the way runtime-factory builds it.
test("the wrapped provider chain the daemon uses says whether the model can see", () => {
  const chain = (model) => new ConsentAwareModelProvider({
    provider: createModelProviderChain({ provider: "openai", model, apiKey: "dummy-test-key-0123", baseUrl: "http://127.0.0.1:9/v1" }),
    consentScopes: ["EXTERNAL_AI_SANITIZED_REASONING"]
  });
  assert.equal(chain("gpt-4o").supportsVision(), true);
  assert.equal(chain("deepseek-chat").supportsVision(), false);
  assert.equal(new ConsentAwareModelProvider({ provider: createModelProviderChain({ provider: "mock" }) }).supportsVision(), false);
});

test("Gemini is sent the picture, not an empty turn", () => {
  const contents = GeminiModelProvider._toGeminiContents([
    { role: "user", content: "what is in it?" },
    {
      role: "user",
      content: [
        { type: "text", text: "[the image file you opened — C:\\x\\shot.png]" },
        { type: "input_image", mediaType: "image/png", data: "AAAA" }
      ]
    }
  ]);
  const last = contents.at(-1);
  assert.equal(last.role, "user");
  assert.deepEqual(last.parts.find((part) => part.inlineData)?.inlineData, { mimeType: "image/png", data: "AAAA" });
  assert.ok(last.parts.some((part) => /image file you opened/.test(part.text ?? "")));
});

test("the daemon reports vision, and will not verify a provider nobody saved", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-fresh-state-"));
  const saved = {};
  for (const key of ["SYSCORA_STATE_DIR", "SYSCORA_API_TOKEN", "SYSCORA_MODEL_PROVIDER", "LLM_PROVIDER", "SYSCORA_MODEL_NAME"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.SYSCORA_STATE_DIR = stateDir;
  process.env.SYSCORA_API_TOKEN = "fresh-install-token-0123456789";
  const server = startServer({ port: 0, basePath: stateDir, warmHost: false });
  try {
    await new Promise((resolve) => server.on("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { "x-syscora-token": process.env.SYSCORA_API_TOKEN };

    const status = await (await fetch(`${base}/api/settings/model`, { headers })).json();
    assert.equal(status.provider, "mock");
    assert.equal(status.vision, false);

    const tested = await (await fetch(`${base}/api/settings/model/test`, { method: "POST", headers })).json();
    assert.equal(tested.health.ok, false, "the offline mock passing its own check is not a verified connection");
    assert.match(tested.health.reason, /No provider is saved yet/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});
