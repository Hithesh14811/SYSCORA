import { createRuntime } from "./runtime-factory.js";
import { buildSessionResponse } from "../../../packages/protocol/src/session-protocol.js";

async function main() {
  const runtime = createRuntime();
  const command = process.argv[2];

  // `npm run mvp:status`. Summaries, not whole sessions: on the real
  // installation `list()` deserialises 2,234 stored sessions into 73 MB of JSON
  // so that a terminal can print a list. `--full` is still there for when the
  // whole thing is genuinely wanted.
  if (command === "sessions") {
    if (process.argv.includes("--full")) {
      const sessions = await runtime.sessionStore.list();
      console.log(JSON.stringify(buildSessionResponse({ sessions }), null, 2));
      return;
    }
    const sessions = await runtime.sessionStore.listSummaries({ limit: 200 });
    console.log(JSON.stringify({ summary: true, count: sessions.length, sessions }, null, 2));
    return;
  }

  console.error("Unknown daemon command. Supported: sessions");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
