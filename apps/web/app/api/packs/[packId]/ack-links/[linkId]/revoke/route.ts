// POST /api/packs/:packId/ack-links/:linkId/revoke (M3-06): the seller revokes an open link. A thin
// wrapper; the handler and its tests live in src/server.
import { getDeps } from "../../../../../../../src/server/deps.ts";
import { postAckRevoke } from "../../../../../../../src/server/handlers/ack-links.ts";
import { withRoute } from "../../../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const POST = withRoute(
  "/api/packs/[packId]/ack-links/[linkId]/revoke",
  async (req: Request, ctx: { params: Promise<{ packId: string; linkId: string }> }) => {
    const { packId, linkId } = await ctx.params;
    return postAckRevoke(req, getDeps(), packId, linkId);
  },
);
