# The idle-machine baseline. Sampled over a minute, because OneDrive's CPU is
# bursty — one 3-second sample read 28% and a Get-Counter snapshot the same
# minute read 96.7%, and quoting either alone would be the misleading kind of
# number this project exists to avoid.
param([int]$Seconds = 60)

$names = @('OneDrive.Sync.Service', 'OneDrive', 'FileCoAuth')
$before = @{}
foreach ($n in $names) {
  $before[$n] = (Get-Process -Name $n -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum
}
$t0 = Get-Date
Write-Output "sampling $Seconds s ..."
Start-Sleep -Seconds $Seconds
$elapsed = ((Get-Date) - $t0).TotalSeconds

Write-Output ""
Write-Output ("=== CPU over {0:N0}s wall, as percent of ONE core ===" -f $elapsed)
foreach ($n in $names) {
  $after = (Get-Process -Name $n -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum
  if ($null -eq $after -or $null -eq $before[$n]) { continue }
  $delta = $after - $before[$n]
  Write-Output ("  {0,-24} {1,7:N1} CPU-s   {2,6:N1}%" -f $n, $delta, (100 * $delta / $elapsed))
}

Write-Output ""
Write-Output "=== what else is running (context for the number above) ==="
Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -ne '' } |
  Select-Object -First 15 Name, @{n='title';e={$_.MainWindowTitle.Substring(0, [Math]::Min(50, $_.MainWindowTitle.Length))}} |
  Format-Table -AutoSize | Out-String -Width 200

Write-Output "=== screensaver / known CPU burners ==="
Get-Process -Name '*scr*','*screensaver*' -ErrorAction SilentlyContinue |
  Select-Object Name, Id, CPU | Format-Table -AutoSize | Out-String -Width 200
