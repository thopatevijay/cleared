// GET /api/holds/:id (M3-01): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../src/server/deps.ts";
import { getHold } from "../../../../src/server/handlers/holds.ts";
import { withRoute } from "../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

// Polled every 5 s by the hold detail page.
export const GET = withRoute(
  "/api/holds/[id]",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    getHold(req, getDeps(), (await ctx.params).id),
  { logLevel: "debug" },
);
