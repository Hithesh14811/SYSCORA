# PUTTING TEXT IN A BOX WITHOUT THE KEYBOARD.
#
# Every text failure in this project comes back to the same thing: keystrokes go
# to whatever has FOCUS, focus belongs to whoever is at the keyboard, and a
# background automation cannot hold it reliably. Measured: the WhatsApp message
# box reported focused by UIA, holding "q", with no caret drawn and twenty
# backspaces delivered as SendInput chords doing nothing at all.
#
# ValuePattern.SetValue is a cross-process call to the control. No focus, no
# foreground, no z-order, no timing. The open question is whether Chromium
# implements it for a contenteditable — this answers that on the real window.
#
#   powershell -NoProfile -File scripts/probe-setvalue.ps1 -Hwnd 197286 -Name "Type a message to Amma❤️" -Text "hello"
param([Parameter(Mandatory = $true)][long]$Hwnd, [Parameter(Mandatory = $true)][string]$Name, [string]$Text = "")

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$Hwnd)
$element = $root.FindFirst(
  [System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $Name)))
if (-not $element) { Write-Output "no control named $Name"; exit 1 }

$pattern = $null
if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
  Write-Output "no ValuePattern on this control"; exit 1
}
Write-Output "before  : $(ConvertTo-Json -Compress ([string]$pattern.Current.Value))"
Write-Output "readonly: $($pattern.Current.IsReadOnly)"
$watch = [System.Diagnostics.Stopwatch]::StartNew()
try {
  $pattern.SetValue($Text)
  Write-Output "SetValue: ok in $($watch.ElapsedMilliseconds)ms"
} catch {
  Write-Output "SetValue FAILED: $($_.Exception.Message)"
}
Start-Sleep -Milliseconds 400
Write-Output "after   : $(ConvertTo-Json -Compress ([string]$pattern.Current.Value))"
