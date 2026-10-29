// Runs once in the main Vitest process, so the skip message is printed (console output of skipped
// test files is dropped by the reporter).
import { probeDatabase, TEST_DATABASE_URL } from "./db-available.ts";

export default async function setup(): Promise<void> {
  const host = new URL(TEST_DATABASE_URL).host;
  if (await probeDatabase(TEST_DATABASE_URL)) {
    console.log(`[@cleared/db] Postgres reachable at ${host}: integration tests run.`);
  } else {
    console.warn(
      `[@cleared/db] Postgres unreachable at ${host}: integration tests SKIPPED (start it with \`make up\`).`,
    );
  }
}
