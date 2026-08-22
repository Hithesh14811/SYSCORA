# WHAT MAKES Get-WindowList COST 405ms?
#
#   powershell -NoProfile -File scripts/probe-window-list-cost.ps1
#
# `adapter.listWindows()` is the single largest component of a look at the
# screen — measured 22 Aug 2026 at p50 405ms against 37 open windows, which is
# a third of every `screen` call. Get-WindowList does three things per window:
# Get-Process -Id, Screen.FromHandle and DpiForWindow. "Per window" is a
# hypothesis about which of them costs, not a measurement, and the wrong one
# would be optimised on a guess.
#
# So this times each of the three over the SAME real window set the host sees,
# and times the obvious alternative for each. Nothing here touches the host or
# any window: it enumerates and reads.

Add-Type -AssemblyName System.Windows.Forms
if (-not ("ProbeNative" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class ProbeNative {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetDpiForWindow(IntPtr h);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  public class Win { public long Handle; public int Pid; public string Title; }
  public static List<Win> Windows() {
    var found = new List<Win>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      found.Add(new Win { Handle = h.ToInt64(), Pid = (int)pid, Title = sb.ToString() });
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
}

$windows = [ProbeNative]::Windows()
Write-Output ""
Write-Output "$($windows.Count) visible titled windows"
Write-Output ""

function Time-It($label, $iterations, $block) {
  # Three passes, smallest reported: this is competing with everything else on a
  # live desktop and the floor is the honest figure for the work itself.
  $best = [double]::MaxValue
  for ($pass = 0; $pass -lt 3; $pass++) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    for ($i = 0; $i -lt $iterations; $i++) { & $block | Out-Null }
    $sw.Stop()
    if ($sw.Elapsed.TotalMilliseconds -lt $best) { $best = $sw.Elapsed.TotalMilliseconds }
  }
  Write-Output ("  {0,-46} {1,8:N1}ms" -f $label, $best)
}

Write-Output "PER-WINDOW WORK, once over every window"
Time-It "Get-Process -Id, once per window (current)" 1 {
  foreach ($w in $windows) { Get-Process -Id $w.Pid -ErrorAction SilentlyContinue }
}
Time-It "Get-Process once, into a lookup table" 1 {
  $byId = @{}
  foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) { $byId[$p.Id] = $p.ProcessName }
  foreach ($w in $windows) { $byId[$w.Pid] }
}
Time-It "Screen.FromHandle, once per window" 1 {
  foreach ($w in $windows) { [System.Windows.Forms.Screen]::FromHandle([IntPtr][Int64]$w.Handle) }
}
Time-It "GetDpiForWindow, once per window" 1 {
  foreach ($w in $windows) { [ProbeNative]::GetDpiForWindow([IntPtr][Int64]$w.Handle) }
}
Time-It "the native enumeration itself" 1 { [ProbeNative]::Windows() }
Write-Output ""
