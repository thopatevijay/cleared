// POST /api/holds/:id/tracking (M3-03): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../../src/server/deps.ts";
import { postTrackingProposal } from "../../../../../src/server/handlers/tracking.ts";
import { withRoute } from "../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const POST = withRoute(
  "/api/holds/[id]/tracking",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    postTrackingProposal(req, getDeps(), (await ctx.params).id),
);
