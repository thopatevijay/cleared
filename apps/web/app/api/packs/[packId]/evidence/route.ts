// GET /api/packs/:packId/evidence (M2-01): a thin wrapper; the handler and its tests live in src/server.
import { getDeps } from "../../../../../src/server/deps.ts";
import { getEvidenceList } from "../../../../../src/server/handlers/evidence.ts";
import { withRoute } from "../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "/api/packs/[packId]/evidence",
  async (req: Request, ctx: { params: Promise<{ packId: string }> }) =>
    getEvidenceList(req, getDeps(), (await ctx.params).packId),
);
