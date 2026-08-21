import path from "node:path";
import { AuditRepository } from "../../../packages/audit/src/index.js";
import { ApprovalTokenStore } from "../../../packages/permission-broker/src/approval-token-store.js";
import { PermissionBroker } from "../../../packages/permission-broker/src/index.js";
import { PrivilegedOperationHelper } from "../../../packages/privileged-helpers/src/index.js";
import { WindowsAdapter } from "../../../os-adapters/windows/src/windows-adapter.js";
import { resolveStateDir } from "../../../packages/shared-types/src/state-path.js";

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current.startsWith("--")) {
      const key = current.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        parsed[key] = true;
      } else {
        parsed[key] = next;
        index += 1;
      }
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const basePath = args.basePath ? path.resolve(args.basePath) : process.cwd();
  const sessionId = args.sessionId ?? "privileged";
  const stateDirectory = resolveStateDir(basePath);
  const auditRepository = new AuditRepository(path.join(stateDirectory, "audit"));
  const approvalTokenStore = new ApprovalTokenStore(path.join(stateDirectory, "permission-broker"));
  const permissionBroker = new PermissionBroker({
    approvalTokenStore,
    auditRepository
  });
  const helper = new PrivilegedOperationHelper({
    permissionBroker,
    adapter: new WindowsAdapter()
  });

  const result = await helper.execute(args.operation, args.scope, {
    token: args.token,
    sessionId,
    // Mode defaults to the safe read-only VALIDATE inside the helper; COMMIT
    // must be requested explicitly so an approved token alone never mutates.
    mode: args.mode
  });

  await auditRepository.append(sessionId, result.success ? "PRIVILEGED_HELPER_EXECUTED" : "PRIVILEGED_HELPER_FAILED", {
    operation: args.operation,
    scope: args.scope,
    result
  });

  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({
    success: false,
    reason: error instanceof Error ? error.message : "Unknown error"
  }));
  process.exitCode = 1;
});
