// POST /api/holds/:id/completed (M3-04): the seller confirms the guided Completed web step. A thin wrapper;
// the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../../src/server/deps.ts";
import { postCompletedConfirm } from "../../../../../src/server/handlers/completed.ts";
import { getPublisher } from "../../../../../src/server/queue.ts";
import { withRoute } from "../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const POST = withRoute(
  "/api/holds/[id]/completed",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    postCompletedConfirm(req, getDeps(), getPublisher, (await ctx.params).id),
);
