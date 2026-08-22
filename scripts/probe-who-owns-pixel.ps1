# WHICH WINDOW IS THE MOUSE ACTUALLY OVER?
#
# A click reported `performed=true` at exactly the right coordinates and did
# nothing, three times running, with the target window verified FOREGROUND. That
# is only possible if the pixel belongs to somebody else: foreground is not the
# same as topmost, and a synthetic click goes to whatever is painted there.
#
#   powershell -NoProfile -File scripts/probe-who-owns-pixel.ps1 -X 1622 -Y 1438
param([int]$X = 1622, [int]$Y = 1438)

Add-Type -Namespace M4Probe -Name Win -MemberDefinition @"
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(System.Drawing.Point p);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsProcessDPIAware();
[DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr context);
"@ -ReferencedAssemblies System.Drawing, System.Windows.Forms

# THE HOST RUNS PER-MONITOR-V2, SO THIS MUST TOO.
#
# A DPI-unaware process sees a virtual desktop of 1453x865 on this machine, and
# WindowFromPoint(1622,1438) answers "none" — which looks exactly like "nothing
# is there" and is really "you are asking in the wrong coordinate space".
[void][M4Probe.Win]::SetProcessDpiAwarenessContext([IntPtr](-4))

function Describe([IntPtr]$handle) {
  if ($handle -eq [IntPtr]::Zero) { return "none" }
  $sb = New-Object System.Text.StringBuilder 256
  [void][M4Probe.Win]::GetWindowTextW($handle, $sb, 256)
  $pid = 0
  [void][M4Probe.Win]::GetWindowThreadProcessId($handle, [ref]$pid)
  $name = try { (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch { "?" }
  return "$($handle.ToInt64()) $name `"$($sb.ToString())`""
}

Write-Output "process is DPI aware: $([M4Probe.Win]::IsProcessDPIAware())"
$point = New-Object System.Drawing.Point($X, $Y)
$at = [M4Probe.Win]::WindowFromPoint($point)
Write-Output "pixel $X,$Y belongs to : $(Describe $at)"
Write-Output "  its top-level window: $(Describe ([M4Probe.Win]::GetAncestor($at, 2)))"
Write-Output "foreground window     : $(Describe ([M4Probe.Win]::GetForegroundWindow()))"
