# WHAT DOES READING THE RAW VIEW COST?
#
# The message text in WhatsApp is IsControlElement=false, so the control view —
# which is what FindAll uses by default — cannot see it at all. The raw view can.
# The raw view is also 1137 nodes against 463, and this codebase pays for every
# element twice: once in perception time, again in tokens on every later step.
#
# So before changing the host, measure both under the SAME filter ui.inspect
# applies (named or identified, onscreen, non-empty rectangle) and compare the
# count that actually reaches the model, and the wall time.
#
#   powershell -NoProfile -File scripts/probe-rawview-cost.ps1 -Hwnd 197286
param([Parameter(Mandatory = $true)][long]$Hwnd)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$Hwnd)

function New-Request([bool]$raw) {
  $cache = New-Object System.Windows.Automation.CacheRequest
  foreach ($property in @(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.AutomationElement]::ClassNameProperty,
    [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty,
    [System.Windows.Automation.AutomationElement]::BoundingRectangleProperty,
    [System.Windows.Automation.AutomationElement]::IsEnabledProperty,
    [System.Windows.Automation.AutomationElement]::IsOffscreenProperty,
    [System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty,
    [System.Windows.Automation.ValuePattern]::ValueProperty
  )) { $cache.Add($property) }
  $cache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
  $cache.TreeScope = [System.Windows.Automation.TreeScope]::Element -bor [System.Windows.Automation.TreeScope]::Descendants
  if ($raw) { $cache.TreeFilter = [System.Windows.Automation.Automation]::RawViewCondition }
  return $cache
}

foreach ($raw in @($false, $true)) {
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $cache = New-Request $raw
  $activation = $cache.Activate()
  try { $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) } finally { $activation.Dispose() }
  $kept = 0
  $texts = 0
  foreach ($element in $all) {
    try {
      $r = $element.Cached.BoundingRectangle
      if (-not $element.Cached.IsOffscreen -and $r.Width -gt 0 -and $r.Height -gt 0 -and
        ($element.Cached.Name -or $element.Cached.AutomationId)) {
        $kept += 1
        if ($element.Cached.ControlType.ProgrammaticName -eq "ControlType.Text") { $texts += 1 }
      }
    } catch {}
  }
  $watch.Stop()
  Write-Output ("{0,-12} {1,5} found  {2,4} kept  {3,4} of them Text  {4}ms" -f `
    $(if ($raw) { "raw view" } else { "control view" }), $all.Count, $kept, $texts, $watch.ElapsedMilliseconds)
}
