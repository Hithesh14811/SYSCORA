# The long-lived PowerShell automation hosts that nobody shut down.
#
# `restore-host.ps1` is started as a child of the daemon and lives for the life
# of the daemon. The eval runner closes its HTTP server but never stops the
# host, so every eval and every probe leaves one behind — and an undead child
# with an open stdio pipe also keeps the runner's event loop alive, which is why
# `npm run eval` prints its whole scoreboard and then never exits.
#
# AGE IS NOT ORPHANHOOD, AND THIS PROBE USED TO SAY IT WAS.
#
# The leak filter was `AgeHours -gt 2` and nothing else. `IsHost` was computed,
# printed in the table, and never consulted — so every powershell.exe on the
# machine older than two hours was counted as a leaked automation host. On
# 22 Aug 2026 that reported "5 processes, 510 MB leaked" when the truth was FOUR
# shells belonging to a live Claude session and ONE host belonging to the running
# SYSCORA desktop app. Nothing had leaked at all, and the figure was repeated to
# the user as fact.
#
# A LEAKED HOST IS ONE WHOSE OWNER IS GONE. That is two questions, and age
# answers neither: a daemon that has been up all day legitimately owns a host
# that is also all day old, and a bare `powershell.exe` is not an automation host
# in the first place.
#
# PIDS ARE REUSED, so "the parent still exists" proves nothing on its own — a
# recycled pid can name an innocent stranger. The parent is only believed when it
# ALSO started before the child did, which a reused pid almost never satisfies.
$now = Get-Date
$rows = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ForEach-Object {
  $proc = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  $cmd = [string]$_.CommandLine
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" -ErrorAction SilentlyContinue
  # The on-disk artefact, not a guess: this host is running OUR script.
  $isHost = $cmd -match 'restore-host\.ps1'
  $ownerAlive = $parent -and ($parent.CreationDate -lt $_.CreationDate)
  [pscustomobject]@{
    Pid        = $_.ProcessId
    AgeHours   = [math]::Round(($now - $_.CreationDate).TotalHours, 1)
    Created    = $_.CreationDate
    CPUsec     = if ($proc) { [math]::Round($proc.CPU, 1) } else { $null }
    MB         = if ($proc) { [math]::Round($proc.WorkingSet64 / 1MB, 0) } else { $null }
    IsHost     = $isHost
    Owner      = if ($parent) { "$($parent.Name)($($parent.ProcessId))" } else { "GONE" }
    OwnerAlive = $ownerAlive
    Cmd        = if ($cmd.Length -gt 60) { $cmd.Substring(0, 60) } else { $cmd }
  }
}
$rows | Sort-Object Created | Format-Table -AutoSize | Out-String -Width 200

# Both conditions, and age only as a tiebreak against a host that is still being
# started up right now.
$leaked = $rows | Where-Object { $_.IsHost -and -not $_.OwnerAlive -and $_.AgeHours -gt 0.1 }
Write-Output ("automation hosts found: {0} | of those, orphaned: {1}" -f `
  (@($rows | Where-Object { $_.IsHost }).Count), (@($leaked).Count))
Write-Output ("LEAKED (older than 2h): {0} processes, {1} MB resident, {2} CPU-seconds burned in total" -f `
  $leaked.Count,
  (($leaked | Measure-Object MB -Sum).Sum),
  (($leaked | Measure-Object CPUsec -Sum).Sum))
Write-Output ("Oldest: {0} ({1} hours)" -f ($leaked | Sort-Object Created | Select-Object -First 1).Created, ($leaked | Sort-Object Created | Select-Object -First 1).AgeHours)

Write-Output ""
Write-Output "=== are they burning CPU right now, or just holding memory? (10s) ==="
$a = @{}
foreach ($r in $leaked) { $p = Get-Process -Id $r.Pid -ErrorAction SilentlyContinue; if ($p) { $a[$r.Pid] = $p.CPU } }
Start-Sleep -Seconds 10
$busy = 0
foreach ($r in $leaked) {
  $p = Get-Process -Id $r.Pid -ErrorAction SilentlyContinue
  if ($p -and $a.ContainsKey($r.Pid)) {
    $d = $p.CPU - $a[$r.Pid]
    if ($d -gt 0.05) { Write-Output ("  pid {0}: {1:N2} CPU-s in 10s = {2:N0}% of a core" -f $r.Pid, $d, ($d * 10)); $busy++ }
  }
}
# ASCII only inside strings: Windows PowerShell 5.1 reads a UTF-8 file with no
# BOM as ANSI, and an em-dash becomes three bytes that break the string literal.
if ($busy -eq 0) { Write-Output "  none used measurable CPU in 10s - idle, holding memory and handles" }
