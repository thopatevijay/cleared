// GET / PATCH /api/notifications (M3-08): thin wrappers; the handlers and their tests live in src/server.
import { getDeps } from "../../../src/server/deps.ts";
import { getNotifications, patchNotifications } from "../../../src/server/handlers/notifications.ts";
import { withRoute } from "../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const GET = withRoute("/api/notifications", async (req: Request) => getNotifications(req, getDeps()));
export const PATCH = withRoute("/api/notifications", async (req: Request) =>
  patchNotifications(req, getDeps()),
);
