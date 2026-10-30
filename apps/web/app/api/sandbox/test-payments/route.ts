// POST /api/sandbox/test-payments (M1-07): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../src/server/deps.ts";
import { postTestPayment } from "../../../../src/server/handlers/payments.ts";
import { getPublisher } from "../../../../src/server/queue.ts";
import { withRoute } from "../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const POST = withRoute("/api/sandbox/test-payments", (req: Request) =>
  postTestPayment(req, getDeps(), getPublisher),
);
