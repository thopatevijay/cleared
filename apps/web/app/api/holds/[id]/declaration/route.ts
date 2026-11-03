// POST /api/holds/:id/declaration (BL-01 6570499264): the seller declares goods or service. A thin wrapper;
// the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../../src/server/deps.ts";
import { postDeclaration } from "../../../../../src/server/handlers/declaration.ts";
import { withRoute } from "../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const POST = withRoute(
  "/api/holds/[id]/declaration",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    postDeclaration(req, getDeps(), (await ctx.params).id),
);
