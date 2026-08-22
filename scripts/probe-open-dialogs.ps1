# Every visible top-level window, including the OWNED ones a modal dialog uses.
#
# Get-Process only reports MainWindowTitle, so a modal dialog sitting on top of
# an application is invisible to it — the parent still reports its own title and
# looks perfectly healthy. That is exactly the state that wedges capture and
# input: the automation host times out on screen.capture and keyboard.press
# while every process-level check says the application is fine.
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@

$found = New-Object System.Collections.ArrayList
$callback = [Win+EnumWindowsProc]{
  param($hWnd, $lParam)
  if ([Win]::IsWindowVisible($hWnd)) {
    $title = New-Object System.Text.StringBuilder 512
    [void][Win]::GetWindowText($hWnd, $title, 512)
    $cls = New-Object System.Text.StringBuilder 256
    [void][Win]::GetClassName($hWnd, $cls, 256)
    # NOT $pid. That is a PowerShell automatic variable holding the CURRENT
    # process id, and assigning to it silently fails — so every row reported
    # "powershell" as the owner, including the Paint window this was written to
    # find. A probe that names the wrong process is worse than no probe.
    $owningPid = 0
    [void][Win]::GetWindowThreadProcessId($hWnd, [ref]$owningPid)
    # GW_OWNER = 4. A non-zero owner is what makes this a dialog rather than a
    # window in its own right.
    $owner = [Win]::GetWindow($hWnd, 4)
    if ($title.ToString().Trim() -ne "") {
      [void]$found.Add([PSCustomObject]@{
        Pid     = $owningPid
        Process = (Get-Process -Id $owningPid -ErrorAction SilentlyContinue).ProcessName
        Class   = $cls.ToString()
        Owned   = ($owner -ne [IntPtr]::Zero)
        Handle  = $hWnd
        Title   = $title.ToString()
      })
    }
  }
  return $true
}
[void][Win]::EnumWindows($callback, [IntPtr]::Zero)

$found | Sort-Object Process, Owned | Format-Table -AutoSize Pid, Process, Class, Owned, Title

$dialogs = $found | Where-Object { $_.Owned -or $_.Class -eq "#32770" }
Write-Output ""
Write-Output "OWNED / DIALOG windows: $($dialogs.Count)"
foreach ($d in $dialogs) { Write-Output "  $($d.Process) [$($d.Class)] '$($d.Title)'" }
