// Integration tests run against the compose Postgres (`make up`). When it is unreachable they skip
// (global-setup.ts prints why), so `pnpm check` stays green without Docker; with REQUIRE_DB=1 (CI)
// global-setup.ts fails the run instead.
import pg from "pg";
import { databaseUrl } from "../src/client.ts";

export const TEST_DATABASE_URL = databaseUrl();

export async function probeDatabase(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export const dbAvailable = await probeDatabase(TEST_DATABASE_URL);
