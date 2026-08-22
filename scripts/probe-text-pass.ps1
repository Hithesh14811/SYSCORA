# THE SECOND PASS THAT COSTS ALMOST NOTHING.
#
# A control-view FindAll cannot see WhatsApp's message text — Chromium publishes
# those nodes with IsControlElement=false. Reading the whole raw view finds them
# and costs 1.8x (1137 nodes against 463, 5.8s against 3.2s), which is the wrong
# trade for every window that is not a conversation.
#
# A CONDITION does the filtering in the provider's process: ask the raw view for
# onscreen Text nodes only and nothing else crosses the boundary. This measures
# that against the two whole-tree reads.
#
#   powershell -NoProfile -File scripts/probe-text-pass.ps1 -Hwnd 197286
param([Parameter(Mandatory = $true)][long]$Hwnd, [int]$Show = 25)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$Hwnd)

$cache = New-Object System.Windows.Automation.CacheRequest
foreach ($property in @(
  [System.Windows.Automation.AutomationElement]::NameProperty,
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.AutomationElement]::BoundingRectangleProperty,
  [System.Windows.Automation.AutomationElement]::IsOffscreenProperty
)) { $cache.Add($property) }
$cache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
$cache.TreeScope = [System.Windows.Automation.TreeScope]::Element -bor [System.Windows.Automation.TreeScope]::Descendants
$cache.TreeFilter = [System.Windows.Automation.Automation]::RawViewCondition

$condition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text)),
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)))

$watch = [System.Diagnostics.Stopwatch]::StartNew()
$activation = $cache.Activate()
try { $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) } finally { $activation.Dispose() }
$watch.Stop()

Write-Output "raw-view onscreen Text: $($found.Count) nodes in $($watch.ElapsedMilliseconds)ms"
$rows = @()
foreach ($element in $found) {
  $r = $element.Cached.BoundingRectangle
  if ($r.Width -le 0 -or $r.Height -le 0) { continue }
  $rows += [pscustomobject]@{ y = [int]$r.Y; x = [int]$r.X; name = [string]$element.Cached.Name }
}
Write-Output "with a real rectangle:  $($rows.Count)"
Write-Output "----"
foreach ($row in ($rows | Sort-Object y | Select-Object -Last $Show)) {
  Write-Output ("  @{0},{1}  {2}" -f $row.x, $row.y, (ConvertTo-Json -Compress $row.name))
}
