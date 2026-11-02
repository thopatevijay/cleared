// GET/POST /api/packs/:packId/ack-links (M3-06): the pack's client acknowledgement link, and creating one.
// Thin wrappers; the handlers and their tests live in src/server.
import { getDeps } from "../../../../../src/server/deps.ts";
import { getAckLinks, postAckLink } from "../../../../../src/server/handlers/ack-links.ts";
import { withRoute } from "../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ packId: string }> };

// Polled with the pack page: log at debug so the request log stays readable.
export const GET = withRoute(
  "/api/packs/[packId]/ack-links",
  async (req: Request, ctx: Ctx) => getAckLinks(req, getDeps(), (await ctx.params).packId),
  { logLevel: "debug" },
);

export const POST = withRoute("/api/packs/[packId]/ack-links", async (req: Request, ctx: Ctx) =>
  postAckLink(req, getDeps(), (await ctx.params).packId),
);
