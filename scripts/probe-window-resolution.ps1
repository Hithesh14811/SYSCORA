# WHICH WINDOW DOES "spotify" MEAN?
#
#   powershell -ExecutionPolicy Bypass -File scripts\probe-window-resolution.ps1
#
# Measured live on this machine, 28 Aug 2026: a Notepad left open from an earlier
# session and titled "*play tum hi ho on spotify - Notepad" tied with Spotify
# itself for `application: "spotify"` -- a process-name match and a title
# substring both scored +25 -- and the tie broke on window AREA, so the bigger
# window won. `focus spotify` reported NOT FOCUSED naming Notepad, and
# `screen spotify` returned the text editor's contents.
#
# This scores the REAL windows currently on the desktop, using the same rule the
# host uses, and says which window each name resolves to. It needs no agent, no
# model and no daemon -- it reads the window list and does arithmetic.
#
# It is a check that can fail: run it with a Notepad open whose title contains an
# application name and it will say so.

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinProbe {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# One Get-Process call into a lookup, never one per window -- the N+1 that cost
# 290ms is recorded in docs/state-of-the-world.md.
$processes = @{}
foreach ($p in Get-Process) { $processes[[uint32]$p.Id] = $p.ProcessName }

$foreground = [WinProbe]::GetForegroundWindow()
$windows = New-Object System.Collections.ArrayList
$callback = [WinProbe+EnumWindowsProc]{
  param($hWnd, $lParam)
  if (-not [WinProbe]::IsWindowVisible($hWnd)) { return $true }
  $len = [WinProbe]::GetWindowTextLength($hWnd)
  if ($len -eq 0) { return $true }
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [void][WinProbe]::GetWindowText($hWnd, $sb, $sb.Capacity)
  $procId = [uint32]0
  [void][WinProbe]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  $rect = New-Object WinProbe+RECT
  [void][WinProbe]::GetWindowRect($hWnd, [ref]$rect)
  [void]$windows.Add([pscustomobject]@{
    windowId    = [string]([int64]$hWnd)
    title       = $sb.ToString()
    processName = $(if ($processes.ContainsKey($procId)) { $processes[$procId] } else { "" })
    foreground  = ($hWnd -eq $foreground)
    area        = [int64]($rect.Right - $rect.Left) * [int64]($rect.Bottom - $rect.Top)
  })
  return $true
}
[void][WinProbe]::EnumWindows($callback, [IntPtr]::Zero)

# The scoring rule from Resolve-Window, for the `application` case only.
#
# -Legacy replays the rule as it was BEFORE 28 Aug 2026, where a process match
# and a title match both scored +25 and the tie broke on window area. Run the
# probe both ways with Spotify open and a Notepad whose title contains the word
# "spotify" and the two answers differ -- which is what makes this a check
# rather than a description.
$Legacy = $args -contains "-Legacy"

function Score-Window($window, $needle) {
  $score = 0; $signals = @()
  $processHit = $window.processName -and $window.processName.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
  $titleHit = $window.title -and $window.title.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
  if ($Legacy) {
    if ($processHit -or $titleHit) { $score += 25; $signals += "partial" }
  } else {
    if ($processHit) { $score += 30; $signals += "partial-process" }
    elseif ($titleHit) { $score += 12; $signals += "partial-title-weak" }
  }
  if ($window.foreground) { $score += 3 }
  return [pscustomobject]@{ score = $score; signals = ($signals -join "+") }
}

Write-Host "VISIBLE WINDOWS: $($windows.Count)"
Write-Host ""

$names = @("spotify", "whatsapp", "notepad", "chrome")
$problems = 0
foreach ($needle in $names) {
  $ranked = $windows |
    ForEach-Object {
      $s = Score-Window $_ $needle
      [pscustomobject]@{ w = $_; score = $s.score; signals = $s.signals }
    } |
    Where-Object { $_.score -ge 25 } |
    Sort-Object @{Expression={$_.score};Descending=$true}, @{Expression={$_.w.area};Descending=$true}

  Write-Host ("`"$needle`" resolves to:") -NoNewline
  if (-not $ranked -or $ranked.Count -eq 0) {
    Write-Host "  (nothing -- that application is not open)"
    continue
  }
  $winner = $ranked[0]
  Write-Host ("  [$($winner.w.processName)] " + $winner.w.title)
  foreach ($row in $ranked | Select-Object -First 4) {
    $mark = if ($row -eq $winner) { "->" } else { "  " }
    Write-Host ("   $mark score $($row.score.ToString().PadLeft(3))  $($row.signals.PadRight(20))  [$($row.w.processName)] $($row.w.title)")
  }
  # The defect: the winning window's PROCESS is not the thing that was named.
  if ($winner.w.processName -and $winner.w.processName.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    Write-Host "      ^^ WRONG: this resolved to a window whose process is not $needle" -ForegroundColor Red
    $problems += 1
  }
  Write-Host ""
}

if ($problems -eq 0) {
  Write-Host "PASS - every name resolved to a window of that application (or to nothing)."
  exit 0
}
Write-Host "FAIL - $problems name(s) resolved to the wrong application."
exit 1
