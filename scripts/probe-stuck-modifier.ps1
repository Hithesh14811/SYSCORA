# IS A MODIFIER KEY LOGICALLY STUCK DOWN?
#
# Typing into WhatsApp landed twice and then stopped landing, with the input
# engine reporting success and the foreground verified every time. A modifier
# left down by an earlier chord explains exactly that: SendInput still delivers,
# the application still has focus, and every keystroke arrives as Ctrl+something
# and does nothing.
#
# GetAsyncKeyState's high bit is "physically or logically down right now".
#
#   powershell -NoProfile -File scripts/probe-stuck-modifier.ps1
#   powershell -NoProfile -File scripts/probe-stuck-modifier.ps1 -Release

param([switch]$Release)

Add-Type -Namespace M4Probe -Name Keys -MemberDefinition @"
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
"@

$watched = @{ "Ctrl" = 0x11; "Shift" = 0x10; "Alt" = 0x12; "LWin" = 0x5B; "RWin" = 0x5C }
$down = @()
foreach ($entry in $watched.GetEnumerator()) {
  $state = [M4Probe.Keys]::GetAsyncKeyState($entry.Value)
  $isDown = ($state -band 0x8000) -ne 0
  Write-Output ("{0,-6} down={1}" -f $entry.Key, $isDown)
  if ($isDown) { $down += $entry }
}

if ($down.Count -eq 0) { Write-Output "`nNothing is held down."; exit 0 }
Write-Output "`nHELD DOWN: $($down.Name -join ', ')"
if ($Release) {
  foreach ($entry in $down) {
    [M4Probe.Keys]::keybd_event([byte]$entry.Value, 0, 0x0002, [UIntPtr]::Zero)  # KEYEVENTF_KEYUP
    Write-Output "released $($entry.Key)"
  }
}
