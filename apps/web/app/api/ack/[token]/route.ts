// POST /api/ack/:token (M3-06): the client's acceptance of the seller's scope. Public (no session); a thin
// wrapper, the handler and its tests live in src/server.
import { getDeps } from "../../../../src/server/deps.ts";
import { postAck } from "../../../../src/server/handlers/ack.ts";
import { getPublisher } from "../../../../src/server/queue.ts";
import { withRoute } from "../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

// The route template, never the path: the path carries the raw token and the request log must not.
export const POST = withRoute(
  "/api/ack/[token]",
  async (req: Request, ctx: { params: Promise<{ token: string }> }) =>
    postAck(req, getDeps(), getPublisher, (await ctx.params).token),
);
