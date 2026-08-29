param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$resolvedInstaller = (Resolve-Path -LiteralPath $Installer).Path
$runnerBase = if ($env:RUNNER_TEMP) { (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path } else { [IO.Path]::GetTempPath().TrimEnd('\') }
$smokeRoot = Join-Path $runnerBase ('syscora-installer-smoke-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $smokeRoot 'install'
$stateRoot = Join-Path $smokeRoot 'state'
New-Item -ItemType Directory -Force -Path $installRoot,$stateRoot | Out-Null
try {
  $install = Start-Process -FilePath $resolvedInstaller -ArgumentList '/S',('/D=' + $installRoot) -PassThru -Wait -WindowStyle Hidden
  if ($install.ExitCode -ne 0) { throw "Installer exited $($install.ExitCode)" }
  $appExe = Join-Path $installRoot 'SYSCORA.exe'
  if (-not (Test-Path -LiteralPath $appExe)) { throw 'Installed executable is missing.' }
  $env:SYSCORA_STATE_DIR = $stateRoot
  $env:SYSCORA_MODEL_PROVIDER = 'mock'
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  $env:SYSCORA_PORT = [string]$port
  $env:SYSCORA_DISABLE_UPDATES = '1'
  $appStdout = Join-Path $smokeRoot 'app.stdout.log'
  $appStderr = Join-Path $smokeRoot 'app.stderr.log'
  $app = Start-Process -FilePath $appExe -RedirectStandardOutput $appStdout -RedirectStandardError $appStderr -PassThru -WindowStyle Hidden
  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    do {
      Start-Sleep -Milliseconds 250
      try { $health = Invoke-RestMethod -Uri ("http://127.0.0.1:$port/api/health") -UseBasicParsing -TimeoutSec 2 } catch { $health = $null }
    } while (-not $health -and [DateTime]::UtcNow -lt $deadline)
    if (-not $health) {
      $diagnostic = @()
      if (Test-Path -LiteralPath $appStderr) { $diagnostic += Get-Content -LiteralPath $appStderr -Raw }
      if (Test-Path -LiteralPath $appStdout) { $diagnostic += Get-Content -LiteralPath $appStdout -Raw }
      $startupLog = Join-Path $stateRoot 'startup-errors.log'
      if (Test-Path -LiteralPath $startupLog) { $diagnostic += Get-Content -LiteralPath $startupLog -Raw }
      $detail = ($diagnostic -join "`n").Trim()
      throw ('Installed application did not become healthy.' + $(if ($detail) { "`n$detail" } else { '' }))
    }
  } finally {
    $null = $app.CloseMainWindow()
    if (-not $app.WaitForExit(5000)) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $appExe } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  $uninstaller = Join-Path $installRoot 'Uninstall SYSCORA.exe'
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Uninstaller is missing.' }
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
  if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited $($uninstall.ExitCode)" }
  if (Test-Path -LiteralPath $appExe) { throw 'Uninstall left the executable behind.' }
  Write-Output 'Installer launch, health, and uninstall smoke passed.'
} finally {
  $resolvedSmoke = [IO.Path]::GetFullPath($smokeRoot)
  if (-not $resolvedSmoke.StartsWith($runnerBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to clean a smoke directory outside the runner temp root.' }
  Remove-Item -LiteralPath $resolvedSmoke -Recurse -Force -ErrorAction SilentlyContinue
}
