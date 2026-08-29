import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalizePath, isCanonicalPathInside } from "../../packages/shared-types/src/canonical-path.js";

test("canonical containment accepts missing descendants and rejects sibling prefixes", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-canonical-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "work");
  await fs.mkdir(root);

  assert.equal(isCanonicalPathInside(path.join(root, "new", "file.txt"), root), true);
  assert.equal(isCanonicalPathInside(path.join(base, "workspace-escape", "file.txt"), root), false);
});

test("canonical containment resolves junction and symlink escapes", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-reparse-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "work");
  const outside = path.join(base, "outside");
  const link = path.join(root, "linked");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");

  const escaped = path.join(link, "new-file.txt");
  assert.equal(isCanonicalPathInside(escaped, root), false);
  assert.equal(canonicalizePath(escaped), path.join(await fs.realpath(outside), "new-file.txt"));
});

