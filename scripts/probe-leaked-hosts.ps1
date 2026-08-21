# The long-lived PowerShell automation hosts that nobody shut down.
#
# `restore-host.ps1` is started as a child of the daemon and lives for the life
# of the daemon. The eval runner closes its HTTP server but never stops the
# host, so every eval and every probe leaves one behind — and an undead child
# with an open stdio pipe also keeps the runner's event loop alive, which is why
# `npm run eval` prints its whole scoreboard and then never exits.
#
# PIDS ARE REUSED, so a pid proves nothing on its own. Age is the signal: a host
# created days ago cannot belong to a run that is still going.
$now = Get-Date
$rows = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ForEach-Object {
  $proc = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  $cmd = [string]$_.CommandLine
  [pscustomobject]@{
    Pid       = $_.ProcessId
    AgeHours  = [math]::Round(($now - $_.CreationDate).TotalHours, 1)
    Created   = $_.CreationDate
    CPUsec    = if ($proc) { [math]::Round($proc.CPU, 1) } else { $null }
    MB        = if ($proc) { [math]::Round($proc.WorkingSet64 / 1MB, 0) } else { $null }
    IsHost    = $cmd -match 'restore-host|NonInteractive.*-Sta' -or $cmd -eq 'powershell.exe'
    Cmd       = if ($cmd.Length -gt 60) { $cmd.Substring(0, 60) } else { $cmd }
  }
}
$rows | Sort-Object Created | Format-Table -AutoSize | Out-String -Width 200

$leaked = $rows | Where-Object { $_.AgeHours -gt 2 }
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
