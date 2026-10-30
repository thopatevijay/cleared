// Readiness probes (M1-08) for `/readyz`: the database answers, and the pg-boss schema is reachable.
// Apps can't run SQL themselves (eslint, M1-02), so the probes live here. Each throws on failure;
// the caller applies the timeout.
import type { Db } from "./client.ts";
import { QUEUE_SCHEMA } from "./queue.ts";

export async function pingDb(db: Db): Promise<void> {
  await db.$client.query("select 1");
}

/** The pg-boss schema exists and its version row reads (it is installed by `migrate`). */
export async function pingQueue(db: Db): Promise<void> {
  const res = await db.$client.query<{ version: number }>(
    `select version from ${QUEUE_SCHEMA}.version limit 1`,
  );
  if (res.rows.length !== 1) throw new Error(`${QUEUE_SCHEMA}.version has no row`);
}
