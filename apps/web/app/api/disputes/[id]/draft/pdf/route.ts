// GET /api/disputes/:id/draft/pdf?draft=<id> (M2-09): the draft's compiled evidence PDF (download).
import { getDeps } from "../../../../../../src/server/deps.ts";
import { getDraftPdf } from "../../../../../../src/server/handlers/disputes.ts";
import { withRoute } from "../../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "/api/disputes/[id]/draft/pdf",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    getDraftPdf(req, getDeps(), (await ctx.params).id),
);
