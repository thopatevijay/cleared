// GET /api/scenarios/:id (M2-10): a thin wrapper; the handler lives in src/server/handlers/scenarios.ts.
import { getDeps } from "../../../../src/server/deps.ts";
import { getScenario } from "../../../../src/server/handlers/scenarios.ts";
import { withRoute } from "../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "/api/scenarios/[id]",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    getScenario(req, getDeps(), (await ctx.params).id),
);
