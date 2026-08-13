$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

Add-Type -ReferencedAssemblies @("System.Drawing","Accessibility") -TypeDefinition @'
using System;
using Accessibility;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class M4Window {
  public long windowId;
  public uint processId;
  public string title;
  public string className;
  public int x;
  public int y;
  public int width;
  public int height;
  public bool foreground;
}

// WHAT AN INPUT OPERATION ACTUALLY DID.
//
// `requested` and `injected` are separate numbers on purpose. SendInput returns
// how many events the system accepted, and it accepts fewer than it was given
// when something blocked them — a target window running at a higher integrity
// level than this process, or another process holding an input lock. Every
// automation tool that reports "clicked" without comparing these two is
// reporting that it made the call, not that the click happened. Carrying both
// out to the caller is what lets a blocked action be named as blocked.
public sealed class M4StrokeResult {
  public int points;
  public int requested;
  public int injected;
  public int endX;
  public int endY;
  public bool exactStart;
  public bool exactEnd;
  public bool pressed;
  public bool released;
  public double durationMs;
}

public static class M4Native {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hgt, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("oleacc.dll")]
  static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid,
    [In, Out, MarshalAs(UnmanagedType.IUnknown)] ref object accessible);

  // ------------------------------------------------------------------------
  // SYNTHETIC INPUT
  //
  // mouse_event and keybd_event are the 1996 API. Microsoft documents both as
  // superseded, and SendInput is not a cosmetic replacement for them:
  //
  //  * IT REPORTS WHAT IT DELIVERED. mouse_event returns void, so input that
  //    the system refused — blocked by UIPI because the target window belongs
  //    to a higher-integrity process, or dropped because another process holds
  //    a foreground lock — is indistinguishable from input that landed. That is
  //    exactly the failure this codebase keeps finding: the action reports
  //    success and nothing happened. SendInput returns the number of events it
  //    actually inserted, so "blocked" becomes a fact instead of a guess.
  //
  //  * ITS EVENTS CANNOT BE SPLIT BY REAL INPUT. The whole array enters the
  //    queue as one unit, so a person who moves the mouse mid-stroke cannot
  //    land a physical move between our button-down and our first move.
  //
  //  * MOUSEEVENTF_MOVE_NOCOALESCE asks the system not to merge consecutive
  //    moves. Coalescing is precisely what turns a carefully spaced curve back
  //    into a straight line — the application's message loop is handed one
  //    WM_MOUSEMOVE carrying the final position rather than the fifty positions
  //    along the way, and it draws what it was told: a chord.
  //
  //  * A WHOLE PATH CAN TRAVEL IN ONE CALL, so a stroke is one syscall rather
  //    than one syscall plus one interpreter round trip per point.
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  // The union really is a union: the two members overlap, which is why this is
  // Explicit. Left Sequential, every INPUT would be the wrong size and SendInput
  // would reject the whole array with ERROR_INVALID_PARAMETER.
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("winmm.dll", EntryPoint="timeBeginPeriod")] static extern uint TimeBeginPeriod(uint ms);
  [DllImport("winmm.dll", EntryPoint="timeEndPeriod")] static extern uint TimeEndPeriod(uint ms);

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_XDOWN = 0x0080, MOUSEEVENTF_XUP = 0x0100;
  const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
  const uint MOUSEEVENTF_MOVE_NOCOALESCE = 0x2000, MOUSEEVENTF_VIRTUALDESK = 0x4000, MOUSEEVENTF_ABSOLUTE = 0x8000;
  const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_SCANCODE = 0x0008;
  const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
  static readonly int InputSize = Marshal.SizeOf(typeof(INPUT));

  // The virtual desktop, cached for the duration of one operation. Absolute
  // positioning needs all four metrics for every point; asking the OS 24000
  // times to draw one circle is measurable and the answer cannot change
  // mid-stroke.
  static int vsx, vsy, vsw, vsh;
  static void RefreshVirtualScreen() {
    vsx = GetSystemMetrics(SM_XVIRTUALSCREEN);
    vsy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    vsw = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
    vsh = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
  }

  static INPUT MouseEventInput(uint flags, int x, int y, uint data) {
    var input = new INPUT();
    input.type = INPUT_MOUSE;
    input.u.mi.dx = x;
    input.u.mi.dy = y;
    input.u.mi.mouseData = data;
    input.u.mi.dwFlags = flags;
    input.u.mi.time = 0;
    input.u.mi.dwExtraInfo = IntPtr.Zero;
    return input;
  }

  // A screen point in SendInput's absolute space: the virtual desktop mapped
  // onto 0..65535 on each axis. MOUSEEVENTF_VIRTUALDESK is what makes the
  // origin the virtual desktop rather than the primary monitor, which is the
  // difference between working and not working on a second monitor placed left
  // of or above the first — there, screen coordinates are NEGATIVE.
  static INPUT MoveInput(int x, int y) {
    var nx = (int)Math.Round((double)(x - vsx) * 65535.0 / Math.Max(1, vsw - 1));
    var ny = (int)Math.Round((double)(y - vsy) * 65535.0 / Math.Max(1, vsh - 1));
    if (nx < 0) nx = 0; if (nx > 65535) nx = 65535;
    if (ny < 0) ny = 0; if (ny > 65535) ny = 65535;
    return MouseEventInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE_NOCOALESCE, nx, ny, 0);
  }

  static int Send(INPUT[] inputs) {
    if (inputs == null || inputs.Length == 0) return 0;
    return (int)SendInput((uint)inputs.Length, inputs, InputSize);
  }

  static int SendOne(INPUT input) { return Send(new INPUT[] { input }); }

  /**
   * Wait for a stated number of microseconds, accurately.
   *
   * Thread.Sleep(1) does not sleep for a millisecond; it yields until the next
   * scheduler tick, which is 15.6ms by default. A stroke paced with it would
   * run thirteen times slower than asked and would jitter, and pacing is the
   * one thing a drawing tool cannot get wrong. So: raise the timer resolution
   * for the duration of the operation, sleep away the bulk of a long wait, and
   * spin the last two milliseconds where sleeping cannot be trusted.
   */
  static void PreciseWait(long micros) {
    if (micros <= 0) return;
    var target = (long)(micros * (Stopwatch.Frequency / 1000000.0));
    var clock = Stopwatch.StartNew();
    while (true) {
      var remaining = target - clock.ElapsedTicks;
      if (remaining <= 0) return;
      if (remaining * 1000.0 / Stopwatch.Frequency > 2.0) Thread.Sleep(1);
      else Thread.SpinWait(50);
    }
  }

  static void BeginPrecision() { try { TimeBeginPeriod(1); } catch {} }
  static void EndPrecision() { try { TimeEndPeriod(1); } catch {} }

  static void ButtonFlags(string button, out uint down, out uint up, out uint data) {
    var name = (button == null ? "left" : button.ToLowerInvariant());
    switch (name) {
      case "right":  down = MOUSEEVENTF_RIGHTDOWN;  up = MOUSEEVENTF_RIGHTUP;  data = 0; break;
      case "middle": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; data = 0; break;
      case "x1":     down = MOUSEEVENTF_XDOWN;      up = MOUSEEVENTF_XUP;      data = 1; break;
      case "x2":     down = MOUSEEVENTF_XDOWN;      up = MOUSEEVENTF_XUP;      data = 2; break;
      case "none":   down = 0;                      up = 0;                    data = 0; break;
      default:       down = MOUSEEVENTF_LEFTDOWN;   up = MOUSEEVENTF_LEFTUP;   data = 0; break;
    }
  }

  /**
   * Put the pointer exactly on a pixel, and say whether it got there.
   *
   * Absolute SendInput coordinates are a 16-bit fraction of the virtual
   * desktop, so on a wide desktop one unit is worth more than one pixel and the
   * position that arrives can be a pixel off the position that was asked for.
   * Every automation library has this wart and none of them check for it. The
   * cursor's real position is one call away: read it back, and nudge with
   * SetCursorPos when the rounding lost a pixel. Endpoints are where this
   * matters — a click, and the two ends of a stroke.
   */
  public static bool MoveExact(int x, int y, out int achievedX, out int achievedY) {
    RefreshVirtualScreen();
    SendOne(MoveInput(x, y));
    POINT position;
    GetCursorPos(out position);
    if (position.x != x || position.y != y) {
      SetCursorPos(x, y);
      GetCursorPos(out position);
    }
    achievedX = position.x;
    achievedY = position.y;
    return position.x == x && position.y == y;
  }

  /**
   * Insert points until no two consecutive positions are more than `maxStep`
   * apart.
   *
   * An application draws a straight segment between the positions it is told
   * about. Given only two endpoints it draws one straight line, however curved
   * the intent — so the density of the path, not the shape of it, is what makes
   * a drawn curve a curve. Callers that already spaced their own path pass
   * maxStep <= 0 and this is skipped.
   */
  public static int[] Densify(int[] path, double maxStep) {
    if (path == null || path.Length < 4 || maxStep <= 0) return path;
    var output = new List<int>(path.Length * 2);
    output.Add(path[0]); output.Add(path[1]);
    for (var index = 2; index + 1 < path.Length; index += 2) {
      double fromX = path[index - 2], fromY = path[index - 1];
      double toX = path[index], toY = path[index + 1];
      var span = Math.Sqrt((toX - fromX) * (toX - fromX) + (toY - fromY) * (toY - fromY));
      var steps = Math.Max(1, (int)Math.Ceiling(span / maxStep));
      for (var n = 1; n <= steps; n += 1) {
        var x = (int)Math.Round(fromX + (toX - fromX) * n / steps);
        var y = (int)Math.Round(fromY + (toY - fromY) * n / steps);
        if (output[output.Count - 2] == x && output[output.Count - 1] == y) continue;
        output.Add(x); output.Add(y);
      }
    }
    return output.ToArray();
  }

  /**
   * A path carried as raw bytes rather than as a JSON array.
   *
   * Measured on this machine, handing a path in as JSON costs about 0.12ms per
   * point before a single event is sent — ConvertFrom-Json boxes every number
   * into a PSObject, and a detailed figure is thousands of numbers. That is a
   * fifth of the whole cost of drawing a circle spent on parsing the circle.
   * Little-endian Int32 pairs in base64 decode with one block copy, so the same
   * path arrives in microseconds and a very long one stops being expensive to
   * describe at all.
   */
  public static int[] DecodePath(string encoded) {
    if (String.IsNullOrEmpty(encoded)) return new int[0];
    var bytes = Convert.FromBase64String(encoded);
    var values = new int[bytes.Length / 4];
    Buffer.BlockCopy(bytes, 0, values, 0, values.Length * 4);
    return values;
  }

  /**
   * One continuous stroke: position, press, follow the path, release.
   *
   * `pacingMicros` is the gap between injected positions. Zero means "deliver
   * the whole path in a single SendInput call", which is right for a selection
   * or for throwing a window across the desktop and wrong for drawing: an
   * application that samples the mouse from its message loop sees a batch as
   * one jump. A pacing of about a millisecond is the drawing default, and it
   * corresponds to a real hand moving fast.
   *
   * The release is in a finally block. A stroke that throws or is abandoned
   * halfway with the button still down leaves the machine with a mouse button
   * physically stuck — selecting everything the pointer passes over, in the
   * user's own session, with no obvious way to clear it.
   */
  public static M4StrokeResult Stroke(int[] path, string button, int pacingMicros, int settleMicros, int batchPoints, bool press, bool release) {
    if (path == null || path.Length < 4) throw new ArgumentException("A stroke needs at least two points.");
    var result = new M4StrokeResult();
    result.points = path.Length / 2;
    uint down, up, data;
    ButtonFlags(button, out down, out up, out data);
    var clock = Stopwatch.StartNew();
    var pressed = false;
    BeginPrecision();
    try {
      int achievedX, achievedY;
      result.exactStart = MoveExact(path[0], path[1], out achievedX, out achievedY);
      result.requested += 1;
      result.injected += 1;
      PreciseWait(settleMicros);

      if (press && down != 0) {
        result.requested += 1;
        result.injected += SendOne(MouseEventInput(down, 0, 0, data));
        pressed = true;
        result.pressed = true;
        // A press and an immediate move in the same instant is how an
        // application concludes the click was a click and not the start of a
        // drag. The settle is short and it is what makes the first millimetre
        // of the stroke arrive.
        PreciseWait(settleMicros);
      }

      if (pacingMicros <= 0) {
        var batch = new INPUT[result.points - 1];
        for (var index = 1; index < result.points; index += 1) batch[index - 1] = MoveInput(path[index * 2], path[index * 2 + 1]);
        result.requested += batch.Length;
        result.injected += Send(batch);
      } else {
        // MOVES GO IN SMALL GROUPS, NOT ONE AT A TIME.
        //
        // Measured here: a SendInput call carrying one move costs about 0.85ms,
        // and a call carrying many costs about 0.15ms per move on top of the
        // same fixed overhead. The expensive part is the call, not the event —
        // so delivering a path one position per call spends five sixths of the
        // time on syscall overhead, and a stroke can never go faster than about
        // a thousand points a second however short its pacing.
        //
        // A group is still every position, in order, uncoalesced: an
        // application draining its message queue receives exactly the same
        // sequence of WM_MOUSEMOVEs. Only the arrival pattern changes, from a
        // steady trickle to small bursts, and the group is sized by the CALLER'S
        // PACING so that a burst stays a few milliseconds — comfortably inside
        // one frame, so nothing that redraws on a timer can miss the motion.
        var group = Math.Max(1, Math.Min(64, batchPoints));
        var index = 1;
        while (index < result.points) {
          var size = Math.Min(group, result.points - index);
          var batch = new INPUT[size];
          for (var n = 0; n < size; n += 1) batch[n] = MoveInput(path[(index + n) * 2], path[(index + n) * 2 + 1]);
          result.requested += size;
          result.injected += Send(batch);
          index += size;
          PreciseWait((long)pacingMicros * size);
        }
      }

      // The far end is a real coordinate the caller chose, so it gets the same
      // exactness the near end got.
      result.exactEnd = MoveExact(path[path.Length - 2], path[path.Length - 1], out achievedX, out achievedY);
      result.endX = achievedX;
      result.endY = achievedY;
    } finally {
      if (pressed && release && up != 0) {
        PreciseWait(settleMicros);
        result.requested += 1;
        result.injected += Send(new INPUT[] { MouseEventInput(up, 0, 0, data) });
        result.released = true;
      }
      EndPrecision();
      result.durationMs = clock.Elapsed.TotalMilliseconds;
    }
    return result;
  }

  /** Press or release a button where the pointer already is, with no motion. */
  public static M4StrokeResult ButtonAction(string button, bool down) {
    uint downFlag, upFlag, data;
    ButtonFlags(button, out downFlag, out upFlag, out data);
    var flag = down ? downFlag : upFlag;
    var result = new M4StrokeResult();
    if (flag == 0) return result;
    result.requested = 1;
    result.injected = Send(new INPUT[] { MouseEventInput(flag, 0, 0, data) });
    result.pressed = down;
    result.released = !down;
    POINT position;
    GetCursorPos(out position);
    result.endX = position.x;
    result.endY = position.y;
    return result;
  }

  /**
   * A click, or a double click, delivered with the timing the OS actually asks
   * for.
   *
   * A double click is two clicks inside GetDoubleClickTime, and the usual way
   * of building one — call a click helper twice — leaves whatever delay the
   * caller's loop happens to have between them. When that exceeds the system
   * setting the application receives two single clicks: the file gets selected
   * twice instead of opening, and nothing reports a problem.
   */
  public static M4StrokeResult Click(int x, int y, string button, int clicks, int settleMicros) {
    uint down, up, data;
    ButtonFlags(button, out down, out up, out data);
    var result = new M4StrokeResult();
    var count = Math.Max(1, Math.Min(3, clicks));
    var clock = Stopwatch.StartNew();
    // Comfortably inside the system's threshold, and long enough that the
    // press and release are not collapsed into one another.
    var gap = Math.Max(1000, Math.Min(60000, (int)GetDoubleClickTime() * 100));
    BeginPrecision();
    try {
      int achievedX, achievedY;
      result.exactStart = MoveExact(x, y, out achievedX, out achievedY);
      result.endX = achievedX;
      result.endY = achievedY;
      result.requested += 1;
      result.injected += 1;
      PreciseWait(settleMicros);
      for (var index = 0; index < count; index += 1) {
        if (index > 0) PreciseWait(gap);
        result.requested += 2;
        result.injected += Send(new INPUT[] {
          MouseEventInput(down, 0, 0, data),
          MouseEventInput(up, 0, 0, data)
        });
      }
      result.points = count;
      result.pressed = true;
      result.released = true;
    } finally {
      EndPrecision();
      result.durationMs = clock.Elapsed.TotalMilliseconds;
    }
    return result;
  }

  /**
   * The wheel.
   *
   * mouseData is declared unsigned and a scroll down is a NEGATIVE delta, so
   * the value has to be reinterpreted rather than converted. In C# `unchecked`
   * says exactly that in one word; the same cast written in PowerShell is
   * checked and throws, which is how downward scrolling was once impossible.
   */
  public static M4StrokeResult Wheel(int delta, bool horizontal) {
    var result = new M4StrokeResult();
    result.requested = 1;
    result.injected = Send(new INPUT[] {
      MouseEventInput(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)delta))
    });
    POINT position;
    GetCursorPos(out position);
    result.endX = position.x;
    result.endY = position.y;
    return result;
  }

  static INPUT KeyInput(ushort virtualKey, ushort scan, uint flags) {
    var input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = virtualKey;
    input.u.ki.wScan = scan;
    input.u.ki.dwFlags = flags;
    input.u.ki.time = 0;
    input.u.ki.dwExtraInfo = IntPtr.Zero;
    return input;
  }

  // Keys that must carry KEYEVENTF_EXTENDEDKEY. Without it the arrow keys are
  // the numeric keypad's arrows, Home is keypad 7, and Delete is keypad full
  // stop — which is why synthetic Ctrl+Right sometimes moves by a character
  // instead of a word, or types a digit.
  static bool IsExtended(ushort vk) {
    return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 // PgUp PgDn End Home
      || vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28   // arrows
      || vk == 0x2D || vk == 0x2E                               // Insert Delete
      || vk == 0x5B || vk == 0x5C || vk == 0x5D                 // Win keys, Apps
      || vk == 0xA3 || vk == 0xA5 || vk == 0x90 || vk == 0x6F;  // RCtrl RAlt NumLock keypad-divide
  }

  /**
   * Type text as the characters it is, not as keystrokes that might produce
   * them.
   *
   * KEYEVENTF_UNICODE carries a UTF-16 code unit directly, so what arrives is
   * what was sent: braces, quotes, accents, emoji, every symbol a keyboard
   * layout would otherwise have to be able to reach. SendKeys cannot say that —
   * it interprets a keystroke language, so `{` and `+` and `%` and `^` mean
   * something else and text that contains them arrives changed.
   *
   * Newlines are the one exception, and they are deliberate: a Unicode carriage
   * return is not what an edit control listens for, so Enter is sent as the key
   * it really is.
   */
  public static M4StrokeResult TypeUnicode(string text, int pacingMicros) {
    var result = new M4StrokeResult();
    if (String.IsNullOrEmpty(text)) return result;
    var clock = Stopwatch.StartNew();
    var events = new List<INPUT>(text.Length * 2);
    for (var index = 0; index < text.Length; index += 1) {
      var ch = text[index];
      if (ch == '\r') {
        // A CRLF is one Enter, not two.
        if (index + 1 < text.Length && text[index + 1] == '\n') index += 1;
        events.Add(KeyInput(0x0D, (ushort)MapVirtualKey(0x0D, 0), 0));
        events.Add(KeyInput(0x0D, (ushort)MapVirtualKey(0x0D, 0), KEYEVENTF_KEYUP));
        continue;
      }
      if (ch == '\n') {
        events.Add(KeyInput(0x0D, (ushort)MapVirtualKey(0x0D, 0), 0));
        events.Add(KeyInput(0x0D, (ushort)MapVirtualKey(0x0D, 0), KEYEVENTF_KEYUP));
        continue;
      }
      events.Add(KeyInput(0, ch, KEYEVENTF_UNICODE));
      events.Add(KeyInput(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    result.points = text.Length;
    BeginPrecision();
    try {
      if (pacingMicros <= 0) {
        // One call for the whole string. A window's message loop drains its
        // queue in order, so a batch is not a race; it is the reason this can
        // deliver a paragraph in the time a per-character loop spends on one
        // letter. Chunked so a very long document does not build one enormous
        // array.
        var chunk = 512;
        for (var start = 0; start < events.Count; start += chunk) {
          var size = Math.Min(chunk, events.Count - start);
          var batch = new INPUT[size];
          events.CopyTo(start, batch, 0, size);
          result.requested += size;
          result.injected += Send(batch);
        }
      } else {
        for (var index = 0; index < events.Count; index += 2) {
          var pair = new INPUT[] { events[index], events[index + 1] };
          result.requested += 2;
          result.injected += Send(pair);
          PreciseWait(pacingMicros);
        }
      }
    } finally {
      EndPrecision();
      result.durationMs = clock.Elapsed.TotalMilliseconds;
    }
    return result;
  }

  static ushort NamedKey(string name) {
    switch (name) {
      case "enter": case "return": return 0x0D;
      case "tab": return 0x09;
      case "esc": case "escape": return 0x1B;
      case "space": case "spacebar": return 0x20;
      case "backspace": case "bksp": return 0x08;
      case "delete": case "del": return 0x2E;
      case "insert": case "ins": return 0x2D;
      case "home": return 0x24;
      case "end": return 0x23;
      case "pageup": case "pgup": return 0x21;
      case "pagedown": case "pgdn": return 0x22;
      case "up": return 0x26;
      case "down": return 0x28;
      case "left": return 0x25;
      case "right": return 0x27;
      case "printscreen": case "prtsc": return 0x2C;
      case "capslock": return 0x14;
      case "numlock": return 0x90;
      case "scrolllock": return 0x91;
      case "pause": case "break": return 0x13;
      case "apps": case "menu": return 0x5D;
      case "win": case "lwin": return 0x5B;
      case "rwin": return 0x5C;
      case "ctrl": case "control": case "ctl": return 0x11;
      case "alt": return 0x12;
      case "shift": return 0x10;
      case "volumeup": return 0xAF;
      case "volumedown": return 0xAE;
      case "volumemute": return 0xAD;
      case "medianext": return 0xB0;
      case "mediaprevious": return 0xB1;
      case "mediastop": return 0xB2;
      case "mediaplaypause": return 0xB3;
      default: break;
    }
    if (name.Length > 1 && name[0] == 'f') {
      int number;
      if (Int32.TryParse(name.Substring(1), out number) && number >= 1 && number <= 24) return (ushort)(0x6F + number);
    }
    if (name.Length == 1) {
      var scan = VkKeyScan(name[0]);
      if (scan != -1) return (ushort)(scan & 0xFF);
    }
    return 0;
  }

  /**
   * A key or a combination, held and released in the right order.
   *
   * "ctrl+shift+s" means: hold Ctrl, hold Shift, tap S, release Shift, release
   * Ctrl. Releasing in the same order they were pressed leaves a modifier
   * logically down for an instant with the other already up, and applications
   * that watch modifier state — every editor with a multi-select — see a
   * different gesture than the one that was asked for.
   *
   * A modifier that a keyboard layout requires for the final character is
   * applied too: on a US layout `%` is Shift+5, and sending the 5 key without
   * the shift produces a 5.
   */
  public static M4StrokeResult Chord(string spec) {
    var result = new M4StrokeResult();
    if (String.IsNullOrWhiteSpace(spec)) return result;
    var parts = spec.Trim().ToLowerInvariant().Split('+');
    var held = new List<ushort>();
    ushort target = 0;
    for (var index = 0; index < parts.Length; index += 1) {
      var part = parts[index].Trim();
      if (part.Length == 0) {
        // A lone "+" written as part of a combination, e.g. "ctrl++".
        part = "+";
      }
      var isLast = index == parts.Length - 1;
      if (!isLast) {
        var modifier = NamedKey(part);
        if (modifier == 0) throw new ArgumentException("Unknown modifier: " + part);
        held.Add(modifier);
        continue;
      }
      target = NamedKey(part);
      if (target == 0) throw new ArgumentException("Unknown key: " + part);
      if (part.Length == 1) {
        var scan = VkKeyScan(part[0]);
        if (scan != -1) {
          var state = (scan >> 8) & 0xFF;
          if ((state & 1) != 0 && !held.Contains((ushort)0x10)) held.Add(0x10);
          if ((state & 2) != 0 && !held.Contains((ushort)0x11)) held.Add(0x11);
          if ((state & 4) != 0 && !held.Contains((ushort)0x12)) held.Add(0x12);
        }
      }
    }
    var events = new List<INPUT>();
    for (var index = 0; index < held.Count; index += 1) {
      events.Add(KeyInput(held[index], (ushort)MapVirtualKey(held[index], 0), IsExtended(held[index]) ? KEYEVENTF_EXTENDEDKEY : 0));
    }
    events.Add(KeyInput(target, (ushort)MapVirtualKey(target, 0), IsExtended(target) ? KEYEVENTF_EXTENDEDKEY : 0));
    events.Add(KeyInput(target, (ushort)MapVirtualKey(target, 0), KEYEVENTF_KEYUP | (IsExtended(target) ? KEYEVENTF_EXTENDEDKEY : 0)));
    for (var index = held.Count - 1; index >= 0; index -= 1) {
      events.Add(KeyInput(held[index], (ushort)MapVirtualKey(held[index], 0), KEYEVENTF_KEYUP | (IsExtended(held[index]) ? KEYEVENTF_EXTENDEDKEY : 0)));
    }
    result.requested = events.Count;
    result.injected = Send(events.ToArray());
    result.points = 1;
    return result;
  }

  public static List<M4Window> Windows() {
    var result = new List<M4Window>();
    var fg = GetForegroundWindow();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var title = new StringBuilder(GetWindowTextLength(h) + 1); GetWindowText(h, title, title.Capacity);
      var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
      RECT r; if (!GetWindowRect(h, out r)) return true;
      result.Add(new M4Window { windowId=h.ToInt64(), processId=pid, title=title.ToString(),
        className=cls.ToString(), x=r.Left, y=r.Top, width=r.Right-r.Left, height=r.Bottom-r.Top,
        foreground=h==fg });
      return true;
    }, IntPtr.Zero);
    return result;
  }

  /**
   * Ask for the strongest DPI awareness this Windows offers.
   *
   * SetProcessDPIAware alone declares SYSTEM awareness, which means: correct on
   * the monitor Windows booted with, and silently virtualised on any monitor
   * with a different scale factor. On a mixed-DPI desktop — a 150% laptop panel
   * beside a 100% external screen, which is the ordinary setup now — every
   * window rectangle read on the second monitor comes back scaled, so a click
   * computed from those bounds lands somewhere other than the control it was
   * aimed at, and a screen capture of that window is the wrong size.
   *
   * Per-Monitor-V2 removes the virtualisation: coordinates are physical pixels
   * everywhere, which is the space this host already assumes it is working in.
   * It needs Windows 10 1703, so the older call stays as the fallback and the
   * mode that was actually obtained is reported in host.health rather than
   * assumed.
   */
  public static string EnableDpiAwareness() {
    try {
      if (SetProcessDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return "per-monitor-v2";
    } catch {}
    try {
      if (SetProcessDPIAware()) return "system";
    } catch {}
    return "unaware";
  }
  public static uint DpiForWindow(IntPtr h) { try { var dpi=GetDpiForWindow(h); return dpi == 0 ? 96u : dpi; } catch { return 96u; } }
  public static bool Activate(IntPtr h) {
    if (!IsWindow(h)) return false;
    if (GetForegroundWindow() == h) return true;
    uint targetPid, foregroundPid;
    var targetThread = GetWindowThreadProcessId(h, out targetPid);
    var foreground = GetForegroundWindow();
    var foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
    var currentThread = GetCurrentThreadId();
    if (foregroundThread != 0 && foregroundThread != currentThread) AttachThreadInput(currentThread, foregroundThread, true);
    if (targetThread != 0 && targetThread != currentThread) AttachThreadInput(currentThread, targetThread, true);
    ShowWindow(h, 9);
    // A synthetic Alt transition grants this foreground process permission to
    // transfer focus under Windows' foreground-lock rules.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    BringWindowToTop(h);
    var ok = SetForegroundWindow(h);
    SetActiveWindow(h);
    SetFocus(h);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    if (targetThread != 0 && targetThread != currentThread) AttachThreadInput(currentThread, targetThread, false);
    if (foregroundThread != 0 && foregroundThread != currentThread) AttachThreadInput(currentThread, foregroundThread, false);
    return ok || GetForegroundWindow() == h;
  }

  public static bool IsForeground(IntPtr h) { return IsWindow(h) && GetForegroundWindow() == h; }

  [StructLayout(LayoutKind.Sequential)]
  struct NMHDR { public IntPtr hwndFrom; public UIntPtr idFrom; public int code; }

  public static bool AdvanceTab(IntPtr h) {
    if (!IsWindow(h)) return false;
    const uint TCM_GETITEMCOUNT = 0x1304, TCM_GETCURSEL = 0x130B, TCM_SETCURSEL = 0x130C, WM_NOTIFY = 0x004E;
    var count = SendMessage(h, TCM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt32();
    var current = SendMessage(h, TCM_GETCURSEL, IntPtr.Zero, IntPtr.Zero).ToInt32();
    if (count < 1) return false;
    var next = (Math.Max(0, current) + 1) % count;
    var parent = GetParent(h);
    var controlId = GetDlgCtrlID(h);
    var header = new NMHDR { hwndFrom = h, idFrom = new UIntPtr(unchecked((uint)controlId)), code = -552 };
    var memory = Marshal.AllocHGlobal(Marshal.SizeOf(header));
    try {
      Marshal.StructureToPtr(header, memory, false);
      if (parent != IntPtr.Zero) SendMessage(parent, WM_NOTIFY, new IntPtr(controlId), memory);
      SendMessage(h, TCM_SETCURSEL, new IntPtr(next), IntPtr.Zero);
      header.code = -551;
      Marshal.StructureToPtr(header, memory, true);
      if (parent != IntPtr.Zero) SendMessage(parent, WM_NOTIFY, new IntPtr(controlId), memory);
    } finally { Marshal.FreeHGlobal(memory); }
    return SendMessage(h, TCM_GETCURSEL, IntPtr.Zero, IntPtr.Zero).ToInt32() == next;
  }

  static IAccessible AccessibleClient(IntPtr h) {
    object value = null;
    var iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    var result = AccessibleObjectFromWindow(h, 0xFFFFFFFC, ref iid, ref value);
    return result == 0 ? value as IAccessible : null;
  }

  public static string[] AccessibleChildNames(IntPtr h) {
    var accessible = AccessibleClient(h);
    if (accessible == null) return new string[0];
    var names = new List<string>();
    try {
      for (var index = 1; index <= accessible.accChildCount; index++) {
        try {
          var name = accessible.get_accName(index);
          if (!String.IsNullOrWhiteSpace(name)) names.Add(name);
        } catch {}
      }
    } finally { if (Marshal.IsComObject(accessible)) Marshal.ReleaseComObject(accessible); }
    return names.ToArray();
  }

  public static bool SelectAccessibleChild(IntPtr h, string requestedName) {
    var accessible = AccessibleClient(h);
    if (accessible == null) return false;
    try {
      for (var index = 1; index <= accessible.accChildCount; index++) {
        string name = null;
        try { name = accessible.get_accName(index); } catch {}
        if (String.Equals(name, requestedName, StringComparison.OrdinalIgnoreCase)) {
          accessible.accSelect(0x3, index);
          try { accessible.accDoDefaultAction(index); } catch {}
          return true;
        }
      }
      return false;
    } finally { if (Marshal.IsComObject(accessible)) Marshal.ReleaseComObject(accessible); }
  }

  public static string Capture(int x, int y, int width, int height, string path) {
    if (width < 1 || height < 1 || width > 16384 || height > 16384) throw new ArgumentOutOfRangeException();
    using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
    using (var graphics = Graphics.FromImage(bitmap)) {
      graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
      bitmap.Save(path, ImageFormat.Png);
    }
    return path;
  }

  public static bool CaptureWindow(IntPtr h, string path) {
    RECT r; if (!IsWindow(h) || !GetWindowRect(h, out r)) return false;
    var width = r.Right-r.Left; var height = r.Bottom-r.Top;
    if (width < 1 || height < 1 || width > 16384 || height > 16384) return false;
    using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
    using (var graphics = Graphics.FromImage(bitmap)) {
      var hdc = graphics.GetHdc();
      bool ok;
      try { ok = PrintWindow(h, hdc, 2) || PrintWindow(h, hdc, 0); }
      finally { graphics.ReleaseHdc(hdc); }
      if (!ok) return false;
      var min = 255; var max = 0;
      for (var y=0; y<height; y+=Math.Max(1,height/8))
        for (var x=0; x<width; x+=Math.Max(1,width/8)) {
          var c=bitmap.GetPixel(x,y); var l=(c.R+c.G+c.B)/3;
          min=Math.Min(min,l); max=Math.Max(max,l);
        }
      if (max-min < 5) return false;
      bitmap.Save(path, ImageFormat.Png);
      return true;
    }
  }
}
'@
$script:DpiMode = [M4Native]::EnableDpiAwareness()

function Wait-WinRt($operation, $resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}

function Read-OcrImage($path, $windowId=$null, $originX=0, $originY=0) {
  [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] > $null
  [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] > $null
  [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime] > $null
  [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] > $null
  $file = Wait-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync([IO.Path]::GetFullPath($path))) ([Windows.Storage.StorageFile])
  $stream = Wait-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { return @{ available=$false; reason="windows-ocr-unavailable"; text=""; targets=@() } }
  $recognized = Wait-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $targets = @()
  foreach ($line in $recognized.Lines) {
    $words = @($line.Words)
    if ($words.Count -eq 0) { continue }
    $left = ($words | ForEach-Object {$_.BoundingRect.X} | Measure-Object -Minimum).Minimum
    $top = ($words | ForEach-Object {$_.BoundingRect.Y} | Measure-Object -Minimum).Minimum
    $right = ($words | ForEach-Object {$_.BoundingRect.X+$_.BoundingRect.Width} | Measure-Object -Maximum).Maximum
    $bottom = ($words | ForEach-Object {$_.BoundingRect.Y+$_.BoundingRect.Height} | Measure-Object -Maximum).Maximum
    $ocrWindowId = if($windowId){[string]$windowId}else{"screen"}
    $targets += [pscustomobject]@{
      targetId=[guid]::NewGuid().ToString();source="OCR";windowId=$ocrWindowId
      name=$line.Text;automationId=$null;controlType="Text"
      boundingRect=@{x=[int]($originX+$left);y=[int]($originY+$top);width=[int]($right-$left);height=[int]($bottom-$top)}
      relativeCoordinates=@{x=[int]$left;y=[int]$top}
      confidence=0.85;observedAt=[DateTime]::UtcNow.ToString("o");evidence=@{path=$path;text=$line.Text}
    }
  }
  return @{ available=$true; text=$recognized.Text; targets=$targets; path=$path }
}

function Get-WindowList {
  @([M4Native]::Windows() | ForEach-Object {
    $process = Get-Process -Id $_.processId -ErrorAction SilentlyContinue
    $handle = [IntPtr][Int64]$_.windowId
    $display = [System.Windows.Forms.Screen]::FromHandle($handle)
    [pscustomobject]@{
      windowId = [string]$_.windowId
      processId = $_.processId
      processName = if ($process) { $process.ProcessName } else { $null }
      title = $_.title
      className = $_.className
      bounds = @{ x=$_.x; y=$_.y; width=$_.width; height=$_.height }
      displayId = if($display){$display.DeviceName}else{$null}
      dpi = [int][M4Native]::DpiForWindow($handle)
      foreground = $_.foreground
    }
  })
}

# Just the window the user is looking at.
#
# Get-WindowList calls Get-Process, Screen.FromHandle and DpiForWindow once per
# window; on a normal desktop that is fifty-odd windows and a measured second of
# wall clock. Every look at the screen paid it purely to find out which window
# was in front, which the OS already knows. This asks that question directly.
function Get-ForegroundWindow {
  $handle = [M4Native]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) { return $null }
  $target = $handle.ToInt64()
  $found = @([M4Native]::Windows() | Where-Object { [Int64]$_.windowId -eq $target }) | Select-Object -First 1
  if (-not $found) { return $null }
  $process = Get-Process -Id $found.processId -ErrorAction SilentlyContinue
  $display = [System.Windows.Forms.Screen]::FromHandle($handle)
  [pscustomobject]@{
    windowId = [string]$found.windowId
    processId = $found.processId
    processName = if ($process) { $process.ProcessName } else { $null }
    title = $found.title
    className = $found.className
    bounds = @{ x=$found.x; y=$found.y; width=$found.width; height=$found.height }
    displayId = if($display){$display.DeviceName}else{$null}
    dpi = [int][M4Native]::DpiForWindow($handle)
    foreground = $true
  }
}

function Resolve-Window($params) {
  $windows = Get-WindowList
  if ($params.windowId) {
    $exact = $windows | Where-Object { $_.windowId -eq [string]$params.windowId } | Select-Object -First 1
    if (-not $exact) {
      return @{resolved=$false;window=$null;confidence=0;resolutionMethod="hwnd-missing";reason="TARGET_WINDOW_MISSING"}
    }
    $mismatches=@()
    if($params.processId -and [int64]$exact.processId -ne [int64]$params.processId){$mismatches+="processId"}
    if($params.processName -and -not $exact.processName.Equals([string]$params.processName,[StringComparison]::OrdinalIgnoreCase)){$mismatches+="processName"}
    if($params.className -and $exact.className -ne [string]$params.className){$mismatches+="className"}
    if($params.title -and $exact.title -ne [string]$params.title){$mismatches+="title"}
    if($mismatches.Count -gt 0){
      return @{resolved=$false;window=$exact;confidence=0;resolutionMethod="hwnd-identity-mismatch";reason="TARGET_IDENTITY_MISMATCH";mismatches=$mismatches}
    }
    return @{resolved=$true;window=$exact;confidence=1.0;resolutionMethod="hwnd"}
  }
  $candidates = @()
  foreach($window in $windows) {
    $score=0;$signals=@()
    if($params.processId -and [int64]$window.processId -eq [int64]$params.processId){$score+=45;$signals+="pid"}
    $processNeedle=if($params.processName){[string]$params.processName}elseif($params.executable){[IO.Path]::GetFileNameWithoutExtension([string]$params.executable)}else{$null}
    if($processNeedle -and $window.processName -and $window.processName.Equals($processNeedle,[StringComparison]::OrdinalIgnoreCase)){$score+=35;$signals+="process"}
    if($params.className -and $window.className -eq [string]$params.className){$score+=25;$signals+="class"}
    if($params.title -and $window.title -eq [string]$params.title){$score+=35;$signals+="title"}
    $partial=if($params.titleContains){[string]$params.titleContains}elseif($params.application){[string]$params.application}else{$null}
    if($partial -and (($window.title -and $window.title.IndexOf($partial,[StringComparison]::OrdinalIgnoreCase)-ge 0) -or ($window.processName -and $window.processName.IndexOf($partial,[StringComparison]::OrdinalIgnoreCase)-ge 0))){$score+=25;$signals+="partial"}
    if($window.foreground){$score+=3}
    if($score -gt 0){$candidates+=@{window=$window;score=$score;signals=$signals;area=([int64]$window.bounds.width*[int64]$window.bounds.height)}}
  }
  if(-not $params.windowId -and -not $params.processId -and -not $params.processName -and -not $params.executable -and -not $params.className -and -not $params.title -and -not $params.titleContains -and -not $params.application){
    $foreground=$windows|Where-Object foreground|Select-Object -First 1
    if($foreground){return @{resolved=$true;window=$foreground;confidence=1.0;resolutionMethod="foreground"}}
  }
  $best=$candidates|Sort-Object @{Expression={$_.score};Descending=$true},@{Expression={$_.area};Descending=$true}|Select-Object -First 1
  if(-not $best -or $best.score -lt 25){return @{resolved=$false;window=$null;confidence=0;resolutionMethod="none"}}
  return @{resolved=$true;window=$best.window;confidence=[Math]::Min(0.99,0.5+($best.score/100));resolutionMethod=($best.signals -join "+")}
}

function Select-Window($params) {
  return (Resolve-Window $params).window
}

function Acquire-Foreground($params) {
  $attempts=@()
  for($i=0;$i -lt 3;$i++){
    $resolved=Resolve-Window $params
    if(-not $resolved.resolved){return @{acquired=$false;reason="window-not-found";attempts=$attempts;resolution=$resolved}}
    $window=$resolved.window;$handle=[IntPtr][Int64]$window.windowId
    if([M4Native]::IsForeground($handle)){return @{acquired=$true;window=$window;attempts=$attempts;resolution=$resolved}}
    [M4Native]::ShowWindow($handle,9)|Out-Null
    $requested=[M4Native]::Activate($handle)
    if(-not [M4Native]::IsForeground($handle)){
      try{[System.Windows.Automation.AutomationElement]::FromHandle($handle).SetFocus()}catch{}
    }
    if(-not [M4Native]::IsForeground($handle)){
      try {
        $shell = New-Object -ComObject WScript.Shell
        $null = $shell.AppActivate([int]$window.processId)
      } catch {}
    }
    Start-Sleep -Milliseconds (80*($i+1))
    $verified=[M4Native]::IsForeground($handle)
    $attempts+=@{attempt=($i+1);windowId=$window.windowId;requested=$requested;verified=$verified;resolutionMethod=$resolved.resolutionMethod}
    if($verified){return @{acquired=$true;window=(Select-Window @{windowId=$window.windowId});attempts=$attempts;resolution=$resolved}}
  }
  return @{acquired=$false;reason="foreground-not-acquired";attempts=$attempts;resolution=(Resolve-Window $params)}
}

function Convert-Element($element, $windowId, $windowIdentity=$null) {
  $r = $element.Current.BoundingRectangle
  $validRect = -not [double]::IsInfinity($r.X) -and -not [double]::IsNaN($r.X) -and
    -not [double]::IsInfinity($r.Y) -and -not [double]::IsNaN($r.Y) -and
    -not [double]::IsInfinity($r.Width) -and -not [double]::IsNaN($r.Width)
  if(-not $validRect){$r=[System.Windows.Rect]::new(0,0,0,0)}
  $patterns = @()
  foreach ($pattern in @(
    [System.Windows.Automation.InvokePattern]::Pattern,
    [System.Windows.Automation.ValuePattern]::Pattern,
    [System.Windows.Automation.SelectionItemPattern]::Pattern,
    [System.Windows.Automation.ExpandCollapsePattern]::Pattern,
    [System.Windows.Automation.TogglePattern]::Pattern,
    [System.Windows.Automation.ScrollItemPattern]::Pattern
  )) { try { if ($element.TryGetCurrentPattern($pattern, [ref]$null)) { $patterns += $pattern.ProgrammaticName } } catch {} }
  $currentValue = try { $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { $null }
  $currentToggleState = try { $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState.ToString() } catch { $null }
  $currentExpandState = try { $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Current.ExpandCollapseState.ToString() } catch { $null }
  [pscustomobject]@{
    targetId = [guid]::NewGuid().ToString()
    source = "UIA"
    windowId = [string]$windowId
    automationId = $element.Current.AutomationId
    name = $element.Current.Name
    controlType = $element.Current.ControlType.ProgrammaticName
    className = $element.Current.ClassName
    nativeWindowHandle = $element.Current.NativeWindowHandle
    accessibleChildren = if($element.Current.NativeWindowHandle -ne 0 -and $element.Current.ClassName -match "(?i)TabControl"){
      @([M4Native]::AccessibleChildNames([IntPtr][Int64]$element.Current.NativeWindowHandle))
    }else{@()}
    boundingRect = @{ x=[int]$r.X; y=[int]$r.Y; width=[int]$r.Width; height=[int]$r.Height }
    enabled = $element.Current.IsEnabled
    focused = $element.Current.HasKeyboardFocus
    supportedPatterns = $patterns
    value = $currentValue
    toggleState = $currentToggleState
    expandCollapseState = $currentExpandState
    confidence = 0.95
    observedAt = [DateTime]::UtcNow.ToString("o")
    windowIdentity = if($windowIdentity){@{windowId=$windowIdentity.windowId;processId=$windowIdentity.processId;processName=$windowIdentity.processName;title=$windowIdentity.title;className=$windowIdentity.className}}else{$null}
  }
}

function Get-UiElements($params) {
  $window = Select-Window $params
  if (-not $window) { return @{ window=$null; targets=@() } }
  $requestedLimit = if ($null -ne $params.maxElements) { [int]$params.maxElements } else { 200 }
  $limit = [Math]::Min(1000, [Math]::Max(1, $requestedLimit))
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$window.windowId)
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $targets = @()
  foreach ($element in $all) {
    try {
      $r = $element.Current.BoundingRectangle
      $nativeNavigationContainer = $element.Current.NativeWindowHandle -ne 0 -and
        ($element.Current.ClassName -match '(?i)(TabControl|Toolbar|Menu|TreeView|ListView)')
      if (-not $element.Current.IsOffscreen -and $r.Width -gt 0 -and $r.Height -gt 0 -and
        ($element.Current.Name -or $element.Current.AutomationId -or $nativeNavigationContainer)) {
        $targets += Convert-Element $element $window.windowId $window
        if ($targets.Count -ge $limit) { break }
      }
    } catch {}
  }
  return @{ window=$window; targets=$targets }
}

function Find-UiElement($params) {
  $window = Select-Window $params
  if (-not $window) { return @{ found=$false; reason="window-not-found" } }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$window.windowId)
  $selector = if ($params.selector) { $params.selector } elseif ($params.target) { $params.target } else { $params }
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $hits = @()
  foreach ($element in $all) {
    try {
      $name = $element.Current.Name
      $r = $element.Current.BoundingRectangle
      $finite = -not [double]::IsInfinity($r.X) -and -not [double]::IsNaN($r.X) -and -not [double]::IsInfinity($r.Y) -and -not [double]::IsNaN($r.Y)
      $ok = -not $element.Current.IsOffscreen -and $element.Current.IsEnabled -and $finite
      if ($selector.automationId -and $element.Current.AutomationId -ne [string]$selector.automationId) { $ok=$false }
      if ($selector.name -and $name -ne [string]$selector.name) { $ok=$false }
      if ($selector.nameStartsWith -and -not $name.StartsWith([string]$selector.nameStartsWith, [StringComparison]::OrdinalIgnoreCase)) { $ok=$false }
      if ($selector.nameContains -and $name.IndexOf([string]$selector.nameContains, [StringComparison]::OrdinalIgnoreCase) -lt 0) { $ok=$false }
      if ($selector.controlType) {
        $expectedControlType = [string]$selector.controlType
        if (-not $expectedControlType.StartsWith("ControlType.", [StringComparison]::OrdinalIgnoreCase)) {
          $expectedControlType = "ControlType." + $expectedControlType
        }
        if (-not $element.Current.ControlType.ProgrammaticName.Equals($expectedControlType, [StringComparison]::OrdinalIgnoreCase)) { $ok=$false }
      }
      if ($selector.className -and $element.Current.ClassName -ne [string]$selector.className) { $ok=$false }
      if ($ok -and ($selector.withinName -or $selector.parentName)) {
        $ancestor = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($element)
        $inside = $false
        $ancestorNeedle = if($selector.withinName){[string]$selector.withinName}else{[string]$selector.parentName}
        for($depth=0;$depth -lt 10 -and $ancestor;$depth++){
          if($ancestor.Current.Name.IndexOf($ancestorNeedle,[StringComparison]::OrdinalIgnoreCase) -ge 0){$inside=$true;break}
          $ancestor=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor)
        }
        if(-not $inside){$ok=$false}
      }
      if ($ok -and $selector.relativeTo) {
        $anchorParams=@{windowId=$window.windowId;selector=$selector.relativeTo}
        $anchor=Find-UiElement $anchorParams
        if(-not $anchor.found){$ok=$false}else{
          $ar=$anchor.target.boundingRect
          $direction=[string]$selector.direction
          if($direction -eq "right" -and $r.X -lt ($ar.x+$ar.width)){$ok=$false}
          if($direction -eq "left" -and ($r.X+$r.Width) -gt $ar.x){$ok=$false}
          if($direction -eq "below" -and $r.Y -lt ($ar.y+$ar.height)){$ok=$false}
          if($direction -eq "above" -and ($r.Y+$r.Height) -gt $ar.y){$ok=$false}
        }
      }
      if ($ok) { $hits += ,$element }
    } catch {}
  }
  if ($hits.Count -eq 0) { return @{ found=$false; reason="target-not-found"; matchCount=0; window=$window } }
  $index = if ($null -ne $selector.occurrence) { [Math]::Max(0,[int]$selector.occurrence) } else { 0 }
  if ($index -ge $hits.Count) { return @{ found=$false; reason="occurrence-not-found"; matchCount=$hits.Count; window=$window } }
  return @{ found=$true; matchCount=$hits.Count; ambiguous=($hits.Count -gt 1 -and $null -eq $selector.occurrence); target=(Convert-Element $hits[$index] $window.windowId $window); window=$window }
}

function Invoke-UiAction($params) {
  $originalBounds = $params.target.boundingRect
  if($params.target.windowIdentity){
    foreach($field in @("processId","processName","title","className")){
      if(-not $params.$field -and $params.target.windowIdentity.$field){$params|Add-Member -NotePropertyName $field -NotePropertyValue $params.target.windowIdentity.$field -Force}
    }
  }
  $resolvedWindow = Resolve-Window $params
  if (-not $resolvedWindow.resolved) { return @{ performed=$false; reason=if($resolvedWindow.reason){$resolvedWindow.reason}else{"TARGET_WINDOW_MISSING"}; resolution=$resolvedWindow } }
  $params.windowId = $resolvedWindow.window.windowId
  $foreground = Acquire-Foreground $params
  if(-not $foreground.acquired){
    return @{performed=$false;reason=if($foreground.reason -eq "window-not-found"){"TARGET_WINDOW_MISSING"}else{"FOREGROUND_ACQUISITION_FAILED"};foreground=$foreground}
  }
  # Activation can change the accessible tree or expose a modal. Re-resolve the
  # exact HWND and identity before finding a fresh control for this one action.
  $resolvedWindow = Resolve-Window $params
  if(-not $resolvedWindow.resolved){return @{performed=$false;reason=if($resolvedWindow.reason){$resolvedWindow.reason}else{"TARGET_WINDOW_MISSING"};resolution=$resolvedWindow}}
  $found = $null
  for($groundAttempt=0;$groundAttempt -lt 3 -and (-not $found -or -not $found.found);$groundAttempt++){
    if($groundAttempt -gt 0){Start-Sleep -Milliseconds (120*$groundAttempt)}
    $found = Find-UiElement $params
  }
  if (-not $found.found) { return $found }
  if ($found.ambiguous -and -not $params.allowFirst) { return @{ performed=$false; reason="ambiguous-target"; matchCount=$found.matchCount; target=$found.target } }
  $window = Select-Window @{ windowId=$found.target.windowId }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$window.windowId)
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $hit = $null
  foreach ($el in $all) {
    try {
      if ($found.target.automationId -and $el.Current.AutomationId -eq $found.target.automationId -and $el.Current.Name -eq $found.target.name) { $hit=$el;break }
      if (-not $found.target.automationId -and $el.Current.Name -eq $found.target.name -and
        $el.Current.ControlType.ProgrammaticName -eq $found.target.controlType -and
        (-not $found.target.className -or $el.Current.ClassName -eq $found.target.className)) { $hit=$el;break }
    } catch {}
  }
  if (-not $hit) { return @{ performed=$false; reason="stale-target"; target=$found.target } }
  $currentBounds = $found.target.boundingRect
  $geometryChanged = [bool]($originalBounds -and $currentBounds -and (
    [int]$originalBounds.x -ne [int]$currentBounds.x -or
    [int]$originalBounds.y -ne [int]$currentBounds.y -or
    [int]$originalBounds.width -ne [int]$currentBounds.width -or
    [int]$originalBounds.height -ne [int]$currentBounds.height
  ))
  $action = [string]$params.action
  $method = $null
  try {
    switch ($action) {
      "invoke" { $hit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $method="InvokePattern" }
      "click" {
        try { $hit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $method="InvokePattern" }
        catch {
          $nativeHandle=[IntPtr][Int64]$hit.Current.NativeWindowHandle
          if($nativeHandle -ne [IntPtr]::Zero){
            [M4Native]::SendMessage($nativeHandle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null
            $method="BM_CLICK"
          } else {
            $foreground=Acquire-Foreground @{windowId=$window.windowId;processId=$window.processId;title=$window.title;className=$window.className}
            if(-not $foreground.acquired){return @{performed=$false;reason="foreground-not-acquired";target=$found.target;foreground=$foreground}}
            # The same click every other pointer action delivers. It used to be a
            # bare SetCursorPos and two mouse_events, which is the one path left
            # in this file that could report a click Windows had refused.
            $r=$hit.Current.BoundingRectangle
            $clicked=[M4Native]::Click([int]($r.X+$r.Width/2),[int]($r.Y+$r.Height/2),"left",1,8000)
            if($clicked.injected -lt $clicked.requested){
              return @{performed=$false;reason="input-blocked: Windows accepted $($clicked.injected) of $($clicked.requested) events.";target=$found.target;foreground=$foreground}
            }
            $method="bounded-pointer"
          }
        }
      }
      "focus" { $hit.SetFocus(); $method="SetFocus" }
      "setValue" { $hit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$params.text); $method="ValuePattern" }
      # The fallback types the text as characters, not as SendKeys notation. Fed
      # a value containing a brace, a plus or a percent — a password, a format
      # string, an equation — SendKeys reads it as its own syntax and puts
      # something else in the field, while reporting that it typed.
      "type" { try{$hit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$params.text);$method="ValuePattern"}catch{$hit.SetFocus();[M4Native]::TypeUnicode([string]$params.text,0)|Out-Null;$method="UnicodeSendInput"} }
      "select" { $hit.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); $method="SelectionItemPattern" }
      "expand" { $hit.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); $method="ExpandCollapsePattern" }
      "collapse" { $hit.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse(); $method="ExpandCollapsePattern" }
      "toggle" { $hit.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); $method="TogglePattern" }
      "scrollIntoView" { $hit.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView(); $method="ScrollItemPattern" }
      "nextSection" {
        $nativeHandle=[IntPtr][Int64]$hit.Current.NativeWindowHandle
        $tabCount=if($nativeHandle -ne [IntPtr]::Zero){[M4Native]::SendMessage($nativeHandle,0x1304,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32()}else{0}
        if($nativeHandle -eq [IntPtr]::Zero -or -not [M4Native]::AdvanceTab($nativeHandle)){throw "Native section navigation failed (class=$($hit.Current.ClassName), handle=$nativeHandle, count=$tabCount)"}
        $method="native-tab-next"
      }
      "selectAccessibleChild" {
        $nativeHandle=[IntPtr][Int64]$hit.Current.NativeWindowHandle
        if($nativeHandle -eq [IntPtr]::Zero -or -not [M4Native]::SelectAccessibleChild($nativeHandle,[string]$params.text)){throw "Accessible child selection failed"}
        $method="MSAA-accSelect"
      }
      default { throw "Unsupported UI action $action" }
    }
    return @{ performed=$true; method=$method; target=(Convert-Element $hit $window.windowId $window); foreground=$foreground; reGrounded=$true; geometryChanged=$geometryChanged; groundingAttempts=($groundAttempt+1) }
  } catch { return @{ performed=$false; reason=$_.Exception.Message; target=$found.target; foreground=$foreground; reGrounded=$true; geometryChanged=$geometryChanged; groundingAttempts=($groundAttempt+1) } }
}

# TEXT NO LONGER GOES THROUGH SendKeys AT ALL.
#
# It used to, and the escaping it needed lived here: SendKeys does not send text,
# it interprets a small language in which `+ ^ % ~` are Shift/Ctrl/Alt/Enter,
# `( )` group and `{ }` delimit key names. Raw text therefore arrived corrupted,
# silently — "// syscora typing probe" reached Notepad as "typing pre", and a C++
# program, being almost entirely braces and angle brackets, arrived as garbage
# while the capability reported performed=$true. Escaping every character made it
# survivable but never faithful.
#
# KEYEVENTF_UNICODE has no language to misread: the code unit that is sent is the
# character that arrives. Both the escaper and the chunker it needed are gone
# with the path that required them, and SendKeys now only ever receives notation
# a caller wrote deliberately.

# Where MoveExact reports the position the pointer actually reached. Declared up
# front because PowerShell binds an `out` parameter through [ref] to a variable
# that already exists.
$script:AchievedX = 0
$script:AchievedY = 0
$script:LastPacingMicros = 0

# Every pointer setting arrives from a language model, so none of them are
# trusted: a missing value takes the default, a value that is not a number takes
# the default, and anything out of range is clamped rather than refused. A pacing
# of a hundred seconds per point is not a request worth honouring, and it is also
# not a reason to decline to draw.
function Get-PointerSetting($value, [int]$fallback, [int]$minimum, [int]$maximum) {
  if ($null -eq $value) { return $fallback }
  $number = 0
  if (-not [int]::TryParse([string]$value, [ref]$number)) { return $fallback }
  return [Math]::Max($minimum, [Math]::Min($maximum, $number))
}

# DELIVERED IS NOT THE SAME AS ACCEPTED.
#
# SendInput says how many events the system took. Fewer than were offered means
# something blocked them — most often the target window belongs to a process
# running at a higher integrity level than this one, which is what happens the
# moment an elevated application is in the foreground. Reporting performed:true
# there would be the exact false success this codebase keeps having to undo, so
# the comparison decides `performed` and the shortfall gets a name.
function New-InputResult($result, [hashtable]$extra) {
  $blocked = $result.injected -lt $result.requested
  $payload = @{
    performed = (-not $blocked)
    requestedEvents = $result.requested
    injectedEvents = $result.injected
    durationMs = [Math]::Round($result.durationMs, 1)
  }
  if ($blocked) {
    $payload.reason = "input-blocked: Windows accepted $($result.injected) of $($result.requested) events. " +
      "The target window is most likely running elevated, which blocks input from this process."
  }
  # GetEnumerator, NOT $extra.Keys.
  #
  # PowerShell resolves a property on a hashtable against its ENTRIES before its
  # .NET members, so `$extra.Keys` on a hashtable that happens to contain a key
  # named "keys" returns that entry's value instead of the key collection. That
  # is not hypothetical: keyboard.press passes `keys`, so every key press
  # returned a result with one nonsense field named after the keystroke and
  # nothing else — no method, no windowId, no foreground.
  foreach ($entry in $extra.GetEnumerator()) { $payload[$entry.Key] = $entry.Value }
  return $payload
}

# A stroke is the one operation whose cost is chosen by its caller, so it is the
# one that can outlive the client's timeout. That matters more than it sounds:
# abandoning a stroke midway is abandoning it with the mouse button DOWN.
# Stroke's own finally block releases the button, but the request still has to
# come back inside the time the client is willing to wait, so a path that would
# take too long is delivered faster rather than delivered in pieces.
function Invoke-BoundedStroke([int[]]$path, [string]$button, [int]$pacingMicros, [int]$settleMicros) {
  if ($null -eq $path -or $path.Length -lt 4) { throw "A stroke needs at least two points." }
  $points = [int]($path.Length / 2)
  if ($points -gt 20000) { throw "That path has $points points; the limit for one stroke is 20000." }
  $budgetMicros = 20000000
  $spend = [int64]$points * [int64]$pacingMicros
  if ($spend -gt $budgetMicros) { $pacingMicros = [int]($budgetMicros / $points) }
  $script:LastPacingMicros = $pacingMicros
  # Group the moves so each burst spans roughly three milliseconds — long enough
  # to amortise the syscall, short enough that a window redrawing at 60Hz still
  # sees several updates per frame.
  $group = if ($pacingMicros -gt 0) { [Math]::Max(1, [Math]::Min(32, [int](3000 / $pacingMicros))) } else { 1 }
  return [M4Native]::Stroke($path, $button, $pacingMicros, $settleMicros, $group, $true, $true)
}

# THE RESTORE HAS TO HAPPEN AFTER THE PASTE, NOT BEFORE THE CALL RETURNS.
#
# Typing goes through the clipboard because it is the only method that arrives
# exactly in real editors, and the clipboard has to be given back to the user
# afterwards. Restoring it too early is not cosmetic: Ctrl+V only enters the
# target's message queue, so a restore that overtakes it means THE PASTE READS
# THE RESTORED CLIPBOARD — live, that put the contents of the user's clipboard
# into a document and used it as a filename in a Save dialog.
#
# The fix for that was to sleep 1.5 seconds before restoring, and it worked. It
# also charged a second and a half to every single line of text typed, in a
# product whose main complaint is that it feels slow, and the wait was pure
# dead time: nothing was being done with it.
#
# Deferring costs nothing and is just as safe. The restore is held and performed
# at the START of the next operation, which is at minimum a network round trip
# and a model decision away — far longer than the wait it replaces — so it still
# cannot overtake the paste. It is also flushed before any operation that reads
# or writes the clipboard, and before the next paste, so nothing observes the
# clipboard mid-borrow.
$script:PendingClipboardRestore = $null
$script:PendingClipboardRestoreAt = 0

function Flush-ClipboardRestore {
  if ($null -eq $script:PendingClipboardRestore) { return }
  # However long the caller took, the paste has had at least this much; top it
  # up on the rare occasion two operations arrive back to back.
  $elapsed = [Environment]::TickCount - $script:PendingClipboardRestoreAt
  if ($elapsed -lt 1500) { Start-Sleep -Milliseconds (1500 - $elapsed) }
  $value = $script:PendingClipboardRestore
  $script:PendingClipboardRestore = $null
  try {
    if ($value -eq "") { [System.Windows.Forms.Clipboard]::Clear() }
    else { [System.Windows.Forms.Clipboard]::SetText($value) }
  } catch {}
}

function Invoke-Operation($operation, $params) {
  Flush-ClipboardRestore
  switch ($operation) {
    "host.health" { return @{ ok=$true; pid=$PID; protocol="m4-windows-host/1"; sta=([Threading.Thread]::CurrentThread.ApartmentState.ToString()); inputEngine="SendInput"; dpiAwareness=$script:DpiMode } }
    "window.enumerate" { return @{ windows=(Get-WindowList) } }
    "window.foreground" { return @{ window=(Get-ForegroundWindow) } }
    "window.resolve" { return Resolve-Window $params }
    "window.wait" {
      $timeout=[Math]::Min(20000,[Math]::Max(100,[int]$params.timeoutMs));$watch=[Diagnostics.Stopwatch]::StartNew();$found=$null
      while($watch.ElapsedMilliseconds -lt $timeout -and -not $found){$found=Select-Window $params;if(-not $found){Start-Sleep -Milliseconds 100}}
      $waitReason=if($found){$null}else{"window-timeout"}
      return @{found=[bool]$found;window=$found;elapsedMs=$watch.ElapsedMilliseconds;reason=$waitReason}
    }
    "window.activate" { $focus=Acquire-Foreground $params;$current=[M4Native]::GetForegroundWindow().ToInt64();return @{performed=$focus.acquired;reason=$focus.reason;foregroundWindowId=[string]$current;window=$focus.window;attempts=$focus.attempts;resolution=$focus.resolution} }
    "window.state" { $w=Select-Window $params;if(-not $w){return @{performed=$false;reason="window-not-found"}};$commands=@{minimize=6;maximize=3;restore=9};$cmd=$commands[[string]$params.state];if(-not $cmd){throw "Unsupported window state"};return @{performed=[M4Native]::ShowWindow([IntPtr][Int64]$w.windowId,$cmd);windowId=$w.windowId;state=$params.state} }
    "window.moveResize" { $w=Select-Window $params;if(-not $w){return @{performed=$false;reason="window-not-found"}};return @{performed=[M4Native]::MoveWindow([IntPtr][Int64]$w.windowId,[int]$params.x,[int]$params.y,[int]$params.width,[int]$params.height,$true);windowId=$w.windowId} }
    "ui.inspect" { return Get-UiElements $params }
    "ui.find" { return Find-UiElement $params }
    "ui.action" { return Invoke-UiAction $params }
    "pointer.move" {
      $moved=[M4Native]::MoveExact([int]$params.x,[int]$params.y,[ref]$script:AchievedX,[ref]$script:AchievedY)
      # The position the pointer REACHED, not the one it was sent. They differ
      # when a coordinate falls outside every monitor, and a caller that is told
      # its own argument back has no way to find that out.
      return @{performed=$true;x=$script:AchievedX;y=$script:AchievedY;requestedX=[int]$params.x;requestedY=[int]$params.y;exact=$moved}
    }
    "pointer.click" {
      if($params.windowId -or $params.application){$focus=Acquire-Foreground $params;if(-not $focus.acquired){return @{performed=$false;reason=$focus.reason;foreground=$focus}};$w=$focus.window}
      $button=if($params.button){[string]$params.button}else{"left"}
      $clicks=if($params.clicks){[Math]::Max(1,[Math]::Min(3,[int]$params.clicks))}elseif($params.doubleClick -eq $true){2}else{1}
      $settle=Get-PointerSetting $params.settleMicros 8000 0 500000
      $r=[M4Native]::Click([int]$params.x,[int]$params.y,$button,$clicks,$settle)
      return (New-InputResult $r @{x=$r.endX;y=$r.endY;requestedX=[int]$params.x;requestedY=[int]$params.y;button=$button;clicks=$clicks;windowId=if($w){$w.windowId}else{$null};foreground=$focus})
    }
    "pointer.down" {
      if($params.windowId -or $params.application){$focus=Acquire-Foreground $params;if(-not $focus.acquired){return @{performed=$false;reason=$focus.reason;foreground=$focus}}}
      if($null -ne $params.x -and $null -ne $params.y){[M4Native]::MoveExact([int]$params.x,[int]$params.y,[ref]$script:AchievedX,[ref]$script:AchievedY)|Out-Null}
      $button=if($params.button){[string]$params.button}else{"left"}
      return (New-InputResult ([M4Native]::ButtonAction($button,$true)) @{button=$button})
    }
    # THE WAY OUT OF A STUCK BUTTON. A stroke that is abandoned between its press
    # and its release leaves the machine selecting everything the pointer touches,
    # in the user's own session. Stroke releases in a finally block so it cannot
    # happen from here, but a button can also be left down deliberately, and
    # whatever puts it down must have a counterpart that always works.
    "pointer.up" {
      $button=if($params.button){[string]$params.button}else{"left"}
      return (New-InputResult ([M4Native]::ButtonAction($button,$false)) @{button=$button})
    }
    "pointer.wheel" {
      if($params.windowId -or $params.application){$focus=Acquire-Foreground $params;if(-not $focus.acquired){return @{performed=$false;reason=$focus.reason;foreground=$focus}};$w=$focus.window}
      $delta=[Math]::Max(-1200,[Math]::Min(1200,[int]$params.delta))
      # SCROLLING DOWN.
      #
      # A scroll down is a NEGATIVE delta, and the field that carries it is
      # declared unsigned. Converting the value rather than reinterpreting its
      # bits is what made every downward scroll throw before a single wheel event
      # was sent — "Cannot convert value -120 to type System.UInt32" — so
      # scrolling up worked and scrolling down could not, which is the direction
      # almost every real task needs. The reinterpretation now happens inside the
      # native call, where `unchecked` states it in one word and the checked cast
      # that caused this cannot be written by accident.
      $horizontal=($params.axis -eq "horizontal")
      return (New-InputResult ([M4Native]::Wheel($delta,$horizontal)) @{delta=$delta;axis=if($horizontal){"horizontal"}else{"vertical"};windowId=if($w){$w.windowId}else{$null}})
    }
    "pointer.drag" {
      if($params.windowId -or $params.application){$focus=Acquire-Foreground $params;if(-not $focus.acquired){return @{performed=$false;reason=$focus.reason;foreground=$focus}};$w=$focus.window}
      # A drag is a stroke with two vertices. It used to be ten hops with a
      # Start-Sleep between them, and Start-Sleep cannot wait for twelve
      # milliseconds — it waits for the next scheduler tick, so the pause was
      # nearer sixteen and jittered. Ten hops is also far too coarse to draw
      # with: an application joins the positions it is told about, so a 900-pixel
      # drag delivered as ten jumps is ten straight chords no matter what tool is
      # selected. Densifying here makes the motion continuous.
      $path=[int[]]@([int]$params.fromX,[int]$params.fromY,[int]$params.toX,[int]$params.toY)
      $pacing=Get-PointerSetting $params.pacingMicros 250 0 50000
      $settle=Get-PointerSetting $params.settleMicros 12000 0 500000
      $button=if($params.button){[string]$params.button}else{"left"}
      $dense=[M4Native]::Densify($path,(Get-PointerSetting $params.stepPx 2 1 500))
      $r=Invoke-BoundedStroke $dense $button $pacing $settle
      return (New-InputResult $r @{from=@{x=[int]$params.fromX;y=[int]$params.fromY};to=@{x=[int]$params.toX;y=[int]$params.toY};windowId=if($w){$w.windowId}else{$null}})
    }
    # ONE FIGURE, ONE STROKE, ONE ROUND TRIP.
    #
    # Everything drawn rather than clicked used to have to be spelled as a series
    # of separate drags, and the button comes up between drags — so a circle
    # arrived as disconnected chords, each its own entry in the application's undo
    # stack, each costing a model round trip. A path travels whole: the button
    # goes down once, follows every point, and comes up at the end.
    #
    # `paths` draws several strokes in one call, which is what a figure that lifts
    # the pen needs — a letter, a face, a diagram.
    "pointer.stroke" {
      if($params.windowId -or $params.application){$focus=Acquire-Foreground $params;if(-not $focus.acquired){return @{performed=$false;reason=$focus.reason;foreground=$focus}};$w=$focus.window}
      # An ArrayList, not `,@(...)`. A one-element array whose element is itself
      # an array does not survive being the value of an `if` expression:
      # PowerShell unrolls it on the way out, so the list of paths becomes a flat
      # list of coordinates and every "path" in it is a single number.
      $paths=New-Object System.Collections.ArrayList
      if($params.pathsBase64){foreach($one in $params.pathsBase64){[void]$paths.Add([M4Native]::DecodePath([string]$one))}}
      elseif($params.pathBase64){[void]$paths.Add([M4Native]::DecodePath([string]$params.pathBase64))}
      elseif($params.paths){foreach($one in $params.paths){[void]$paths.Add([int[]]$one)}}
      elseif($params.path){[void]$paths.Add([int[]]$params.path)}
      if($paths.Count -eq 0){throw "pointer.stroke needs a path."}
      $pacing=Get-PointerSetting $params.pacingMicros 250 0 50000
      $settle=Get-PointerSetting $params.settleMicros 12000 0 500000
      $button=if($params.button){[string]$params.button}else{"left"}
      $stepPx=Get-PointerSetting $params.stepPx 0 0 500
      $detail=@()
      $totalPoints=0
      $totalRequested=0
      $totalInjected=0
      $totalMs=0.0
      $exact=$true
      $blocked=$false
      $lastX=0
      $lastY=0
      foreach($flat in $paths){
        if($stepPx -gt 0){$flat=[M4Native]::Densify($flat,$stepPx)}
        $r=Invoke-BoundedStroke $flat $button $pacing $settle
        $totalPoints+=$r.points
        $totalRequested+=$r.requested
        $totalInjected+=$r.injected
        $totalMs+=$r.durationMs
        $lastX=$r.endX
        $lastY=$r.endY
        if($r.injected -lt $r.requested){$blocked=$true}
        if(-not ($r.exactStart -and $r.exactEnd)){$exact=$false}
        $detail+=@{points=$r.points;durationMs=[Math]::Round($r.durationMs,1);endX=$r.endX;endY=$r.endY;exactStart=$r.exactStart;exactEnd=$r.exactEnd}
      }
      $strokeResult=@{
        performed=(-not $blocked);strokes=$detail.Count;points=$totalPoints
        requestedEvents=$totalRequested;injectedEvents=$totalInjected
        durationMs=[Math]::Round($totalMs,1);pacingMicros=$script:LastPacingMicros;exact=$exact
        endX=$lastX;endY=$lastY;detail=$detail
        windowId=if($w){$w.windowId}else{$null}
      }
      if($blocked){
        $strokeResult.reason="input-blocked: Windows accepted $totalInjected of $totalRequested events. " +
          "The target window is most likely running elevated, which blocks input from this process."
      }
      return $strokeResult
    }
    "keyboard.type" {
      if($params.windowId -or $params.application){$focus=Acquire-Foreground $params;if(-not $focus.acquired){return @{performed=$false;reason=$focus.reason;foreground=$focus}};$w=$focus.window}
      # TEXT IS TYPED, NOT PASTED.
      #
      # SendKeys was never an option: it does not transmit text, it interprets a
      # keystroke language, and no amount of escaping makes it faithful — driven
      # with a short C++ program it dropped every newline, turned `<iostream>`
      # into `,iostream>` and one `}` into `]`, while reporting success.
      #
      # The replacement was the clipboard, and pasting IS exact — but borrowing
      # the user's clipboard has a race in it that cannot be closed. The sequence
      # is: save the old clipboard, set the new text, send Ctrl+V, restore the old
      # clipboard. Ctrl+V only enters the target's message queue; if that window
      # has not drained it by the time the restore runs, THE PASTE READS THE
      # RESTORED CLIPBOARD. Live, that put the contents of the user's clipboard
      # into a Notepad document and used it as the filename in the Save dialog.
      # That is not a formatting bug, it is the user's own data being typed into
      # an application by an action that reported success.
      #
      # KEYEVENTF_UNICODE looked like the answer and is not, for the editors that
      # matter. Measured against Windows 11 Notepad with the same string by each
      # method: batched, it arrived as "int main() { return 100%2; }" followed by
      # forty copies of the document's last letter; paced at 1.5ms it truncated;
      # paced at 6ms it was worse still, characters repeating everywhere. Pasting
      # was exact. A WinForms text box, by contrast, takes any of them perfectly —
      # which is exactly why testing against one produced a confident "every
      # character arrived as written" for a method that corrupts real editors.
      #
      # So pasting stays the default, and the race is narrowed instead: the
      # restore now waits long enough for the target to have drained the Ctrl+V.
      # Unicode remains available with method:"keys" for a target that refuses
      # paste, and it is the honest choice only where its corruption does not
      # apply.
      $text=[string]$params.text
      $requested=[string]$params.method
      $pasted=$false
      $typed=$null
      $previousClipboard=$null
      if($text.Length -gt 0 -and $requested -ne "keys"){
        try{ $previousClipboard=[System.Windows.Forms.Clipboard]::GetText() }catch{ $previousClipboard=$null }
        try{
          [System.Windows.Forms.Clipboard]::SetText($text)
          Start-Sleep -Milliseconds 80
          [M4Native]::Chord("ctrl+v") | Out-Null
          # THE RESTORE MUST NOT OVERTAKE THE PASTE — see Flush-ClipboardRestore.
          #
          # Ctrl+V only enters the target's queue. Restore the clipboard before
          # that window drains it and the paste reads the RESTORED contents, which
          # is how the user's own clipboard ended up typed into a document and
          # used as the filename in a Save dialog, by an action that reported
          # success. This used to be paid for with a 1.5s sleep in the middle of
          # every single type; it is now held and done at the start of the next
          # operation, which is always further away than that.
          $pasted=$true
        }catch{ $pasted=$false }
      }
      if($text.Length -gt 0 -and -not $pasted){
        # PACED, NOT FIRED IN ONE BURST.
        #
        # Delivering the whole string in a single SendInput call is faster and is
        # WRONG in a way that is very hard to see. Windows accepts every event —
        # the call reports all of them injected — but an application that cannot
        # drain its queue that fast reads the newest character repeatedly instead
        # of each queued one. Measured against Notepad: "int main() { return
        # 100%2; }" arrived as "int main() " followed by forty-odd copies of the
        # last letter of the document. A WinForms text box takes the same burst
        # perfectly, which is exactly why this was not caught by testing against
        # one.
        #
        # A millisecond and a half per character keeps every target tested
        # here exact, and puts a thousand characters at a second and a half.
        $typed=[M4Native]::TypeUnicode($text,(Get-PointerSetting $params.pacingMicros 1500 0 50000))
      }
      if($null -ne $previousClipboard){
        # Held, not done now. The next operation flushes it, by which time the
        # target has had far longer to drain the Ctrl+V than the sleep this
        # replaces ever gave it.
        $script:PendingClipboardRestore = $previousClipboard
        $script:PendingClipboardRestoreAt = [Environment]::TickCount
      }
      $inputWindowId=if($w){$w.windowId}else{$null}
      $typeResult=@{performed=$true;method=if($pasted){"clipboard-paste"}else{"unicode-sendinput"};length=$text.Length;windowId=$inputWindowId;foreground=$focus}
      if($null -ne $typed){
        $typeResult.requestedEvents=$typed.requested
        $typeResult.injectedEvents=$typed.injected
        $typeResult.durationMs=[Math]::Round($typed.durationMs,1)
        if($typed.injected -lt $typed.requested){
          $typeResult.performed=$false
          $typeResult.reason="input-blocked: Windows accepted $($typed.injected) of $($typed.requested) keystrokes."
        }
      }
      return $typeResult
    }
    # PRESSING A COMBINATION, HELD PROPERLY.
    #
    # SendKeys expresses Ctrl+Shift+S as "^+s" and decides on its own how long to
    # hold each modifier; it cannot hold a key across two actions, cannot press a
    # media key, and reports nothing about what the system did with it. The chord
    # path presses the modifiers, taps the key, and releases in the reverse order
    # — which is the order applications that watch modifier state expect.
    #
    # SendKeys stays as the fallback because callers may pass its notation
    # directly, and a string like "%{F4}" is not a chord this can parse.
    "keyboard.press" {
      if($params.windowId -or $params.application){$focus=Acquire-Foreground $params;if(-not $focus.acquired){return @{performed=$false;reason=$focus.reason;foreground=$focus}};$w=$focus.window}
      $keys=[string]$params.keys
      $inputWindowId=if($w){$w.windowId}else{$null}
      $chord=$null
      if($params.chord){
        try{ $chord=[M4Native]::Chord([string]$params.chord) }catch{ $chord=$null }
      }
      if($null -eq $chord){
        [System.Windows.Forms.SendKeys]::SendWait($keys)
        return @{performed=$true;method="sendkeys";keys=$keys;windowId=$inputWindowId;foreground=$focus}
      }
      return (New-InputResult $chord @{method="chord";keys=$keys;chord=[string]$params.chord;windowId=$inputWindowId;foreground=$focus})
    }
    "clipboard.read" { return @{text=[System.Windows.Forms.Clipboard]::GetText()} }
    "clipboard.write" { $previous=[System.Windows.Forms.Clipboard]::GetText();[System.Windows.Forms.Clipboard]::SetText([string]$params.text);return @{written=$true;previousText=$previous} }
    "screen.capture" {
      $w = if ($params.windowId -or $params.application) { Select-Window $params } else { $null }
      if(($params.windowId -or $params.application) -and -not $w){return @{captured=$false;reason="window-not-found"}}
      if ($w) { $r=$w.bounds } elseif ($params.region) { $r=$params.region } else { $b=[System.Windows.Forms.SystemInformation]::VirtualScreen;$r=@{x=$b.X;y=$b.Y;width=$b.Width;height=$b.Height} }
      $target=[IO.Path]::GetFullPath([string]$params.path);[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
      $method="screen-region"
      if($w -and [M4Native]::CaptureWindow([IntPtr][Int64]$w.windowId,$target)){$method="PrintWindow"}
      else{[M4Native]::Capture([int]$r.x,[int]$r.y,[int]$r.width,[int]$r.height,$target)|Out-Null}
      $capturedWindowId = if($w){$w.windowId}else{$null}
      return @{captured=$true;path=$target;bounds=$r;windowId=$capturedWindowId;method=$method;timestamp=[DateTime]::UtcNow.ToString("o")}
    }
    "ocr.read" {
      return Read-OcrImage ([string]$params.path) $params.windowId ([int]$params.originX) ([int]$params.originY)
    }
    "vision.locate" {
      $w = Select-Window $params
      if(($params.windowId -or $params.application) -and -not $w){return @{found=$false;reason="window-not-found";target=$null;matches=@()}}
      $capturePath = if($params.path){[IO.Path]::GetFullPath([string]$params.path)}else{[IO.Path]::Combine([IO.Path]::GetTempPath(),"syscora-m4","vision-"+[guid]::NewGuid().ToString()+".png")}
      if(-not $params.path){
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($capturePath))|Out-Null
        $r=if($w){$w.bounds}else{@{x=0;y=0;width=[System.Windows.Forms.SystemInformation]::VirtualScreen.Width;height=[System.Windows.Forms.SystemInformation]::VirtualScreen.Height}}
        $direct=$false
        if($w){$direct=[M4Native]::CaptureWindow([IntPtr][Int64]$w.windowId,$capturePath)}
        if(-not $direct){[M4Native]::Capture([int]$r.x,[int]$r.y,[int]$r.width,[int]$r.height,$capturePath)|Out-Null}
      } else { $r=@{x=[int]$params.originX;y=[int]$params.originY} }
      $ocr=Read-OcrImage $capturePath $(if($w){$w.windowId}else{$params.windowId}) ([int]$r.x) ([int]$r.y)
      $query=[string]$params.query
      $pattern="(?i)(?<!\p{L})"+[regex]::Escape($query)+"(?!\p{L})"
      $matches=@($ocr.targets|Where-Object{[regex]::IsMatch([string]$_.name,$pattern)})
      $matchedTarget=if($matches.Count){$matches[0]}else{$null}
      if($matchedTarget -and $w){
        $observationId="vision-"+[guid]::NewGuid().ToString()
        $matchedTarget | Add-Member -NotePropertyName observationId -NotePropertyValue $observationId -Force
        $matchedTarget | Add-Member -NotePropertyName expectedForegroundWindowId -NotePropertyValue $(if($w.foreground){[string]$w.windowId}else{$null}) -Force
        $matchedTarget | Add-Member -NotePropertyName maxObservationAgeMs -NotePropertyValue 5000 -Force
        $matchedTarget | Add-Member -NotePropertyName windowIdentity -NotePropertyValue @{
          windowId=[string]$w.windowId;processId=$w.processId;processName=$w.processName;title=$w.title;className=$w.className
          bounds=$w.bounds;displayId=$w.displayId;dpi=$w.dpi
        } -Force
      }
      $reason=if($matches.Count){$null}else{"visual-target-not-found"}
      return @{found=($matches.Count -gt 0);target=$matchedTarget;matches=$matches;ocrText=$ocr.text;capturePath=$capturePath;reason=$reason}
    }
    default { throw "Unknown host operation: $operation" }
  }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    $result = Invoke-Operation ([string]$request.operation) $request.params
    [Console]::Out.WriteLine((@{id=$id;ok=$true;result=$result} | ConvertTo-Json -Compress -Depth 12))
  } catch {
    [Console]::Out.WriteLine((@{id=$id;ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress -Depth 5))
  }
  [Console]::Out.Flush()
}
