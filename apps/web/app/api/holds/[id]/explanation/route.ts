// POST /api/holds/:id/explanation (M3-02): ask for the hold's explanation in a locale. A thin wrapper; the
// handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../../src/server/deps.ts";
import { postHoldExplanation } from "../../../../../src/server/handlers/holds.ts";
import { getPublisher } from "../../../../../src/server/queue.ts";
import { withRoute } from "../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const POST = withRoute(
  "/api/holds/[id]/explanation",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    postHoldExplanation(req, getDeps(), getPublisher, (await ctx.params).id),
);
