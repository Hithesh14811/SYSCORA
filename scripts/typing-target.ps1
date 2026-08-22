# A window that exists only to catch typed text.
#
# Verifying that text arrives exactly used to mean typing into Notepad, and that
# is not a safe place to test: modern Notepad opens a TAB in whatever instance is
# already running, so a probe that asks for "Notepad" can land in a document
# somebody is working on. This window belongs to the probe, holds nothing, and
# writes what it received to a file before closing itself.
param(
  [Parameter(Mandatory = $true)][string] $OutPath,
  [int] $Seconds = 12
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "SYSCORA typing target"
$form.Width = 1000
$form.Height = 520
$form.StartPosition = "CenterScreen"

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.AcceptsReturn = $true
$box.AcceptsTab = $true
$box.ScrollBars = "Both"
$box.WordWrap = $false
$box.Dock = "Fill"
$box.Font = New-Object System.Drawing.Font("Consolas", 11)
$form.Controls.Add($box)

# Whatever it holds when the clock runs out is the evidence, written as UTF-8
# with no byte-order mark so the comparison is over characters and nothing else.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(2, $Seconds) * 1000
$timer.Add_Tick({
  $timer.Stop()
  [IO.File]::WriteAllText($OutPath, $box.Text, (New-Object Text.UTF8Encoding($false)))
  $form.Close()
})
$timer.Start()

$form.Add_Shown({ $form.Activate(); $box.Focus() })
[void]$form.ShowDialog()
