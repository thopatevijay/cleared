// GET /api/holds (M3-01): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../src/server/deps.ts";
import { getHolds } from "../../../src/server/handlers/holds.ts";
import { withRoute } from "../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

// Polled every 5 s by the held-money inbox: log at debug so the request log stays readable.
export const GET = withRoute("/api/holds", (req: Request) => getHolds(req, getDeps()), {
  logLevel: "debug",
});
