# Total machine load, not one process. The eval's timings are only meaningful
# against a stated load, and "OneDrive is quiet" is not the same claim as "the
# machine is quiet" — a YouTube tab and six browsers are CPU too.
param([int]$Seconds = 20)
$samples = @()
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt $Seconds) {
  $c = Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction SilentlyContinue
  if ($c) { $samples += $c.CounterSamples[0].CookedValue }
  Start-Sleep -Milliseconds 900
}
$avg = ($samples | Measure-Object -Average).Average
$max = ($samples | Measure-Object -Maximum).Maximum
Write-Output ("TOTAL CPU over {0}s: mean {1:N1}%, peak {2:N1}%  ({3} samples, {4} logical cores)" -f `
  $Seconds, $avg, $max, $samples.Count, [Environment]::ProcessorCount)

Write-Output ""
Write-Output "=== processes over 2% of one core ==="
Get-Counter '\Process(*)\% Processor Time' -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty CounterSamples |
  Where-Object { $_.InstanceName -notin @('_total','idle') -and $_.CookedValue -gt 2 } |
  Sort-Object CookedValue -Descending |
  Select-Object -First 12 InstanceName, @{n='pctOfOneCore';e={[math]::Round($_.CookedValue,1)}} |
  Format-Table -AutoSize | Out-String -Width 200

Write-Output "=== free memory ==="
$os = Get-CimInstance Win32_OperatingSystem
Write-Output ("  {0:N1} GB free of {1:N1} GB" -f ($os.FreePhysicalMemory/1MB), ($os.TotalVisibleMemorySize/1MB))
