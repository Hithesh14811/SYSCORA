// Disposable command execution through the Windows Sandbox feature.
//
// This is an OS isolation boundary, not a command parser. The selected
// workspace is the only host folder mapped into the VM, networking and
// clipboard redirection are disabled, and the VM shuts down after one command.
// Windows Sandbox is an optional Windows feature, so absence is a normal,
// explicit result rather than a fallback to the host terminal.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const escapeXml = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

const blocked = (command, reason, rule) => ({
  command,
  args: [],
  exitCode: -1,
  timedOut: false,
  cancelled: false,
  blocked: true,
  blockedRule: rule,
  stdout: "",
  stderr: reason,
  isolated: true
});

export async function executeInWindowsSandbox({ command, workspaceRoots, timeoutMs = 120000, signal = null }) {
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsSandbox.exe");
  try { await fs.access(executable); } catch {
    return blocked(
      command,
      "Windows Sandbox is not installed or enabled. Enable the optional Windows Sandbox feature, then try again.",
      "shell.windows-sandbox-unavailable"
    );
  }

  const workspace = String(workspaceRoots?.[0] ?? "").trim();
  if (!workspace) {
    return blocked(command, "Disposable execution needs an attached workspace.", "shell.isolation-workspace-required");
  }

  const jobDirectory = path.join(os.tmpdir(), `syscora-sandbox-${crypto.randomUUID()}`);
  const payloadPath = path.join(jobDirectory, "payload.ps1");
  const bootstrapPath = path.join(jobDirectory, "bootstrap.ps1");
  const outputPath = path.join(jobDirectory, "output.txt");
  const exitPath = path.join(jobDirectory, "exit.txt");
  const configPath = path.join(jobDirectory, "job.wsb");
  await fs.mkdir(jobDirectory, { recursive: true });

  const bootstrap = [
    "$ErrorActionPreference = 'Stop'",
    "$code = 0",
    "try {",
    "  Set-Location 'C:\\workspace'",
    "  $payload = [IO.File]::ReadAllText('C:\\syscora-job\\payload.ps1')",
    "  & ([ScriptBlock]::Create($payload)) *>&1 | Out-File -LiteralPath 'C:\\syscora-job\\output.txt' -Encoding utf8",
    "  if ($null -ne $LASTEXITCODE) { $code = [int]$LASTEXITCODE }",
    "} catch {",
    "  $_ | Out-String | Out-File -LiteralPath 'C:\\syscora-job\\output.txt' -Encoding utf8",
    "  $code = 1",
    "}",
    "$code | Set-Content -LiteralPath 'C:\\syscora-job\\exit.txt' -Encoding ascii",
    "Start-Process shutdown.exe -ArgumentList '/s','/t','0' -WindowStyle Hidden"
  ].join("\r\n");

  const config = [
    "<Configuration>",
    "  <VGpu>Disable</VGpu>",
    "  <Networking>Disable</Networking>",
    "  <ClipboardRedirection>Disable</ClipboardRedirection>",
    "  <PrinterRedirection>Disable</PrinterRedirection>",
    "  <AudioInput>Disable</AudioInput>",
    "  <VideoInput>Disable</VideoInput>",
    "  <ProtectedClient>Enable</ProtectedClient>",
    "  <MappedFolders>",
    "    <MappedFolder>",
    `      <HostFolder>${escapeXml(path.resolve(workspace))}</HostFolder>`,
    "      <SandboxFolder>C:\\workspace</SandboxFolder>",
    "      <ReadOnly>false</ReadOnly>",
    "    </MappedFolder>",
    "    <MappedFolder>",
    `      <HostFolder>${escapeXml(jobDirectory)}</HostFolder>`,
    "      <SandboxFolder>C:\\syscora-job</SandboxFolder>",
    "      <ReadOnly>false</ReadOnly>",
    "    </MappedFolder>",
    "  </MappedFolders>",
    "  <LogonCommand>",
    "    <Command>powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\syscora-job\\bootstrap.ps1</Command>",
    "  </LogonCommand>",
    "</Configuration>"
  ].join("\r\n");

  await fs.writeFile(payloadPath, String(command), "utf8");
  await fs.writeFile(bootstrapPath, bootstrap, "utf8");
  await fs.writeFile(configPath, config, "utf8");

  let timedOut = false;
  let cancelled = false;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [configPath], { stdio: "ignore", windowsHide: true, shell: false });
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, Math.max(30000, Number(timeoutMs) || 120000));
      const onAbort = () => {
        cancelled = true;
        child.kill();
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      const clean = () => {
        clearTimeout(timeout);
        signal?.removeEventListener?.("abort", onAbort);
      };
      child.on("error", (error) => { clean(); reject(error); });
      child.on("close", () => { clean(); resolve(); });
    });
    const stdout = await fs.readFile(outputPath, "utf8").catch(() => "");
    const exitCode = Number.parseInt(await fs.readFile(exitPath, "utf8").catch(() => "-1"), 10);
    return {
      command,
      args: [],
      exitCode: Number.isFinite(exitCode) ? exitCode : -1,
      timedOut,
      cancelled,
      blocked: false,
      stdout,
      stderr: timedOut ? "Windows Sandbox did not finish before the timeout." :
        (cancelled ? "Windows Sandbox execution was cancelled." : ""),
      isolated: true
    };
  } catch (error) {
    return blocked(command, `Windows Sandbox could not start: ${error?.message ?? error}`, "shell.windows-sandbox-start");
  } finally {
    await fs.rm(jobDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
