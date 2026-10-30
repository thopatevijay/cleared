// GET /api/auth/verify (M1-05): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../src/server/deps.ts";
import { getVerify } from "../../../../src/server/handlers/verify.ts";

import { withRoute } from "../../../../src/server/with-route.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export const GET = withRoute("/api/auth/verify", (req: Request) => getVerify(req, getDeps()));
