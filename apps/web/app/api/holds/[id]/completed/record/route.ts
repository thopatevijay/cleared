// POST /api/holds/:id/completed/record (M3-04): propose the secondary `record_service_completed` action
// (effect on release unconfirmed). A thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../../../src/server/deps.ts";
import { postCompletedRecord } from "../../../../../../src/server/handlers/completed.ts";
import { withRoute } from "../../../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const POST = withRoute(
  "/api/holds/[id]/completed/record",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
    postCompletedRecord(req, getDeps(), (await ctx.params).id),
);
