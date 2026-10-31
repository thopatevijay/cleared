// POST /api/scenarios/:id/decide (M2-10): "Simulate PayPal's decision (sandbox only)". A thin wrapper; the
// handler lives in src/server/handlers/scenarios.ts, and the PayPal call itself runs in the worker.
import { getDeps } from "../../../../../src/server/deps.ts";
import { postDecide } from "../../../../../src/server/handlers/scenarios.ts";
import { getPublisher } from "../../../../../src/server/queue.ts";
import { withRoute } from "../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const POST = withRoute(
  "/api/scenarios/[id]/decide",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    postDecide(req, getDeps(), getPublisher, (await ctx.params).id),
);
