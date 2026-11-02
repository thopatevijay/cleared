// GET/POST /api/packs/:packId/scope-snapshot (M3-07): download the pack's scope snapshot PDF, or ask the worker
// to render one. Thin wrappers; the handlers and their tests live in src/server.
import { getDeps } from "../../../../../src/server/deps.ts";
import { getScopeSnapshot, postScopeSnapshot } from "../../../../../src/server/handlers/scope-snapshot.ts";
import { getPublisher } from "../../../../../src/server/queue.ts";
import { withRoute } from "../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ packId: string }> };

export const GET = withRoute("/api/packs/[packId]/scope-snapshot", async (req: Request, ctx: Ctx) =>
  getScopeSnapshot(req, getDeps(), (await ctx.params).packId),
);

export const POST = withRoute("/api/packs/[packId]/scope-snapshot", async (req: Request, ctx: Ctx) =>
  postScopeSnapshot(req, getDeps(), (await ctx.params).packId, getPublisher),
);
