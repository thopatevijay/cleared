// Runs once in the main Vitest process, so the skip message is printed (console output of skipped
// test files is dropped by the reporter). With REQUIRE_DB=1 (set in CI) an unreachable database fails
// the run instead of skipping it (BL-01).
import { probeDatabase, TEST_DATABASE_URL } from "./db-available.ts";

export default async function setup(): Promise<void> {
  const host = new URL(TEST_DATABASE_URL).host;
  if (await probeDatabase(TEST_DATABASE_URL)) {
    console.log(`[@cleared/db] Postgres reachable at ${host}: integration tests run.`);
  } else if (process.env["REQUIRE_DB"] === "1") {
    // Printed as well as thrown: Vitest's startup-error reporter can lose a global-setup message.
    const message = `[@cleared/db] Postgres unreachable at ${host} and REQUIRE_DB=1: integration tests FAIL instead of skipping.`;
    console.error(message);
    throw new Error(message);
  } else {
    console.warn(
      `[@cleared/db] Postgres unreachable at ${host}: integration tests SKIPPED (start it with \`make up\`).`,
    );
  }
}
