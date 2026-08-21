# WHAT is OneDrive syncing, not whether it is.
#
# "OneDrive is syncing" was answered twice, honestly, and led nowhere both times
# because nobody asked what. The answer then was a 1.4 GB database rewritten on
# every turn. State has since moved out of the synced tree, so a NEW spike needs
# the same question asked again rather than assumed to be the old cause.
#
# The repository itself still lives inside OneDrive. A git checkout, merge or
# reset rewrites hundreds of tracked files and the whole of .git, and OneDrive
# re-uploads every one - so a burst right after branch surgery is expected and
# transient. This tells the two apart by AGE: recently modified files are the
# burst; the old .syscora backup sitting there is not being rewritten at all.
#
# ASCII ONLY INSIDE STRINGS. Windows PowerShell 5.1 reads a UTF-8 file with no
# BOM as ANSI, so an em-dash becomes three bytes that break the string literal -
# and the parser reports "string is missing the terminator" at the END of the
# file, nowhere near the line that actually contains it. Cost two runs here and
# two in probe-leaked-hosts.ps1 before it was recognised.
param([int]$Minutes = 20)

$repo = 'C:\Users\hithe\OneDrive\Documents\SYSCORA'
$cut = (Get-Date).AddMinutes(-$Minutes)

Write-Output "=== files under the repo modified in the last $Minutes minutes ==="
$recent = Get-ChildItem -Path $repo -Recurse -File -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -gt $cut -and $_.FullName -notmatch '\\node_modules\\' }
$recentMb = ($recent | Measure-Object Length -Sum).Sum / 1MB
Write-Output ("  {0} files, {1:N1} MB" -f $recent.Count, $recentMb)
Write-Output ""
Write-Output "  by top-level folder:"
$recent | Group-Object { ($_.FullName.Replace($repo + '\','') -split '\\')[0] } |
  Sort-Object Count -Descending | Select-Object -First 8 Count, Name |
  Format-Table -AutoSize | Out-String -Width 120

Write-Output "=== the migration backup: is anything still WRITING to it? ==="
$old = Join-Path $repo '.syscora'
if (Test-Path $old) {
  $files = Get-ChildItem -Path $old -Recurse -File -Force -ErrorAction SilentlyContinue
  $newest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $oldMb = ($files | Measure-Object Length -Sum).Sum / 1MB
  $ageH = ((Get-Date) - $newest.LastWriteTime).TotalHours
  Write-Output ("  {0} files, {1:N0} MB" -f $files.Count, $oldMb)
  Write-Output ("  newest write {0}, which is {1:N1} hours ago" -f $newest.LastWriteTime, $ageH)
  if ($ageH -lt 1) { Write-Output "  STILL BEING WRITTEN TO - that is the old defect, not a git burst" }
  else { Write-Output "  dormant: nothing has written to it recently" }
} else {
  Write-Output "  gone"
}

Write-Output ""
Write-Output "=== .git, the biggest thing a merge rewrites, and it is synced too ==="
$gitRecent = Get-ChildItem -Path (Join-Path $repo '.git') -Recurse -File -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -gt $cut }
$gitMb = ($gitRecent | Measure-Object Length -Sum).Sum / 1MB
Write-Output ("  {0} files rewritten recently, {1:N1} MB" -f $gitRecent.Count, $gitMb)
