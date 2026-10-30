// GET /readyz (M1-08): 200 when db, queue and worker are all ready, else 503 with `{ checks }`.
// A thin wrapper; the checks and their tests live in src/server/readiness.ts.
import { getDb } from "../../src/server/deps.ts";
import { readyzResponse } from "../../src/server/readiness.ts";
import { withRoute } from "../../src/server/with-route.ts";

// Reads the database per request, never at build time.
export const dynamic = "force-dynamic";

export const GET = withRoute("/readyz", () => readyzResponse({ db: getDb(), now: () => new Date() }), {
  logLevel: "debug",
});
