// POST /api/auth/sign-out (M1-05): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../../src/server/deps.ts";
import { postSignOut } from "../../../../src/server/handlers/session-routes.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return postSignOut(req, getDeps());
}
