// POST /api/packs/:packId/evidence/upload (M2-01): multipart `kind` + one `file`. A thin wrapper; the
// handler and its tests live in src/server.
import { getDeps } from "../../../../../../src/server/deps.ts";
import { postEvidenceUpload } from "../../../../../../src/server/handlers/evidence.ts";
import { getPublisher } from "../../../../../../src/server/queue.ts";
import { withRoute } from "../../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";
// sharp and pdf.js need Node, not the edge runtime.
export const runtime = "nodejs";

export const POST = withRoute(
  "/api/packs/[packId]/evidence/upload",
  async (req: Request, ctx: { params: Promise<{ packId: string }> }) =>
    postEvidenceUpload(req, getDeps(), getPublisher, (await ctx.params).packId),
);
