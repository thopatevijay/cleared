// GET /api/evidence/:id/file (M2-01): the stored bytes as an attachment with `nosniff`. A thin wrapper;
// the handler and its tests live in src/server.
import { getDeps } from "../../../../../src/server/deps.ts";
import { getEvidenceFile } from "../../../../../src/server/handlers/evidence.ts";
import { withRoute } from "../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "/api/evidence/[id]/file",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    getEvidenceFile(req, getDeps(), (await ctx.params).id),
);
