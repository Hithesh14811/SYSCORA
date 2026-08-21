# Stop the orphaned Windows automation hosts.
#
# These are `restore-host.ps1` processes spawned by a daemon or an eval run that
# then closed its HTTP server and never called close() on the host. Measured
# 21 Aug 2026: 15 of them, 801 MB, the oldest 170.9 hours old.
#
# NOTHING IS RESTARTED, and that is correct here rather than sloppy: the host is
# spawned on demand by `getWindowsAutomationHost()` the next time anything needs
# it. These are orphans with no owner to hand back to.
#
# WHAT IT REFUSES TO TOUCH, because a wrong kill here takes the user's own shell:
#   - anything younger than $MinAgeHours (it may belong to a live run)
#   - anything with -noexit, -File, or an interactive host in its command line
#   - the process running this script, and its parent
param([switch]$Apply, [double]$MinAgeHours = 2)

$now = Get-Date
$self = $PID
$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId

$candidates = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ForEach-Object {
  $cmd = [string]$_.CommandLine
  $age = ($now - $_.CreationDate).TotalHours
  $interactive = $cmd -match '-noexit|-File\s|clean-leaked-hosts|probe-'
  [pscustomobject]@{
    Pid = $_.ProcessId; Age = [math]::Round($age, 1); Created = $_.CreationDate
    MB = [math]::Round((Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).WorkingSet64 / 1MB, 0)
    Keep = ($age -lt $MinAgeHours) -or $interactive -or ($_.ProcessId -in @($self, $parent))
    Why = if ($age -lt $MinAgeHours) { "too young" } elseif ($interactive) { "interactive/script" }
          elseif ($_.ProcessId -in @($self, $parent)) { "this script" } else { "ORPHANED HOST" }
    Cmd = if ($cmd.Length -gt 50) { $cmd.Substring(0, 50) } else { $cmd }
  }
}

Write-Output "=== every powershell.exe, and what would happen to it ==="
$candidates | Sort-Object Created | Format-Table Pid, Age, MB, Why, Cmd -AutoSize | Out-String -Width 160

$doomed = $candidates | Where-Object { -not $_.Keep }
Write-Output ("would stop {0} processes, {1} MB" -f $doomed.Count, (($doomed | Measure-Object MB -Sum).Sum))

if (-not $Apply) { Write-Output "`nDRY RUN. Re-run with -Apply."; exit 0 }

foreach ($p in $doomed) { Stop-Process -Id $p.Pid -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# VERIFY by re-reading the process table, not by trusting Stop-Process. Note
# that a pid alone proves nothing — pids are reused — so the creation time is
# checked too: a NEW powershell on a recycled pid must not read as a survivor.
$survivors = @()
foreach ($p in $doomed) {
  $still = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Pid)" -ErrorAction SilentlyContinue
  if ($still -and $still.CreationDate -eq $p.Created) { $survivors += $p.Pid }
}
Write-Output ""
if ($survivors.Count -eq 0) {
  Write-Output ("CONFIRMED: all {0} stopped. powershell.exe now running: {1}" -f `
    $doomed.Count, (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'").Count)
} else {
  Write-Output ("NOT CONFIRMED: still alive with the same creation time: {0}" -f ($survivors -join ', '))
  exit 1
}
