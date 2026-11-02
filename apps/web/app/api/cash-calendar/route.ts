// GET /api/cash-calendar (M3-05): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../src/server/deps.ts";
import { getCashCalendar } from "../../../src/server/handlers/cash-calendar.ts";
import { withRoute } from "../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const GET = withRoute("/api/cash-calendar", (req: Request) => getCashCalendar(req, getDeps()));
