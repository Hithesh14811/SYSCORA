# Toggle the system SPI_SETSCREENREADER flag, and read it back.
#
# Chromium builds its accessibility tree lazily and only goes to full mode when
# it believes an assistive client is present; this flag is one of the signals it
# reads. This exists to MEASURE that, not to leave it on: the flag is
# system-wide, other applications change behaviour under it, and leaving it set
# is rude. Every caller must clear it.
#
#   powershell -File scripts/spi-screenreader.ps1 -Set on
#   powershell -File scripts/spi-screenreader.ps1 -Set off
#   powershell -File scripts/spi-screenreader.ps1            # read only

param([ValidateSet("on", "off", "read")][string]$Set = "read")

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SyscoraSpi {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SystemParametersInfo(uint action, uint param, ref bool value, uint winIni);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint winIni);
}
"@

$GET = 0x0046
$PUT = 0x0047
$SEND_CHANGE = 0x0002   # broadcast WM_SETTINGCHANGE so running apps notice

if ($Set -ne "read") {
  $on = if ($Set -eq "on") { 1 } else { 0 }
  $ok = [SyscoraSpi]::SystemParametersInfo($PUT, $on, [IntPtr]::Zero, $SEND_CHANGE)
  if (-not $ok) { Write-Error "SystemParametersInfo failed: $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)" }
}

$value = $false
[void][SyscoraSpi]::SystemParametersInfo($GET, 0, [ref]$value, 0)
"SCREENREADER=$value"
