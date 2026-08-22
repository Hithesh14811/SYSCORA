# CAN WE PRESS A BUTTON WITHOUT THE MOUSE?
#
# A synthetic click reported performed=true at the right pixel, on a window
# verified foreground, and did nothing — three times, then six. Mouse input
# depends on z-order, DPI, foreground and the compositor's timing, and every one
# of those has bitten this project.
#
# UIA InvokePattern depends on none of them: it is a cross-process call to the
# control itself. This measures whether Chromium implements it on WhatsApp's
# buttons, and how long a FindFirst-by-name takes.
#
#   powershell -NoProfile -File scripts/probe-invoke.ps1 -Hwnd 197286 -Name "Search"
param([Parameter(Mandatory = $true)][long]$Hwnd, [string]$Name = "Search", [switch]$Press)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$Hwnd)
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$element = $root.FindFirst(
  [System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $Name)))
Write-Output "FindFirst by name '$Name': $(if ($element) { 'found' } else { 'NOTHING' }) in $($watch.ElapsedMilliseconds)ms"
if (-not $element) { exit 1 }

Write-Output "  type    : $($element.Current.ControlType.ProgrammaticName)"
$r = $element.Current.BoundingRectangle
Write-Output "  rect    : $([int]$r.X),$([int]$r.Y) $([int]$r.Width)x$([int]$r.Height)"
$patterns = @()
foreach ($p in @(
  [System.Windows.Automation.InvokePattern]::Pattern,
  [System.Windows.Automation.ValuePattern]::Pattern,
  [System.Windows.Automation.SelectionItemPattern]::Pattern,
  [System.Windows.Automation.TogglePattern]::Pattern)) {
  try { if ($element.TryGetCurrentPattern($p, [ref]$null)) { $patterns += ($p.ProgrammaticName -replace 'PatternIdentifiers.Pattern','') } } catch {}
}
Write-Output "  patterns: $($patterns -join ', ')"

if ($Press) {
  $watch.Restart()
  try {
    $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Write-Output "  INVOKED in $($watch.ElapsedMilliseconds)ms"
  } catch {
    Write-Output "  invoke FAILED: $($_.Exception.Message)"
  }
}
