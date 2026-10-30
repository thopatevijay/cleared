// POST /api/auth/sign-out (M1-05): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../src/server/deps.ts";
import { postSignOut } from "../../../../src/server/handlers/session-routes.ts";

import { withRoute } from "../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const POST = withRoute("/api/auth/sign-out", (req: Request) => postSignOut(req, getDeps()));
