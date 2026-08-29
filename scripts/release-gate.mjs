import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
const channel = JSON.parse(await fs.readFile("release/channel.json", "utf8"));
const expectedTag = `v${pkg.version}`;
const head = git(["rev-parse", "HEAD"]);
const status = git(["status", "--porcelain"]);
const failures = [];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function fail(message) {
  failures.push(message);
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

async function readEvidence(name) {
  const evidencePath = path.join("release", "evidence", `${name}.json`);
  try {
    return JSON.parse(await fs.readFile(evidencePath, "utf8"));
  } catch {
    fail(`${name} evidence is missing or invalid JSON.`);
    return null;
  }
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fsSync.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function assertCandidate(evidence, name) {
  if (!evidence) return false;
  if (evidence.commit !== head) fail(`${name} evidence is not bound to candidate commit ${head}.`);
  if (!isIsoDate(evidence.completedAt ?? evidence.approvedAt)) fail(`${name} evidence has no valid completion timestamp.`);
  return true;
}

if (status) fail("The worktree is not clean.");
let tag = null;
try { tag = git(["describe", "--tags", "--exact-match", "HEAD"]); } catch {}
if (tag !== expectedTag) fail(`HEAD must be tagged exactly ${expectedTag}.`);
try {
  if (git(["cat-file", "-t", `refs/tags/${expectedTag}`]) !== "tag") fail(`${expectedTag} must be an annotated tag.`);
} catch {
  fail(`${expectedTag} is missing.`);
}

const buildInfoPath = path.join("dist", "win-unpacked", "resources", "build-info.json");
if (!fsSync.existsSync(buildInfoPath)) fail("Packaged build-info.json is missing; build the installer first.");
else {
  const build = JSON.parse(await fs.readFile(buildInfoPath, "utf8"));
  if (build.commit !== head || build.dirty !== false || build.version !== pkg.version) {
    fail("The packaged build does not exactly match clean tagged HEAD.");
  }
}

const installers = fsSync.existsSync("dist")
  ? (await fs.readdir("dist")).filter((name) => /^SYSCORA-.*-x64\.exe$/i.test(name))
  : [];
if (installers.length !== 1) fail(`Exactly one x64 release installer is required; found ${installers.length}.`);
const installerPath = installers.length === 1 ? path.resolve("dist", installers[0]) : null;
const installerDigest = installerPath ? await sha256(installerPath) : null;

if (process.platform !== "win32") fail("Release signature verification must run on Windows.");
if (process.platform === "win32") {
  for (const target of [installerPath, path.resolve("dist", "win-unpacked", "SYSCORA.exe")].filter(Boolean)) {
    if (!fsSync.existsSync(target)) {
      fail(`Signed release target is missing: ${target}`);
      continue;
    }
    const script = `(Get-AuthenticodeSignature -LiteralPath '${target.replace(/'/g, "''")}').Status`;
    try {
      const signature = execFileSync("pwsh.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
      if (signature !== "Valid") fail(`${path.basename(target)} Authenticode status is ${signature}, not Valid.`);
    } catch (error) {
      fail(`${path.basename(target)} Authenticode status could not be verified: ${error?.message ?? error}`);
    }
  }
}

const revocation = await readEvidence("provider-credential-revocation");
if (revocation && (!revocation.provider || !isIsoDate(revocation.revokedAt) ||
  typeof revocation.keyFingerprint !== "string" || revocation.keyFingerprint.length < 4 || revocation.keyFingerprint.length > 32)) {
  fail("Provider credential revocation evidence is incomplete or contains an unsafe fingerprint.");
}

const securityReview = await readEvidence("independent-security-review");
if (assertCandidate(securityReview, "Independent security review") &&
  (!securityReview.assessor || !isSha256(securityReview.reportDigest) || securityReview.criticalOpen !== 0 || securityReview.highOpen !== 0)) {
  fail("Independent security review has missing provenance or open high/critical findings.");
}

const injectionReview = await readEvidence("prompt-injection-red-team");
if (assertCandidate(injectionReview, "Prompt-injection red team") &&
  (!injectionReview.assessor || injectionReview.cases < 100 || injectionReview.escapedActions !== 0 ||
    injectionReview.falseSuccesses !== 0 || injectionReview.criticalOpen !== 0 || injectionReview.highOpen !== 0)) {
  fail("Prompt-injection red team is incomplete or has an escaped action/false success/open high-impact finding.");
}

const cleanMachines = await readEvidence("clean-machine-validation");
const requiredMatrix = [
  "Windows 11 24H2 Home x64", "Windows 11 24H2 Pro x64",
  "Windows 11 25H2 Home x64", "Windows 11 25H2 Pro x64",
  "Windows 11 26H1 Home x64", "Windows 11 26H1 Pro x64"
];
if (assertCandidate(cleanMachines, "Clean-machine validation") &&
  (cleanMachines.installerSha256 !== installerDigest || cleanMachines.failures !== 0 ||
    !requiredMatrix.every((entry) => cleanMachines.matrix?.includes(entry)))) {
  fail("Clean-machine validation does not cover the supported matrix or exact installer without failures.");
}

const lifecycle = await readEvidence("update-rollback-uninstall-validation");
if (assertCandidate(lifecycle, "Update/rollback/uninstall validation") &&
  (lifecycle.installerSha256 !== installerDigest || lifecycle.signedUpdatePassed !== true ||
    lifecycle.forwardRollbackPassed !== true || lifecycle.uninstallRetainPassed !== true ||
    lifecycle.uninstallAfterDeletePassed !== true)) {
  fail("Update, forward rollback, and both uninstall data paths have not all passed for this installer.");
}

const liveEval = await readEvidence("live-evaluation");
if (assertCandidate(liveEval, "Live evaluation") &&
  (liveEval.taskRows < 22 || liveEval.repeats < 3 || liveEval.failures !== 0 ||
    liveEval.falseSuccesses !== 0 || liveEval.budgetBreaches !== 0)) {
  fail("Live evaluation is incomplete or contains a failure, false success, or budget breach.");
}

const legal = await readEvidence("legal-approval");
const legalDocuments = ["LICENSE", "PRIVACY.md", "TERMS.md", "SECURITY.md", "SUPPORT.md", "NOTICE"];
if (assertCandidate(legal, "Legal approval") &&
  (!legal.reviewer || !legalDocuments.every((document) => legal.documents?.includes(document)))) {
  fail("Legal approval does not cover every required distribution document.");
}

if (channel.audience === "consumer") {
  const onboarding = await readEvidence("consumer-onboarding-validation");
  if (assertCandidate(onboarding, "Consumer onboarding") &&
    (onboarding.cleanUsers < 10 || onboarding.completionRate !== 1 || onboarding.apiProviderConceptsShown !== false ||
      onboarding.userSuppliedCredentialRequired !== false || onboarding.failures !== 0)) {
    fail("Consumer onboarding still exposes provider concepts/credentials or did not pass clean-user validation.");
  }
} else if (channel.audience !== "developer-preview") {
  fail(`Unknown release audience: ${channel.audience}`);
}

if (failures.length) {
  console.error(`RELEASE BLOCKED\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`Release gate passed for ${expectedTag} at ${head}.`);
