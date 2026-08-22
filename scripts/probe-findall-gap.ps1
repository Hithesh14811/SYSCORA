# WHY DOES FindAll MISS TEXT THAT IS DEMONSTRABLY IN THE TREE?
#
# probe-bubble-subtree.ps1 walks the RAW view and finds
# `Text "singapore to sydney flight is two hour late"`, onscreen, named, in
# WhatsApp's conversation. The host's ui.inspect — FindAll(Descendants,
# TrueCondition) under an active CacheRequest — returns 80 elements and not that
# one. This prints the counts side by side and the flags on the missing node, so
# the answer is measured rather than guessed.
#
#   powershell -NoProfile -File scripts/probe-findall-gap.ps1 -Hwnd 197286 -Needle "singapore"
param([Parameter(Mandatory = $true)][long]$Hwnd, [string]$Needle = "singapore")

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$Hwnd)
$true_ = [System.Windows.Automation.Condition]::TrueCondition

$plain = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $true_)
Write-Output "FindAll, no cache request:        $($plain.Count)"

$cache = New-Object System.Windows.Automation.CacheRequest
$cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
$cache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
$cache.TreeScope = [System.Windows.Automation.TreeScope]::Element -bor [System.Windows.Automation.TreeScope]::Descendants
$activation = $cache.Activate()
try { $cached = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $true_) } finally { $activation.Dispose() }
Write-Output "FindAll, default TreeFilter:      $($cached.Count)"

$rawCache = New-Object System.Windows.Automation.CacheRequest
$rawCache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
$rawCache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
$rawCache.TreeScope = [System.Windows.Automation.TreeScope]::Element -bor [System.Windows.Automation.TreeScope]::Descendants
$rawCache.TreeFilter = [System.Windows.Automation.Automation]::RawViewCondition
$activation = $rawCache.Activate()
try { $raw = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $true_) } finally { $activation.Dispose() }
Write-Output "FindAll, RawViewCondition filter: $($raw.Count)"

foreach ($pair in @(@{ label = "plain"; set = $plain }, @{ label = "default"; set = $cached }, @{ label = "raw"; set = $raw })) {
  $hit = $null
  foreach ($element in $pair.set) {
    if ([string]$element.Current.Name -like "*$Needle*") { $hit = $element; break }
  }
  Write-Output ("{0,-8} contains `"{1}`": {2}" -f $pair.label, $Needle, [bool]$hit)
  if ($hit) {
    Write-Output ("         control={0} content={1} offscreen={2} type={3}" -f `
      $hit.Current.IsControlElement, $hit.Current.IsContentElement, $hit.Current.IsOffscreen,
      $hit.Current.ControlType.ProgrammaticName)
  }
}
