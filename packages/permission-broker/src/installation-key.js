import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// A per-installation secret key used to compute keyed approval commitments
// (HMAC over secret input values). The key never leaves the machine; it is
// created once with 0600 permissions so another non-elevated user cannot read
// it and therefore cannot forge a secret commitment. Mirrors the audit anchor
// key facility (M1) — same fail-safe creation race handling.
export class InstallationKeyStore {
  constructor(baseDirectory, filename = "approval.key") {
    this.keyPath = path.join(baseDirectory, filename);
    this.baseDirectory = baseDirectory;
  }

  async load() {
    try {
      return await fs.readFile(this.keyPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await fs.mkdir(this.baseDirectory, { recursive: true });
      const key = crypto.randomBytes(32);
      // wx = fail if it already exists so a concurrent creator wins the race and
      // we read their key rather than clobbering it.
      try {
        await fs.writeFile(this.keyPath, key, { mode: 0o600, flag: "wx" });
        return key;
      } catch (writeError) {
        if (writeError?.code === "EEXIST") return fs.readFile(this.keyPath);
        throw writeError;
      }
    }
  }

  // Synchronous variant for synchronous construction paths (the runtime factory
  // builds the broker synchronously). Same create-once, 0600, race-safe logic.
  loadSync() {
    try {
      return fsSync.readFileSync(this.keyPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      fsSync.mkdirSync(this.baseDirectory, { recursive: true });
      const key = crypto.randomBytes(32);
      try {
        fsSync.writeFileSync(this.keyPath, key, { mode: 0o600, flag: "wx" });
        return key;
      } catch (writeError) {
        if (writeError?.code === "EEXIST") return fsSync.readFileSync(this.keyPath);
        throw writeError;
      }
    }
  }
}
