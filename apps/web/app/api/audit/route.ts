// GET /api/audit (M2-09): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../src/server/deps.ts";
import { getAudit } from "../../../src/server/handlers/audit.ts";
import { withRoute } from "../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const GET = withRoute("/api/audit", async (req: Request) => getAudit(req, getDeps()));
