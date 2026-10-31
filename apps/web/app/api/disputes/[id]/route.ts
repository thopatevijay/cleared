// GET /api/disputes/:id (M2-09): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../src/server/deps.ts";
import { getDispute } from "../../../../src/server/handlers/disputes.ts";
import { withRoute } from "../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "/api/disputes/[id]",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    getDispute(req, getDeps(), (await ctx.params).id),
);
