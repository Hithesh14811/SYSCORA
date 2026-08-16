// THE WINDOW NAMED AFTER THE APPLICATION IS NOT ALWAYS THE APPLICATION.
//
// Measured on this machine, 15 Aug 2026, WhatsApp open on a chat:
//
//   WhatsApp.Root   "WhatsApp"        hwnd 198130   6 elements
//   msedgewebview2  "(139) WhatsApp"  hwnd 197286  90 elements, every icon button
//
// Asking to read "whatsapp" scored the process name and returned the frame — six
// elements, three of them Minimize/Restore/Close. Every WhatsApp failure on
// record follows from that, and none of them were a missing accessibility tree.
//
// The two windows share no handle, no parent and no owner. The ONLY thing tying
// them together is that msedgewebview2 23468 is a child process of
// WhatsApp.Root 21256, which is what these tests pin down — including the cases
// where matching on anything looser would put a browser window the user opened
// inside somebody else's application.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCESSIBILITY_LAUNCH_FLAG,
  accessibilityLaunchArgs,
  descendsFrom,
  normalizeWindow,
  pickWebviewWindow
} from "../../os-adapters/windows/src/webview-windows.js";

// The real numbers off this machine, so a change that breaks the case this was
// built for fails here rather than in front of somebody.
const WHATSAPP_FRAME = {
  Id: 21256, ProcessName: "WhatsApp.Root", MainWindowTitle: "WhatsApp",
  WindowHandle: 198130, ClassName: "WinUIDesktopWin32WindowClass",
  Bounds: { x: -13, y: -13, width: 2906, height: 1730 }
};
const WHATSAPP_CONTENT = {
  Id: 23468, ProcessName: "msedgewebview2", MainWindowTitle: "(139) WhatsApp",
  WindowHandle: 197286, ClassName: "Chrome_WidgetWin_1",
  Bounds: { x: 0, y: 0, width: 2880, height: 1704 }
};
const NOTEPAD = {
  Id: 17872, ProcessName: "Notepad", MainWindowTitle: "*hi - Notepad",
  WindowHandle: 500100, ClassName: "Notepad",
  Bounds: { x: 100, y: 100, width: 800, height: 600 }
};
const WHATSAPP_PARENTS = new Map([[23468, 21256], [21256, 4]]);

test("the reading of an application follows into its content window", () => {
  const picked = pickWebviewWindow({
    frameWindowId: "198130",
    windows: [WHATSAPP_FRAME, WHATSAPP_CONTENT, NOTEPAD],
    parentOf: WHATSAPP_PARENTS
  });
  assert.equal(picked?.windowId, "197286");
  assert.equal(picked?.processName, "msedgewebview2");
});

test("a native window is left alone — there is nothing to follow", () => {
  const picked = pickWebviewWindow({
    frameWindowId: String(NOTEPAD.WindowHandle),
    windows: [WHATSAPP_FRAME, WHATSAPP_CONTENT, NOTEPAD],
    parentOf: WHATSAPP_PARENTS
  });
  assert.equal(picked, null);
});

// THE CASE THAT MAKES PARENTAGE NON-NEGOTIABLE.
//
// A title rule ("its title says WhatsApp") or a process rule ("it is Chromium")
// would both hand the user's own browser to WhatsApp — and then a click meant
// for a chat lands in a tab they had open. Chrome descends from explorer, not
// from the application, and that is the whole difference.
test("a browser window of the user's own is never mistaken for an application's", () => {
  const userChrome = {
    Id: 13444, ProcessName: "chrome", MainWindowTitle: "WhatsApp Web - Google Chrome",
    WindowHandle: 700200, ClassName: "Chrome_WidgetWin_1",
    Bounds: { x: 0, y: 0, width: 2880, height: 1704 }
  };
  const picked = pickWebviewWindow({
    frameWindowId: "198130",
    windows: [WHATSAPP_FRAME, userChrome],
    // chrome's parent is explorer (7788), which is not the WhatsApp frame.
    parentOf: new Map([[13444, 7788], [21256, 4]])
  });
  assert.equal(picked, null);
});

// FOUND BY SURVEYING A REAL DESKTOP, not by thinking about it. The desktop
// window has an empty tree by nature — which is exactly the condition that
// starts this search — covers the whole screen, and every window the user
// launched from Explorer descends from it. It adopted the user's Chrome, so a
// reading of the desktop would have been answered with their open tab.
test("the desktop does not adopt the browser the user launched from it", () => {
  const programManager = {
    Id: 7788, ProcessName: "explorer", MainWindowTitle: "Program Manager",
    WindowHandle: 65552, ClassName: "Progman",
    Bounds: { x: 0, y: 0, width: 2880, height: 1704 }
  };
  const userChrome = {
    Id: 13444, ProcessName: "chrome", MainWindowTitle: "Baseten - Google Chrome",
    WindowHandle: 700200, ClassName: "Chrome_WidgetWin_1",
    Bounds: { x: 0, y: 0, width: 2880, height: 1704 }
  };
  const picked = pickWebviewWindow({
    frameWindowId: "65552",
    windows: [programManager, userChrome],
    parentOf: new Map([[13444, 7788]])
  });
  assert.equal(picked, null);
});

// Two independent reasons, so removing either still fails the test above.
test("a browser is never anybody's embedded content, whatever launched it", () => {
  const app = {
    Id: 900, ProcessName: "SomeApp", MainWindowTitle: "SomeApp",
    WindowHandle: 900900, ClassName: "SomeAppClass",
    Bounds: { x: 0, y: 0, width: 1000, height: 800 }
  };
  const spawnedBrowser = {
    Id: 901, ProcessName: "AvastBrowser", MainWindowTitle: "Google Flights",
    WindowHandle: 901901, ClassName: "Chrome_WidgetWin_1",
    Bounds: { x: 0, y: 0, width: 1000, height: 800 }
  };
  const picked = pickWebviewWindow({
    frameWindowId: "900900",
    windows: [app, spawnedBrowser],
    parentOf: new Map([[901, 900]])
  });
  assert.equal(picked, null, "an application that opens a browser has not moved its interface into it");
});

test("a helper window too small to be the interface is not chosen", () => {
  const tooSmall = {
    ...WHATSAPP_CONTENT, WindowHandle: 197999,
    Bounds: { x: 0, y: 0, width: 200, height: 60 }
  };
  const picked = pickWebviewWindow({
    frameWindowId: "198130",
    windows: [WHATSAPP_FRAME, tooSmall],
    parentOf: WHATSAPP_PARENTS
  });
  assert.equal(picked, null);
});

// ONE PROCESS HOSTS EVERY WINDOW AN APPLICATION OPENS. A second WhatsApp window
// puts two content windows under the same parent process, both of them
// genuinely that application's, and "the largest" then reads whichever
// conversation happens to be bigger. On a machine where the user only ever opens
// one window that rule looks perfect.
test("with two windows of one application, each frame reads its own", () => {
  const secondFrame = {
    ...WHATSAPP_FRAME, WindowHandle: 198999,
    Bounds: { x: 3000, y: 100, width: 1200, height: 900 }
  };
  const secondContent = {
    ...WHATSAPP_CONTENT, WindowHandle: 197999,
    Bounds: { x: 3010, y: 110, width: 1180, height: 880 }
  };
  const windows = [WHATSAPP_FRAME, WHATSAPP_CONTENT, secondFrame, secondContent];
  // Both content windows belong to the same WhatsApp process, as they really do.
  const parents = new Map([[23468, 21256], [21256, 4]]);

  assert.equal(
    pickWebviewWindow({ frameWindowId: "198130", windows, parentOf: parents })?.windowId,
    "197286",
    "the big frame must not be given the small window's content"
  );
  assert.equal(
    pickWebviewWindow({ frameWindowId: "198999", windows, parentOf: parents })?.windowId,
    "197999",
    "the small frame must get the content sitting on it, not the larger one elsewhere"
  );
});

test("with several content views on one frame the largest is the interface", () => {
  const smallerView = {
    ...WHATSAPP_CONTENT, WindowHandle: 197400,
    Bounds: { x: 0, y: 0, width: 2000, height: 1400 }
  };
  const picked = pickWebviewWindow({
    frameWindowId: "198130",
    windows: [WHATSAPP_FRAME, smallerView, WHATSAPP_CONTENT],
    parentOf: new Map([...WHATSAPP_PARENTS, [23468, 21256]])
  });
  assert.equal(picked?.windowId, "197286");
});

test("a grandchild process still counts as the application's own", () => {
  const throughBroker = { ...WHATSAPP_CONTENT, Id: 99001 };
  const picked = pickWebviewWindow({
    frameWindowId: "198130",
    windows: [WHATSAPP_FRAME, throughBroker],
    parentOf: new Map([[99001, 55000], [55000, 21256], [21256, 4]])
  });
  assert.equal(picked?.windowId, "197286");
});

// A parent map can name a process its own ancestor after a pid is recycled.
// Without the depth bound and the seen-set this walks forever, inside a screen
// reading, with the user waiting.
test("a process tree that loops does not hang the walk", () => {
  assert.equal(descendsFrom(10, 99, new Map([[10, 20], [20, 10]])), false);
  assert.equal(descendsFrom(10, 10, new Map()), true);
  assert.equal(descendsFrom(10, 99, new Map([[10, 0]])), false);
});

test("both shapes of the window list read the same", () => {
  const fromHost = normalizeWindow({ windowId: "197286", processId: 23468, processName: "msedgewebview2", title: "x", className: "Chrome_WidgetWin_1", bounds: { x: 0, y: 0, width: 10, height: 10 } });
  const fromFallback = normalizeWindow(WHATSAPP_CONTENT);
  assert.equal(fromHost.windowId, fromFallback.windowId);
  assert.equal(fromHost.processId, fromFallback.processId);
  assert.equal(fromHost.className, fromFallback.className);
});

// ---------------------------------------------------------------------------
// The launch flag.
// ---------------------------------------------------------------------------

test("an Electron application is started so that it can be read", () => {
  // VS Code measured 4 elements without this flag and 157 with it.
  assert.deepEqual(
    accessibilityLaunchArgs({ application: "code", target: "C:\\...\\Code.exe", kind: "command" }),
    [ACCESSIBILITY_LAUNCH_FLAG]
  );
  assert.deepEqual(
    accessibilityLaunchArgs({ application: "Visual Studio Code", target: "C:\\Program Files\\Microsoft VS Code\\Code.exe", kind: "app-path" }),
    [ACCESSIBILITY_LAUNCH_FLAG],
    "the executable name decides when the spoken name does not match"
  );
});

// A Chromium switch handed to a program that parses its arguments strictly can
// stop it starting. A perception improvement that prevents an application
// launching is not a trade worth making silently.
test("an unknown program is started exactly as it was before", () => {
  assert.deepEqual(accessibilityLaunchArgs({ application: "notepad", target: "notepad.exe", kind: "command" }), []);
  assert.deepEqual(accessibilityLaunchArgs({ application: "some-vendor-tool", target: "tool.exe", kind: "command" }), []);
});

// A packaged application is activated through the shell by AppUserModelId and
// never sees an argument list. WhatsApp is one — and needs no flag anyway, being
// WebView2, which publishes its tree unasked.
test("a packaged application is not offered arguments it cannot receive", () => {
  assert.deepEqual(
    accessibilityLaunchArgs({ application: "whatsapp desktop", target: "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App", kind: "start-menu" }),
    []
  );
});
