# THE CHEAP WAY TO READ A PAGE: ASK IT WHAT IS VISIBLE.
#
# WhatsApp's message text is IsControlElement=false, so a control-view FindAll
# cannot see it and a raw-view one costs 2.6 extra seconds per reading. But a
# Chromium Document supports TextPattern, and TextPattern.GetVisibleRanges()
# returns exactly the text currently on screen in ONE cross-process call — no
# tree walk, no OCR, no pixels.
#
#   powershell -NoProfile -File scripts/probe-visible-text.ps1 -Hwnd 197286
param([Parameter(Mandatory = $true)][long]$Hwnd, [int]$Max = 4000)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$Hwnd)
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Document)

$watch = [System.Diagnostics.Stopwatch]::StartNew()
$document = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
if (-not $document) { Write-Output "no Document control in this window"; exit 1 }
Write-Output "found the document in $($watch.ElapsedMilliseconds)ms"

$watch.Restart()
$pattern = $document.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
$ranges = $pattern.GetVisibleRanges()
$parts = @()
foreach ($range in $ranges) { $parts += $range.GetText($Max) }
$watch.Stop()

$text = ($parts -join "`n")
Write-Output "GetVisibleRanges: $($ranges.Count) range(s), $($text.Length) characters, $($watch.ElapsedMilliseconds)ms"
Write-Output "----"
Write-Output $text.Substring(0, [Math]::Min($Max, $text.Length))
