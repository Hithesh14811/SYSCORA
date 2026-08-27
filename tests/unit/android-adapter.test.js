import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AndroidAdapter, parseAndroidHierarchy } from "../../os-adapters/android/src/android-adapter.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import { ApprovalMode, ShellExecutionMode } from "../../packages/shared-types/src/access-policy.js";
import { redactSensitiveData } from "../../packages/shared-types/src/redaction.js";

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "", timedOut: false, aborted: false, overflowed: false });

test("Android hierarchy parsing is semantic and never exposes password contents", () => {
  const xml = `<?xml version="1.0"?><hierarchy>
    <node text="Sign in" resource-id="title" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" password="false" bounds="[0,0][200,50]" />
    <node text="hunter2" resource-id="password" class="android.widget.EditText" package="com.example" content-desc="secret" clickable="true" enabled="true" password="true" bounds="[0,50][200,100]" />
  </hierarchy>`;
  const parsed = parseAndroidHierarchy(xml);
  assert.equal(parsed.nodes.length, 2);
  assert.equal(parsed.nodes[0].text, "Sign in");
  assert.deepEqual(parsed.nodes[0].center, { x: 100, y: 25 });
  assert.equal(parsed.nodes[1].text, "[password hidden]");
  assert.equal(parsed.nodes[1].description, "");
  assert.equal(JSON.stringify(parsed).includes("hunter2"), false);
  assert.equal(JSON.stringify(parsed).includes("secret"), false);
});

test("Android device inventory preserves wireless, unauthorized, and offline state", async () => {
  const adapter = new AndroidAdapter({ runner: async (_command, args) => {
    assert.deepEqual(args, ["devices", "-l"]);
    return ok("List of devices attached\n192.168.1.20:5555 device product:panther model:Pixel_7 device:panther transport_id:4\nZX1G22 unauthorized usb:1-2\nold-phone offline transport_id:8\n");
  } });
  const result = await adapter.listDevices();
  assert.equal(result.count, 3);
  assert.deepEqual(result.devices[0], {
    serial: "192.168.1.20:5555", state: "device", wireless: true,
    model: "Pixel_7", product: "panther", device: "panther", transportId: "4"
  });
  assert.equal(result.devices[1].state, "unauthorized");
  assert.equal(result.devices[2].state, "offline");
});

test("accepting USB authorization is stabilized inside one Android list call", async () => {
  const replies = [
    "List of devices attached\nphone-1 unauthorized usb:1-2\n",
    "List of devices attached\n",
    "List of devices attached\nphone-1 device model:Galaxy transport_id:7\n"
  ];
  let calls = 0;
  const progress = [];
  const adapter = new AndroidAdapter({ runner: async () => {
    calls += 1;
    return ok(replies.shift() ?? replies.at(-1));
  } });

  const unauthorized = await adapter.listDevices();
  assert.equal(unauthorized.devices[0].state, "unauthorized");
  const authorized = await adapter.listDevices({
    stabilizeMs: 100,
    pollIntervalMs: 1,
    onProgress: (event) => progress.push(event)
  });

  assert.equal(authorized.count, 1);
  assert.equal(authorized.devices[0].state, "device");
  assert.equal(authorized.authorizationReset, true);
  assert.equal(calls, 3, "the adapter should absorb the empty reconnect instant without another model turn");
  assert.match(progress[0].phase, /reconnect/i);
});

test("Android authorization stabilization stops promptly when the user presses Stop", async () => {
  let calls = 0;
  const adapter = new AndroidAdapter({ runner: async () => {
    calls += 1;
    return ok(calls === 1
      ? "List of devices attached\nphone-1 unauthorized\n"
      : "List of devices attached\n");
  } });
  await adapter.listDevices();
  const controller = new AbortController();
  const waiting = adapter.listDevices({ signal: controller.signal, stabilizeMs: 30_000, pollIntervalMs: 500 });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(waiting, /cancelled/i);
});

test("bounded Android setup activates adb immediately without changing PATH or restarting", async (t) => {
  if (process.platform !== "win32") return t.skip("automatic setup is Windows-specific");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-android-setup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const progress = [];
  const payload = new TextEncoder().encode("a small fake zip for the adapter seam");
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    headers: { get: (name) => name === "content-length" ? String(payload.byteLength) : null },
    body: new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close(); } }),
    url
  });
  const adapter = new AndroidAdapter({
    setupRoot: root,
    fetchImpl,
    extractArchive: async (_archive, destination) => {
      const folder = path.join(destination, "platform-tools");
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, "adb.exe"), "test executable");
    },
    runner: async (command, args) => {
      if (String(command).toLowerCase() === "adb") {
        return { ...ok(), exitCode: 1, stderr: "adb missing" };
      }
      if (args[0] === "version") return ok("Android Debug Bridge version 1.0.41\n");
      if (args[0] === "devices") return ok("List of devices attached\nphone-1 device model:Test\n");
      return ok();
    }
  });

  const result = await adapter.setupPlatformTools({ onProgress: (event) => progress.push(event) });
  assert.equal(result.installed, true);
  assert.equal(result.restartRequired, false);
  assert.equal(result.path, path.join(root, "platform-tools", "adb.exe"));
  assert.equal(process.env.PATH?.includes(root) ?? false, false, "setup must not mutate the process or user PATH");
  assert.equal(progress.at(-1).percent, 100);
  assert.equal((await adapter.listDevices()).count, 1, "the same adapter must use the new adb immediately");
});

test("Android actions always bind to an exact serial and refuse ambiguous semantic targets", async () => {
  const calls = [];
  const xml = `<?xml version="1.0"?><hierarchy>
    <node text="Play" resource-id="one" class="android.widget.Button" package="com.music" content-desc="" clickable="true" enabled="true" password="false" bounds="[0,0][100,100]" />
    <node text="Play" resource-id="two" class="android.widget.Button" package="com.music" content-desc="" clickable="true" enabled="true" password="false" bounds="[100,0][200,100]" />
  </hierarchy>`;
  const adapter = new AndroidAdapter({ runner: async (_command, args) => {
    calls.push(args);
    return ok(xml);
  } });
  await assert.rejects(() => adapter.tap("192.168.1.20:5555", { text: "Play" }), /ambiguous \(2 matches\)/);
  assert.deepEqual(calls[0].slice(0, 2), ["-s", "192.168.1.20:5555"]);
  assert.equal(calls.some((args) => args.includes("tap")), false);
  assert.equal(calls.some((args) => args.includes("shell.exe") || args.includes("powershell")), false);
});

test("Android hierarchy labels otherwise unlabelled clickable containers from contained text", () => {
  const xml = `<?xml version="1.0"?><hierarchy>
    <node text="" resource-id="tab-search" class="android.view.View" package="com.example" content-desc="" clickable="true" enabled="true" password="false" bounds="[0,100][300,220]">
      <node text="Search" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" password="false" bounds="[80,130][220,190]" />
    </node>
  </hierarchy>`;
  const parsed = parseAndroidHierarchy(xml);
  const container = parsed.nodes.find((node) => node.resourceId === "tab-search");
  assert.equal(container.semanticLabel, "Search");
});

test("Android tap resolves a static label to its accessible clickable container", async () => {
  const calls = [];
  const xml = `<?xml version="1.0"?><hierarchy>
    <node text="" resource-id="tab-search" class="android.view.View" package="com.example" content-desc="" clickable="true" enabled="true" password="false" bounds="[0,100][300,220]">
      <node text="Search" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" password="false" bounds="[80,130][220,190]" />
    </node>
  </hierarchy>`;
  const adapter = new AndroidAdapter({ runner: async (_command, args) => {
    calls.push(args);
    return ok(xml);
  } });
  const result = await adapter.tap("phone-1", { text: "Search" }, { waitForChangeMs: 0 });
  assert.equal(result.target.resourceId, "tab-search");
  const tap = calls.find((args) => args.includes("tap"));
  assert.deepEqual(tap.slice(-2), ["150", "160"]);
});

test("Android pairing code travels on stdin and is absent from process arguments", async () => {
  let seen;
  const adapter = new AndroidAdapter({ runner: async (_command, args, options) => {
    seen = { args, stdin: options.stdin };
    return ok("Successfully paired to 192.168.1.20:37001 [guid=abc]\n");
  } });
  const result = await adapter.pair("192.168.1.20:37001", "123456");
  assert.equal(result.paired, true);
  assert.equal(seen.args.includes("123456"), false);
  assert.equal(seen.stdin, "123456\n");
  assert.equal(JSON.stringify(result).includes("123456"), false);
  assert.deepEqual(redactSensitiveData({ endpoint: "192.168.1.20:37001", pairingCode: "123456" }), {
    endpoint: "192.168.1.20:37001", pairingCode: "***REDACTED***"
  });
});

test("Android URI metacharacters remain one quoted remote-shell argument", async () => {
  let argsSeen;
  const adapter = new AndroidAdapter({ runner: async (_command, args) => {
    argsSeen = args;
    return ok("Starting: Intent\n");
  } });
  const requested = "https://example.com/watch?one=1&next=$(id);done='yes'";
  const result = await adapter.openUri("phone-1", requested);
  assert.equal(result.performed, true);
  const uriArgument = argsSeen.at(-1);
  assert.equal(uriArgument.startsWith("'"), true);
  assert.equal(uriArgument.endsWith("'"), true);
  assert.match(uriArgument, /done=%27yes%27/);
  assert.equal(argsSeen.filter((arg) => arg === "id" || arg === "done").length, 0);
});

test("secure Android keyguard is never bypassed", async () => {
  const calls = [];
  const adapter = new AndroidAdapter({ runner: async (_command, args) => {
    calls.push(args);
    if (args.includes("policy")) return ok("isStatusBarKeyguard=true\nmIsSecure=true\n");
    if (args.includes("windows")) return ok("mCurrentFocus=Window{1 u0 com.android.systemui/.keyguard.KeyguardViewMediator}\n");
    return ok();
  } });
  const result = await adapter.dismissKeyguard("phone-1");
  assert.equal(result.performed, false);
  assert.match(result.reason, /will not bypass PIN, password, pattern, biometric/i);
  assert.equal(calls.some((args) => args.includes("dismiss-keyguard")), false);
  assert.equal(calls.some((args) => args.includes("KEYCODE_WAKEUP")), true);
});

test("unknown Android lock security fails closed instead of attempting dismissal", async () => {
  const calls = [];
  const adapter = new AndroidAdapter({ runner: async (_command, args) => {
    calls.push(args);
    if (args.includes("policy")) return ok("isStatusBarKeyguard=true\n");
    if (args.includes("windows")) return ok("mCurrentFocus=Window{1 u0 com.android.systemui/.Keyguard}\n");
    return ok();
  } });
  const result = await adapter.dismissKeyguard("phone-1");
  assert.equal(result.performed, false);
  assert.match(result.reason, /does not publish enough lock security state/i);
  assert.equal(calls.some((args) => args.includes("dismiss-keyguard")), false);
});

test("multi-device Android work overlaps across devices while retaining exact serials", async () => {
  let active = 0;
  let peak = 0;
  const seenSerials = new Set();
  const adapter = new AndroidAdapter({ runner: async (_command, args) => {
    const serialIndex = args.indexOf("-s");
    if (serialIndex >= 0) seenSerials.add(args[serialIndex + 1]);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    if (args.includes("getprop")) return ok("[ro.product.model]: [Test Phone]\n[ro.build.version.release]: [16]\n");
    if (args.includes("battery")) return ok("level: 90\ntemperature: 250\n");
    if (args.includes("size")) return ok("Physical size: 1080x2400\n");
    if (args.includes("df")) return ok("Filesystem 1K-blocks Used Available Use% Mounted on\n/data 1000 400 600 40% /data\n");
    if (args.includes("windows")) return ok("mCurrentFocus=Window{1 u0 com.example/.Main}\n");
    if (args.includes("policy")) return ok("isStatusBarKeyguard=false\nmIsSecure=true\n");
    return ok();
  } });
  const result = await adapter.runOnDevices(["phone-a", "phone-b"], "inspect");
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual([...seenSerials].sort(), ["phone-a", "phone-b"]);
  assert.ok(peak >= 2, `expected device operations to overlap, peak was ${peak}`);
});

test("Android capabilities and compact tools are present only when explicitly wired", () => {
  const desktopAdapter = {};
  const withoutAndroid = createDefaultCapabilityRegistry(desktopAdapter);
  assert.equal(withoutAndroid.has("android.device.list"), false);
  assert.equal(buildToolset({ registry: withoutAndroid, adapter: desktopAdapter }).has("android_screen"), false);

  const androidAdapter = new AndroidAdapter({ runner: async () => ok("Android Debug Bridge version 1.0.41\n") });
  const withAndroid = createDefaultCapabilityRegistry(desktopAdapter, { androidAdapter });
  assert.equal(withAndroid.has("android.device.list"), true);
  assert.equal(withAndroid.has("android.device.wait"), true);
  assert.equal(withAndroid.has("android.device.refresh"), true);
  const tools = buildToolset({ registry: withAndroid, adapter: desktopAdapter });
  assert.equal(tools.has("android_devices"), false, "Android schemas stay out of unrelated desktop turns");
  tools.beginTurn("connect my Android phone");
  assert.equal(tools.has("android_devices"), true);
  assert.equal(tools.has("android_screen"), true);
  assert.equal(tools.has("android_tap"), true);
  assert.equal(tools.has("android_many"), true);
});

test("android_screen gives the model semantic controls and no image payload", async () => {
  const xml = `<?xml version="1.0"?><hierarchy>
    <node text="Baby" resource-id="com.spotify.music:id/title" class="android.widget.TextView" package="com.spotify.music" content-desc="" clickable="true" enabled="true" password="false" bounds="[0,0][200,80]" />
  </hierarchy>`;
  const androidAdapter = new AndroidAdapter({ runner: async (_command, args) => {
    assert.deepEqual(args.slice(0, 2), ["-s", "phone-1"]);
    return ok(xml);
  } });
  const registry = createDefaultCapabilityRegistry({}, { androidAdapter });
  const tools = buildToolset({ registry, adapter: {} });
  tools.beginTurn("read my Android phone screen");
  const result = await tools.execute("android_screen", { serial: "phone-1" });
  assert.equal(result.ok, true);
  assert.match(result.text, /no screenshot used/i);
  assert.match(result.text, /Baby/);
  assert.match(result.text, /resourceId="com\.spotify\.music:id\/title"/);
  assert.equal(JSON.stringify(result.raw).includes("image"), false);
});

test("android_screen ranks actionable controls first and collapses an unchanged hierarchy", async () => {
  const passive = Array.from({ length: 130 }, (_, index) =>
    `<node text="Passive ${index}" resource-id="p${index}" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" password="false" bounds="[0,${index * 2}][200,${index * 2 + 1}]" />`).join("\n");
  const xml = `<?xml version="1.0"?><hierarchy>${passive}
    <node text="Dismiss" resource-id="modal-dismiss" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" password="false" bounds="[0,400][200,480]" />
  </hierarchy>`;
  const androidAdapter = new AndroidAdapter({ runner: async () => ok(xml) });
  const registry = createDefaultCapabilityRegistry({}, { androidAdapter });
  const tools = buildToolset({ registry, adapter: {} });
  tools.beginTurn("read my Android phone screen");
  const first = await tools.execute("android_screen", { serial: "phone-1" });
  const second = await tools.execute("android_screen", { serial: "phone-1", maxNodes: 700 });
  assert.match(first.text, /Dismiss/);
  assert.match(second.text, /IDENTICAL/);
  assert.ok(second.text.length < 400, `unchanged hierarchy should be compact, got ${second.text.length}`);
  assert.equal(second.raw.screenUnchanged, true);
});

test("a new turn gets a full Android hierarchy instead of a stale delta", async () => {
  const xml = `<?xml version="1.0"?><hierarchy>
    <node text="Continue" resource-id="continue" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" password="false" bounds="[0,0][200,80]" />
  </hierarchy>`;
  const androidAdapter = new AndroidAdapter({ runner: async () => ok(xml) });
  const registry = createDefaultCapabilityRegistry({}, { androidAdapter });
  const tools = buildToolset({ registry, adapter: {} });
  tools.beginTurn("read my Android phone screen");
  await tools.execute("android_screen", { serial: "phone-1" });
  const sameTurn = await tools.execute("android_screen", { serial: "phone-1" });
  assert.equal(sameTurn.raw.screenUnchanged, true);
  tools.beginTurn("continue on my phone");
  const newTurn = await tools.execute("android_screen", { serial: "phone-1" });
  assert.equal(newTurn.raw.screenUnchanged, null);
  assert.match(newTurn.text, /Continue/);
});

test("Android irreversible tap is refused before ADB acts", async () => {
  let calls = 0;
  const androidAdapter = new AndroidAdapter({ runner: async () => { calls += 1; return ok(); } });
  const registry = createDefaultCapabilityRegistry({}, { androidAdapter });
  const tools = buildToolset({ registry, adapter: {} });
  tools.beginTurn("tap Send on my Android phone");
  tools.setConfirmer(async () => false);
  const result = await tools.execute("android_tap", { serial: "phone-1", selector: { text: "Send" } });
  assert.equal(result.ok, false);
  assert.match(result.text, /did not approve/i);
  assert.equal(calls, 0);
});

test("Ask mode refuses wireless Android connection at the final tool boundary", async () => {
  let calls = 0;
  const androidAdapter = new AndroidAdapter({ runner: async () => { calls += 1; return ok(); } });
  const registry = createDefaultCapabilityRegistry({}, { androidAdapter });
  const tools = buildToolset({ registry, adapter: {} });
  tools.beginTurn("connect my Android phone wirelessly");
  tools.setAccessPolicy({ approvalMode: ApprovalMode.ASK, developerMode: false, shellExecutionMode: ShellExecutionMode.NONE });
  tools.setConfirmer(async () => false);
  const result = await tools.execute("android_devices", { operation: "connect", endpoint: "192.168.1.20:5555" });
  assert.equal(result.ok, false);
  assert.match(result.text, /did not approve/i);
  assert.equal(calls, 0);
});

test("Enter in Android WhatsApp asks before the key reaches the phone", async () => {
  const calls = [];
  const androidAdapter = new AndroidAdapter({ runner: async (_command, args) => {
    calls.push(args);
    if (args.includes("getprop")) return ok("[ro.product.model]: [Test]\n");
    if (args.includes("battery")) return ok("level: 80\n");
    if (args.includes("size")) return ok("Physical size: 1080x2400\n");
    if (args.includes("df")) return ok("/data 1000 400 600 40% /data\n");
    if (args.includes("windows")) return ok("mCurrentFocus=Window{1 u0 com.whatsapp/.Main}\n");
    if (args.includes("policy")) return ok("isStatusBarKeyguard=false\nmIsSecure=true\n");
    return ok();
  } });
  const registry = createDefaultCapabilityRegistry({}, { androidAdapter });
  const tools = buildToolset({ registry, adapter: {} });
  tools.beginTurn("send the WhatsApp message on my Android phone");
  tools.setConfirmer(async () => false);
  const result = await tools.execute("android_act", { operation: "key", serial: "phone-1", key: "enter" });
  assert.equal(result.ok, false);
  assert.match(result.text, /did not approve sending/i);
  assert.equal(calls.some((args) => args.includes("KEYCODE_ENTER")), false);
});
