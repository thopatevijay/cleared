// POST /api/packs/:packId/evidence/text (M2-01): pasted chat or scope text, JSON `{ kind, text }`. A thin
// wrapper; the handler and its tests live in src/server.
import { getDeps } from "../../../../../../src/server/deps.ts";
import { postEvidenceText } from "../../../../../../src/server/handlers/evidence.ts";
import { getPublisher } from "../../../../../../src/server/queue.ts";
import { withRoute } from "../../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const POST = withRoute(
  "/api/packs/[packId]/evidence/text",
  async (req: Request, ctx: { params: Promise<{ packId: string }> }) =>
    postEvidenceText(req, getDeps(), getPublisher, (await ctx.params).packId),
);
