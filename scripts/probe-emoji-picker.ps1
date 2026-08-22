# What does WhatsApp's emoji picker ADD to the accessibility tree?
#
# Written to measure the verify string for the webview-click-icon eval instead of
# guessing it. The first guess — "does any control mention GIF or Sticker" —
# passed with the picker CLOSED: a chat preview containing the word "GIFTS"
# matched, and so did the closed button's own name, "Emojis, GIFs, Stickers". A
# verify that passes when nothing happened is worse than no verify at all.
#
# Opens the picker by invoking the button, reads the tree, then invokes the same
# button again to close it — a toggle, so nothing needs the keyboard and the
# user's focus is never taken.

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$frame = Get-Process WhatsApp.Root -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $frame) { "WhatsApp is not running"; exit 1 }
$contentPids = @(Get-CimInstance Win32_Process |
  Where-Object { $_.ParentProcessId -eq $frame.Id -and $_.Name -eq "msedgewebview2.exe" } |
  ForEach-Object { $_.ProcessId })

$root = [System.Windows.Automation.AutomationElement]::RootElement
$content = $null
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($contentPids -contains $w.Current.ProcessId) { $content = $w; break }
}
if (-not $content) { "no WhatsApp content window"; exit 1 }

function Get-Names($scope) {
  $rows = @()
  foreach ($e in $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      if ($e.Current.IsOffscreen) { continue }
      $name = [string]$e.Current.Name
      if (-not $name) { continue }
      $rows += [pscustomobject]@{ name = $name; type = $e.Current.ControlType.ProgrammaticName.Replace("ControlType.", "") }
    } catch {}
  }
  $rows
}

$before = Get-Names $content
"visible named controls, picker closed: $($before.Count)"

$button = $null
foreach ($e in $content.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ([string]$e.Current.Name -eq "Emojis, GIFs, Stickers") { $button = $e; break }
}
if (-not $button) { "the emoji button is not in the tree"; exit 1 }

try {
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Milliseconds 1500
  $after = Get-Names $content
  "visible named controls, picker open:   $($after.Count)"
  $known = @{}
  foreach ($row in $before) { $known["$($row.type)|$($row.name)"] = $true }
  ""
  "ONLY PRESENT WITH THE PICKER OPEN:"
  foreach ($row in $after) {
    if (-not $known.ContainsKey("$($row.type)|$($row.name)")) {
      "  {0,-12} {1}" -f $row.type, $row.name
    }
  }
} finally {
  # Toggle it shut again. The user's window is left exactly as it was found.
  try {
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 800
    ""
    "picker closed again: $((Get-Names $content).Count) visible named controls"
  } catch { "COULD NOT CLOSE THE PICKER - press Escape in WhatsApp" }
}
