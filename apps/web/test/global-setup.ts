// Runs once in the main Vitest process (same contract as packages/db/test/global-setup.ts): db-backed
// auth tests run when Postgres is reachable, skip when it is not, and FAIL when REQUIRE_DB=1 (CI).
import { probeDatabase, TEST_DATABASE_URL } from "./support/db.ts";

export default async function setup(): Promise<void> {
  const host = new URL(TEST_DATABASE_URL).host;
  if (await probeDatabase(TEST_DATABASE_URL)) {
    console.log(`[@cleared/web] Postgres reachable at ${host}: integration tests run.`);
  } else if (process.env["REQUIRE_DB"] === "1") {
    const message = `[@cleared/web] Postgres unreachable at ${host} and REQUIRE_DB=1: integration tests FAIL instead of skipping.`;
    console.error(message);
    throw new Error(message);
  } else {
    console.warn(
      `[@cleared/web] Postgres unreachable at ${host}: integration tests SKIPPED (start it with \`make up\`).`,
    );
  }
}
