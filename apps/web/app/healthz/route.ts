// GET /healthz (M0-08): liveness, no dependencies; 200 while the process runs. Render's health check.
import { healthz } from "../../src/lib/healthz.ts";
import { withRoute } from "../../src/server/with-route.ts";

// Read the environment per request, never at build time.
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "/healthz",
  () => Response.json(healthz(), { headers: { "cache-control": "no-store" } }),
  { logLevel: "debug" },
);
