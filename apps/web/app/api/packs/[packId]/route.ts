// GET /api/packs/:packId (M2-05): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../src/server/deps.ts";
import { getPack } from "../../../../src/server/handlers/packs.ts";
import { withRoute } from "../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

// Polled every 5 s by the pack page while the agent works: log at debug so the request log stays readable.
export const GET = withRoute(
  "/api/packs/[packId]",
  async (req: Request, ctx: { params: Promise<{ packId: string }> }) =>
    getPack(req, getDeps(), (await ctx.params).packId),
  { logLevel: "debug" },
);
