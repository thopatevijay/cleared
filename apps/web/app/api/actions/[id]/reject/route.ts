// POST /api/actions/:id/reject (M2-08): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../../src/server/deps.ts";
import { postReject } from "../../../../../src/server/handlers/actions.ts";
import { withRoute } from "../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const POST = withRoute(
  "/api/actions/[id]/reject",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    postReject(req, getDeps(), (await ctx.params).id),
);
