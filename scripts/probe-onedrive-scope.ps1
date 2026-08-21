# Is .syscora actually inside a OneDrive-managed tree, and is it excluded?
#
# The CPU number alone does not prove WHICH files OneDrive is working on. File
# attributes do: OneDrive marks every file it manages with a pin state, and an
# excluded folder carries none.
$paths = @(
  'C:\Users\hithe\OneDrive\Documents\SYSCORA\.syscora\sessions\sessions.sqlite',
  'C:\Users\hithe\OneDrive\Documents\SYSCORA\.syscora\audit\audit.sqlite',
  'C:\Users\hithe\OneDrive\Documents\SYSCORA\.syscora\semantic-state\semantic-state.sqlite',
  'C:\Users\hithe\OneDrive\Documents\SYSCORA\package.json'
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    $i = Get-Item $p -Force
    Write-Output ("{0,-14} {1,8:N1} MB  {2}" -f $i.Attributes, ($i.Length/1MB), $i.Name)
  }
}

Write-Output ""
Write-Output "=== OneDrive sync roots the machine knows about ==="
Get-ItemProperty 'HKCU:\Software\Microsoft\OneDrive\Accounts\*' -ErrorAction SilentlyContinue |
  Select-Object -Property DisplayName, UserFolder |
  Format-List | Out-String -Width 200

Write-Output "=== OneDrive.Sync.Service CPU over 10s ==="
$p1 = Get-Process -Name 'OneDrive.Sync.Service' -ErrorAction SilentlyContinue
$a = $p1.CPU
Start-Sleep -Seconds 10
$p2 = Get-Process -Name 'OneDrive.Sync.Service' -ErrorAction SilentlyContinue
$b = $p2.CPU
Write-Output ("  {0:N1} CPU-seconds in 10s wall = {1:N0}% of one core" -f ($b - $a), (($b - $a) * 10))

Write-Output "=== OneDrive (client) CPU over 10s ==="
$q1 = (Get-Process -Name 'OneDrive' -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum
Start-Sleep -Seconds 10
$q2 = (Get-Process -Name 'OneDrive' -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum
Write-Output ("  {0:N1} CPU-seconds in 10s wall = {1:N0}% of one core" -f ($q2 - $q1), (($q2 - $q1) * 10))
