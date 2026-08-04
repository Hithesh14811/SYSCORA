# SYSCORA elevated operation host  --  protocol syscora-elevated-host/2
#
# Launched ONCE per elevated session via Start-Process -Verb RunAs, which is
# what raises the Windows UAC prompt. This process runs at high integrity; the
# unelevated daemon talks to it over a named pipe using a JSON-line
# request/response protocol.
#
# It deliberately exposes a CLOSED SET of operations. There is no shell
# passthrough and no arbitrary command execution: an elevated general command
# runner would make every other control in SYSCORA decorative.
#
# SECURITY MODEL (v2 -- rewritten after the review that blocked v1).
# The v1 host was not authoritative over its own security. It trusted whoever
# held the pipe name, sent its bearer token to them in cleartext, performed no
# parameter validation of its own, and returned to an unbounded reconnect loop
# after the daemon dropped the connection -- so revoking a session did not
# revoke the elevated authority. v2 fixes that at the architecture level:
#
#   1. THE HOST AUTHENTICATES THE DAEMON FIRST. Before sending anything, it
#      resolves the server process id of the pipe it just connected to
#      (GetNamedPipeServerProcessId) and requires it to equal the daemon pid
#      passed in at launch. A process that squats the pipe name cannot pass
#      this, because it is not the daemon.
#   2. NO BEARER TOKEN ON THE WIRE. The session secret is never transmitted.
#      The daemon issues a random nonce; the host proves possession with
#      HMAC-SHA256(secret, nonce). Every subsequent request carries a MAC over
#      its own contents plus a strictly increasing sequence number, so a
#      captured frame cannot be replayed and a captured handshake yields
#      nothing reusable. All secret comparisons are constant-time.
#   3. THE HOST VALIDATES EVERY PARAMETER ITSELF, against the same shared
#      schema file the daemon validates against. It does not trust the caller
#      to have validated.
#   4. SHUTDOWN IS TERMINAL. An authenticated shutdown, an expired deadline, or
#      a failed daemon authentication all exit the process. The host never
#      returns to the reconnect loop after any of them.

param(
  [Parameter(Mandatory = $true)][string]$PipeName,
  # Path to a single-use file holding this session's secret. Passing the secret
  # by PATH rather than by value keeps it off every process command line --
  # including the medium-integrity launcher's, which any same-user process can
  # read. The host reads it once and deletes it.
  [Parameter(Mandatory = $true)][string]$SecretFile,
  # The daemon's own process id. The host refuses to talk to any other process.
  [Parameter(Mandatory = $true)][int]$DaemonPid,
  # Hard lifetime. The host exits on its own even if the daemon never asks it
  # to, so an elevated process cannot outlive its grant.
  [Parameter(Mandatory = $true)][int]$LifetimeSeconds,
  # Shared validation schema, enforced independently of the daemon.
  [Parameter(Mandatory = $true)][string]$SchemaFile
)

$ErrorActionPreference = 'Stop'

# Monotonic lifetime. Wall-clock deadlines can be moved by a clock change (or by
# an attacker with permission to set the system time); an elapsed-time budget
# from a Stopwatch cannot.
$script:clock = [System.Diagnostics.Stopwatch]::StartNew()
$script:lifetimeSeconds = $LifetimeSeconds
$script:startedAtUtc = (Get-Date).ToUniversalTime()

function Get-RemainingSeconds {
  return $script:lifetimeSeconds - $script:clock.Elapsed.TotalSeconds
}

function Test-Expired {
  return (Get-RemainingSeconds) -le 0
}

function Get-DeadlineUtc {
  return $script:startedAtUtc.AddSeconds($script:lifetimeSeconds)
}

# --- native pipe peer identification -----------------------------------------
# .NET's NamedPipeClientStream cannot tell you which process is serving the
# pipe, so the check that makes the handshake mutual has to come from Win32.
Add-Type -Namespace SyscoraNative -Name Pipe -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetNamedPipeServerProcessId(IntPtr Pipe, out uint ServerProcessId);
'@

function Get-PipeServerProcessId($stream) {
  $serverPid = [uint32]0
  $handle = $stream.SafePipeHandle.DangerousGetHandle()
  if (-not [SyscoraNative.Pipe]::GetNamedPipeServerProcessId($handle, [ref] $serverPid)) {
    throw "GetNamedPipeServerProcessId failed with Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())."
  }
  return [int]$serverPid
}

# --- secret handling ----------------------------------------------------------
if (-not (Test-Path -LiteralPath $SecretFile)) {
  throw 'Elevated host secret file is missing; refusing to start.'
}
$script:secretBytes = [System.Text.Encoding]::UTF8.GetBytes(
  (Get-Content -LiteralPath $SecretFile -Raw).Trim()
)
# One-time use: the secret must not survive on disk for the session's lifetime.
Remove-Item -LiteralPath $SecretFile -Force -ErrorAction SilentlyContinue
if ($script:secretBytes.Length -lt 32) {
  throw 'Elevated host secret is too short; refusing to start.'
}

function Get-Hmac([string]$message) {
  $hmac = New-Object System.Security.Cryptography.HMACSHA256
  try {
    $hmac.Key = $script:secretBytes
    $digest = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($message))
    return -join ($digest | ForEach-Object { $_.ToString('x2') })
  } finally {
    $hmac.Dispose()
  }
}

# Constant-time comparison. The v1 host compared secrets with -ne, which short
# circuits on the first differing character and leaks position information.
function Test-SecretEqual([string]$expected, [string]$actual) {
  if ($null -eq $expected -or $null -eq $actual) { return $false }
  $a = [System.Text.Encoding]::UTF8.GetBytes($expected)
  $b = [System.Text.Encoding]::UTF8.GetBytes($actual)
  # Length is not secret here (both sides are fixed-width hex digests), but the
  # loop still runs over a constant span so an early length mismatch does not
  # become a timing signal on content.
  $difference = $a.Length -bxor $b.Length
  $span = [Math]::Max($a.Length, $b.Length)
  for ($i = 0; $i -lt $span; $i++) {
    $left = if ($i -lt $a.Length) { $a[$i] } else { 0 }
    $right = if ($i -lt $b.Length) { $b[$i] } else { 0 }
    $difference = $difference -bor ($left -bxor $right)
  }
  return $difference -eq 0
}

# --- shared-schema parameter validation ---------------------------------------
# This is an INDEPENDENT enforcement of the same file the daemon enforces
# (packages/privileged-helpers/schema/elevated-operations.v1.json). The host
# does not assume the daemon validated anything.
if (-not (Test-Path -LiteralPath $SchemaFile)) {
  throw 'Elevated operation schema is missing; refusing to start.'
}
$script:schema = Get-Content -LiteralPath $SchemaFile -Raw | ConvertFrom-Json
if ($script:schema.schemaVersion -ne 1) {
  throw "Unsupported elevated operation schema version: $($script:schema.schemaVersion)"
}
$script:ipv4Regex = [regex]$script:schema.formats.ipv4
$script:ipv6Regex = [regex]$script:schema.formats.ipv6
$script:hostnameLabelRegex = [regex]$script:schema.formats.hostnameLabel

function Test-HasControlCharacter([string]$value) {
  foreach ($character in $value.ToCharArray()) {
    $code = [int][char]$character
    if ($code -lt 0x20 -or $code -eq 0x7f) { return $true }
  }
  return $false
}

function Test-ValidHostname([string]$value) {
  if ([string]::IsNullOrEmpty($value) -or $value.Length -gt 253) { return $false }
  foreach ($label in $value.Split('.')) {
    if (-not $script:hostnameLabelRegex.IsMatch($label)) { return $false }
  }
  return $true
}

function Test-ValidIpAddress([string]$value) {
  if ($null -eq $value) { return $false }
  # Deliberately NOT [System.Net.IPAddress]::TryParse, which accepts shorthand
  # like "1" as 0.0.0.1. These are exact grammars, and ":::" fails both.
  return $script:ipv4Regex.IsMatch($value) -or $script:ipv6Regex.IsMatch($value)
}

function Get-PropertyNames($object) {
  if ($null -eq $object) { return @() }
  return @($object.PSObject.Properties | ForEach-Object { $_.Name })
}

function Get-PropertyValue($object, [string]$name) {
  if ($null -eq $object) { return $null }
  $property = $object.PSObject.Properties[$name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Test-SchemaField([string]$label, $rule, $value, [bool]$required, $scope) {
  if ($null -eq $value) {
    if ($required) { throw ($(if ($rule.reason) { $rule.reason } else { "$label is required." })) }
    return
  }
  if ($value -isnot [string]) {
    throw ($(if ($rule.reason) { $rule.reason } else { "$label must be a string." }))
  }
  $reason = if ($rule.reason) { $rule.reason } else { "$label failed validation." }
  if ($rule.noControlCharacters -eq $true -and (Test-HasControlCharacter $value)) { throw $reason }
  if ($null -ne $rule.maxLength -and $value.Length -gt [int]$rule.maxLength) { throw $reason }
  if ($null -ne $rule.enum -and -not (@($rule.enum) -contains $value)) { throw $reason }
  if ($null -ne $rule.pattern -and -not ([regex]$rule.pattern).IsMatch($value)) { throw $reason }
  if ($rule.format -eq 'hostname' -and -not (Test-ValidHostname $value)) { throw $reason }
  if ($rule.format -eq 'ipAddress' -and -not (Test-ValidIpAddress $value)) { throw $reason }
  if ($rule.mustEqualScope -eq $true -and $value -ne $scope) { throw $reason }
}

# Throws on any violation. Callers treat a throw as "reject the request".
function Assert-ValidRequest([string]$operation, $params) {
  $definition = Get-PropertyValue $script:schema.operations $operation
  if ($null -eq $definition) {
    throw "Operation $operation is not in the shared elevated-operation schema."
  }
  $scope = Get-PropertyValue $params 'scope'
  Test-SchemaField ($(if ($definition.scope.label) { $definition.scope.label } else { 'scope' })) $definition.scope $scope $true $scope

  $declared = Get-PropertyNames $definition.params
  foreach ($name in $declared) {
    $rule = Get-PropertyValue $definition.params $name
    Test-SchemaField $name $rule (Get-PropertyValue $params $name) ($rule.required -eq $true) $scope
  }
  # Strict: nothing undeclared crosses the boundary.
  foreach ($name in (Get-PropertyNames $params)) {
    if ($name -eq 'scope') { continue }
    if ($declared -notcontains $name) {
      throw "$operation does not accept a '$name' parameter."
    }
  }
  return $scope
}

# --- the closed operation switch ----------------------------------------------
function Invoke-ElevatedOperation($operation, $params) {
  # Control operations carry no parameters and are handled before validation.
  if ($operation -eq 'host.health') {
    return @{
      ok = $true
      pid = $PID
      elevated = (Test-Elevated)
      protocol = 'syscora-elevated-host/2'
      schemaVersion = $script:schema.schemaVersion
      expiresAt = (Get-DeadlineUtc).ToString('o')
      remainingSeconds = [Math]::Round((Get-RemainingSeconds), 3)
    }
  }

  # EVERY other operation is validated here, at the high-integrity boundary,
  # against the shared schema -- regardless of what the daemon claims it did.
  $scope = Assert-ValidRequest $operation $params

  switch ($operation) {
    'service.restart' {
      $service = Get-Service -Name $scope -ErrorAction Stop
      Restart-Service -Name $scope -Force -ErrorAction Stop
      $after = Get-Service -Name $scope
      return @{ performed = $true; service = $scope; statusBefore = $service.Status.ToString(); status = $after.Status.ToString() }
    }
    'service.setStartupType' {
      $startup = [string]$params.startupType
      Set-Service -Name $scope -StartupType $startup -ErrorAction Stop
      return @{ performed = $true; service = $scope; startupType = $startup }
    }
    'package.install' {
      $output = & winget install --id $scope --source winget --accept-package-agreements --accept-source-agreements --silent 2>&1 | Out-String
      return @{ performed = ($LASTEXITCODE -eq 0); exitCode = $LASTEXITCODE; packageId = $scope; output = $output.Substring(0, [Math]::Min(4000, $output.Length)) }
    }
    'system.setEnvironmentVariable' {
      # Machine-scoped environment variables genuinely require elevation.
      $value = [string]$params.value
      $previous = [Environment]::GetEnvironmentVariable($scope, 'Machine')
      [Environment]::SetEnvironmentVariable($scope, $value, 'Machine')
      return @{ performed = $true; name = $scope; value = $value; previousValue = $previous }
    }
    'system.hostsEntry.add' {
      $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
      $entry = "{0}`t{1}" -f ([string]$params.address), $scope
      $existing = Get-Content -Path $hostsPath -ErrorAction Stop
      if ($existing -contains $entry) { return @{ performed = $false; reason = 'entry-already-present'; entry = $entry } }
      Add-Content -Path $hostsPath -Value $entry -ErrorAction Stop
      return @{ performed = $true; entry = $entry; hostsPath = $hostsPath }
    }
    default { throw "Unknown elevated operation: $operation" }
  }
}

function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- session loop -------------------------------------------------------------
# IPC direction is deliberate. A pipe created by THIS high-integrity process
# would be unreachable from the medium-integrity daemon, because Windows
# mandatory integrity control forbids write-up. So the daemon hosts the pipe and
# this elevated process connects DOWN to it, which MIC permits.
#
# Because the pipe therefore lives at the daemon's integrity level, possession
# of the pipe is NOT authority. The daemon proves it is the daemon by its
# process id; the host proves it is the host by HMAC over the daemon's nonce.
$script:terminal = $false
$script:terminalReason = $null

while (-not $script:terminal -and -not (Test-Expired)) {
  $client = New-Object System.IO.Pipes.NamedPipeClientStream(
    '.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut,
    [System.IO.Pipes.PipeOptions]::Asynchronous)
  try {
    $client.Connect(5000)

    # STEP 1 -- authenticate the SERVER before disclosing anything at all.
    # If the daemon we were launched by is gone and someone else has stood up a
    # listener on this name, this is where we refuse. Failing here is terminal:
    # a pipe name that has been taken over will not un-take-over, and retrying
    # would just keep offering our handshake to the impostor.
    $serverPid = Get-PipeServerProcessId $client
    if ($serverPid -ne $DaemonPid) {
      $script:terminal = $true
      $script:terminalReason = "pipe-server-pid-mismatch (expected $DaemonPid, got $serverPid)"
      break
    }

    $reader = New-Object System.IO.StreamReader($client)
    $writer = New-Object System.IO.StreamWriter($client)
    $writer.AutoFlush = $true

    # STEP 2 -- challenge/response. The secret itself never crosses the pipe.
    $writer.WriteLine((@{
      type = 'hello'
      protocol = 'syscora-elevated-host/2'
      pid = $PID
      elevated = (Test-Elevated)
    } | ConvertTo-Json -Depth 4 -Compress))

    $challengeLine = $reader.ReadLine()
    if ($null -eq $challengeLine) { throw 'No challenge received.' }
    $challenge = $challengeLine | ConvertFrom-Json
    if ($challenge.type -ne 'challenge' -or [string]::IsNullOrEmpty([string]$challenge.nonce)) {
      throw 'Malformed challenge.'
    }
    $sessionNonce = [string]$challenge.nonce
    $writer.WriteLine((@{
      type = 'auth'
      proof = (Get-Hmac "syscora-auth|$sessionNonce|$PID")
    } | ConvertTo-Json -Depth 4 -Compress))

    # The daemon confirms it accepted our proof. Until it does, we do no work.
    $acceptLine = $reader.ReadLine()
    if ($null -eq $acceptLine) { throw 'No authentication result received.' }
    $accept = $acceptLine | ConvertFrom-Json
    if ($accept.type -ne 'authenticated') {
      $script:terminal = $true
      $script:terminalReason = 'daemon-rejected-authentication'
      break
    }

    # STEP 3 -- serve requests. Each carries its own MAC and a strictly
    # increasing sequence number.
    $lastSequence = 0
    while ($client.IsConnected -and -not $script:terminal) {
      $line = $reader.ReadLine()
      if ($null -eq $line) { break }

      # The deadline is re-checked HERE, after the frame arrives and before it
      # is dispatched. Checking only before the blocking ReadLine (as v1 did)
      # let a connection opened before expiry submit work after expiry.
      if (Test-Expired) {
        $script:terminal = $true
        $script:terminalReason = 'lifetime-expired'
        try {
          $expiredId = $null
          try { $expiredId = ($line | ConvertFrom-Json).id } catch { }
          $writer.WriteLine((@{ id = $expiredId; ok = $false; error = 'Elevated session lifetime expired.'; terminal = $true } | ConvertTo-Json -Depth 4 -Compress))
        } catch { }
        break
      }

      $response = $null
      $shutdownRequested = $false
      try {
        $request = $line | ConvertFrom-Json
        $requestId = [string]$request.id
        $sequence = [int]$request.seq
        $operation = [string]$request.operation

        if ($sequence -le $lastSequence) { throw 'Replayed or out-of-order request sequence.' }

        # The MAC binds the request to this session's nonce, its sequence
        # number, its id, its operation, and its exact parameter payload. A
        # frame captured from another session, or replayed within this one, or
        # altered in flight, fails here.
        $paramsJson = if ($null -ne $request.paramsJson) { [string]$request.paramsJson } else { '' }
        $expectedMac = Get-Hmac "syscora-request|$sessionNonce|$sequence|$requestId|$operation|$paramsJson"
        if (-not (Test-SecretEqual $expectedMac ([string]$request.mac))) {
          throw 'Elevated host request authentication failed.'
        }
        $lastSequence = $sequence

        # Parameters are taken from the MAC-covered JSON, never from an
        # unauthenticated sibling field.
        $params = if ($paramsJson -eq '') { $null } else { $paramsJson | ConvertFrom-Json }

        if ($operation -eq 'host.shutdown') {
          # Authenticated, terminal shutdown. This is the control that makes
          # revocation real: the process exits rather than returning to the
          # reconnect loop where it could be picked up by an impostor.
          $shutdownRequested = $true
          $response = @{ id = $requestId; ok = $true; result = @{ shuttingDown = $true; pid = $PID } }
        } else {
          $result = Invoke-ElevatedOperation $operation $params
          $response = @{ id = $requestId; ok = $true; result = $result }
        }
      } catch {
        $failedId = $null
        try { $failedId = ($line | ConvertFrom-Json).id } catch { }
        $response = @{ id = $failedId; ok = $false; error = $_.Exception.Message }
      }

      try { $writer.WriteLine(($response | ConvertTo-Json -Depth 8 -Compress)) } catch { }

      if ($shutdownRequested) {
        $script:terminal = $true
        $script:terminalReason = 'shutdown-requested'
        # Give the response a moment to drain before the handle closes.
        Start-Sleep -Milliseconds 50
        break
      }
    }
  } catch {
    # The daemon may not be listening yet, or the connection dropped. Retry
    # until the deadline -- but only for transport-level failures. Anything that
    # set $script:terminal above has already broken out.
    if (-not $script:terminal) { Start-Sleep -Milliseconds 250 }
  } finally {
    try { $client.Dispose() } catch { }
  }
}

if (-not $script:terminalReason) {
  $script:terminalReason = if (Test-Expired) { 'lifetime-expired' } else { 'loop-ended' }
}

# Zero the secret before exiting so it is not left in a page file image.
if ($script:secretBytes) {
  for ($i = 0; $i -lt $script:secretBytes.Length; $i++) { $script:secretBytes[$i] = 0 }
}

# Terminal, always. There is no path from here back into the reconnect loop.
exit 0
