# Counts how many times a piece of text appears in WhatsApp's CONVERSATION.
# Prints one integer and nothing else. -1 means WhatsApp is not running.
#
# WHY THIS EXISTS. The flagship task — the highest-stakes action in the whole
# product — shipped with `verify: Write-Output 'checked-by-human'`, which passes
# unconditionally. Every scoreboard since has shown a green tick for "send a
# WhatsApp message" without anything at all having been checked, on the one task
# whose entire reason for existing is the bug where the agent reported a message
# sent while the text sat unsent in a search box. A check that cannot fail is
# worse than no check, because it is believed.
#
# Two things make this an honest check rather than a second opinion from the same
# witness:
#
#   1. It walks UIA in ITS OWN process, from the desktop root, and never touches
#      SYSCORA's long-lived host — the capability that did the sending.
#   2. It counts, and the task compares the count against one taken before the
#      run. Merely finding the words proves a message with that text exists
#      SOMEWHERE, which was already true after the first run; an increase proves
#      a new one arrived.
#
# It walks the RAW view, not the control view. Chromium publishes WhatsApp's
# message text with IsControlElement=false, so a control-view FindAll cannot
# return a message bubble at any limit — the defect that made the agent look
# blind to a conversation it was staring at.
param(
  [Parameter(Mandatory = $true)][string] $Text
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$frame = Get-Process WhatsApp.Root -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $frame) { -1; exit }

# A WebView2 application is two unrelated top-level windows: the frame named
# "WhatsApp" that owns nothing readable, and the Chromium content window that
# publishes everything. Only the second is worth walking, and it is found by
# parentage, not by title.
$contentPids = @(
  Get-CimInstance Win32_Process |
    Where-Object { $_.ParentProcessId -eq $frame.Id -and $_.Name -eq 'msedgewebview2.exe' } |
    ForEach-Object { $_.ProcessId }
)
if ($contentPids.Count -eq 0) { -1; exit }

$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$root = [System.Windows.Automation.AutomationElement]::RootElement
$found = 0
# A bound, because this is the raw view of a Chromium tree and an unbounded walk
# of one is a hang, not a slow answer. Generous enough to reach a conversation.
$budget = 40000

foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($contentPids -notcontains $window.Current.ProcessId) { continue }
  $stack = New-Object System.Collections.Stack
  $stack.Push($window)
  while ($stack.Count -gt 0 -and $budget -gt 0) {
    $node = $stack.Pop()
    $budget -= 1
    try {
      if ([string]$node.Current.Name -like "*$Text*") { $found += 1 }
      $child = $walker.GetFirstChild($node)
      while ($null -ne $child) {
        $stack.Push($child)
        $child = $walker.GetNextSibling($child)
      }
    } catch {
      # A node that went away mid-walk is normal in a live tree, not a failure.
    }
  }
}

$found
