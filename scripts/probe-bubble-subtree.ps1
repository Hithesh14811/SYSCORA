# WHAT IS UNDER A MESSAGE BUBBLE?
#
# probe-conversation-text.mjs shows the conversation as `Group "You:"` with no
# words in it. Either Chromium publishes no text node under a bubble, or our
# reading is not reaching it. This walks the RAW tree from a window handle and
# prints every node — name, control type, offscreen flag, and any TextPattern
# text — which is the difference between "not published" and "we dropped it".
#
#   powershell -NoProfile -File scripts/probe-bubble-subtree.ps1 -Hwnd 197286
#   powershell -NoProfile -File scripts/probe-bubble-subtree.ps1 -Hwnd 197286 -Under "You:"
param([Parameter(Mandatory = $true)][long]$Hwnd, [string]$Under = "", [switch]$WithText, [int]$MaxDepth = 30, [int]$Max = 400)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$Hwnd)
if (-not $root) { Write-Output "no element for hwnd $Hwnd"; exit 1 }
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker

$script:printed = 0
$script:total = 0
$script:textCount = 0

function Show-Node($node, [int]$depth, [bool]$printing) {
  if ($depth -gt $MaxDepth -or $script:printed -ge $Max) { return }
  $child = $walker.GetFirstChild($node)
  while ($child -and $script:printed -lt $Max) {
    $script:total += 1
    $type = $child.Current.ControlType.ProgrammaticName -replace "ControlType.", ""
    $name = [string]$child.Current.Name
    $r = $child.Current.BoundingRectangle
    $text = $null
    try { $text = $child.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(160) } catch {}
    if ($text) { $script:textCount += 1 }
    $show = if ($WithText) { [bool]$text } else { $printing -or (-not $Under) -or ($name -and $name -like "*$Under*") }
    if ($show) {
      $pad = " " * ($depth * 2)
      Write-Output ("{0}{1,-11} {2} off={3} {4},{5} {6}x{7}{8}" -f `
        $pad, $type, (ConvertTo-Json -Compress $name), $child.Current.IsOffscreen,
        [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height,
        $(if ($text) { " TEXT=" + (ConvertTo-Json -Compress ([string]$text)) } else { "" }))
      $script:printed += 1
    }
    Show-Node $child ($depth + 1) $show
    $child = $walker.GetNextSibling($child)
  }
}

Show-Node $root 0 $false
Write-Output ""
Write-Output "$($script:total) raw nodes visited, $($script:textCount) carry TextPattern text, $($script:printed) printed"
