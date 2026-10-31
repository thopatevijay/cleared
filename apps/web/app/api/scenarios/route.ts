// GET /api/scenarios and POST /api/scenarios (M2-10): thin wrappers; the handlers live in
// src/server/handlers/scenarios.ts, their tests in app/api/scenarios/scenarios.int.test.ts.
import { getDeps } from "../../../src/server/deps.ts";
import { getScenarios, postScenario } from "../../../src/server/handlers/scenarios.ts";
import { getPublisher } from "../../../src/server/queue.ts";
import { withRoute } from "../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const GET = withRoute("/api/scenarios", (req: Request) => getScenarios(req, getDeps()));

export const POST = withRoute("/api/scenarios", (req: Request) => postScenario(req, getDeps(), getPublisher));
