// GET /api/payments (M1-07): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../src/server/deps.ts";
import { getPayments } from "../../../src/server/handlers/payments.ts";
import { withRoute } from "../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

// Polled every 5 s by the dashboard: log at debug so the request log stays readable.
export const GET = withRoute("/api/payments", (req: Request) => getPayments(req, getDeps()), {
  logLevel: "debug",
});
