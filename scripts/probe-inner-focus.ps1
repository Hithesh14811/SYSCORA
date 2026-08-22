# FINDING THE CONTROL THAT ACTUALLY HAS THE CARET, INSIDE A WEBVIEW.
#
# AutomationElement::FocusedElement stops at the WebView2 host pane. A full walk
# of the content window finds `Edit "Type a message…"` with HasKeyboardFocus set.
# Everything in between has to be measured rather than assumed — a condition
# that silently matches nothing looks exactly like a control that is not focused.
#
#   powershell -NoProfile -File scripts/probe-inner-focus.ps1 -Hwnd 197286
param([Parameter(Mandatory = $true)][long]$Hwnd)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$Hwnd)
Write-Output "root: $($root.Current.ControlType.ProgrammaticName) `"$($root.Current.Name)`""

$desktopFocus = [System.Windows.Automation.AutomationElement]::FocusedElement
Write-Output "FocusedElement: $($desktopFocus.Current.ControlType.ProgrammaticName) class=$($desktopFocus.Current.ClassName)"

# 1. HasKeyboardFocus as a condition.
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$byFlag = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty, $true)))
Write-Output "FindFirst(HasKeyboardFocus=true): $(if ($byFlag) { $byFlag.Current.Name } else { 'NOTHING' }) [$($watch.ElapsedMilliseconds)ms]"

# 2. By control type, then read the flag per element.
$watch.Restart()
$edit = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$combo = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ComboBox)
$doc = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
$or = $null
try {
  $or = New-Object System.Windows.Automation.OrCondition($edit, $combo, $doc)
  Write-Output "OrCondition built with three arguments: yes"
} catch {
  Write-Output "OrCondition with three arguments FAILED: $($_.Exception.Message)"
  $list = [System.Windows.Automation.Condition[]]@($edit, $combo, $doc)
  $or = [System.Windows.Automation.OrCondition]::new($list)
  Write-Output "OrCondition built from a typed array: yes"
}
$found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $or)
Write-Output "editable controls: $($found.Count) [$($watch.ElapsedMilliseconds)ms]"
foreach ($element in $found) {
  Write-Output ("   {0,-22} focus={1} value={2}" -f `
    $element.Current.ControlType.ProgrammaticName, $element.Current.HasKeyboardFocus,
    (ConvertTo-Json -Compress ([string](try { $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { $null }))))
}
