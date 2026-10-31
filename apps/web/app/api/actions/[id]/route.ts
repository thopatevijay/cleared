// GET /api/actions/:id (M2-08): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../src/server/deps.ts";
import { getAction } from "../../../../src/server/handlers/actions.ts";
import { withRoute } from "../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "/api/actions/[id]",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    getAction(req, getDeps(), (await ctx.params).id),
);
