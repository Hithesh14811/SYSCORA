# Measures what is in .syscora/ and what OneDrive is therefore uploading.
# Written because "OneDrive is syncing" was answered twice without anyone asking
# WHAT it was syncing; the answer was a 1.4 GB SQLite file rewritten every turn.
$root = 'C:\Users\hithe\OneDrive\Documents\SYSCORA\.syscora'
Write-Output "=== biggest files under .syscora ==="
Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue |
  Sort-Object Length -Descending |
  Select-Object -First 12 @{n='MB';e={[math]::Round($_.Length/1MB,1)}}, LastWriteTime, FullName |
  Format-Table -AutoSize | Out-String -Width 200

$all = Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue
$sum = ($all | Measure-Object Length -Sum).Sum
Write-Output ("TOTAL .syscora: {0} files, {1} MB" -f $all.Count, [math]::Round($sum/1MB,1))

Write-Output ""
Write-Output "=== OneDrive CPU (2 samples, 3s apart) ==="
foreach ($pass in 1,2) {
  Get-Process -Name 'OneDrive*','FileCoAuth*' -ErrorAction SilentlyContinue |
    Select-Object Name, Id, @{n='CPUsec';e={[math]::Round($_.CPU,1)}}, @{n='WS_MB';e={[math]::Round($_.WorkingSet64/1MB,0)}} |
    Format-Table -AutoSize | Out-String -Width 200
  if ($pass -eq 1) { Start-Sleep -Seconds 3 }
}

Write-Output ""
Write-Output "=== top CPU consumers right now ==="
Get-Counter '\Process(*)\% Processor Time' -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty CounterSamples |
  Where-Object { $_.InstanceName -ne '_total' -and $_.InstanceName -ne 'idle' -and $_.CookedValue -gt 3 } |
  Sort-Object CookedValue -Descending |
  Select-Object -First 12 InstanceName, @{n='pct';e={[math]::Round($_.CookedValue,1)}} |
  Format-Table -AutoSize | Out-String -Width 200
