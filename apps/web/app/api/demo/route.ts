// POST /api/demo (M1-05): a thin wrapper; the handler and its tests live in src/server/handlers.
import { getDeps } from "../../../src/server/deps.ts";
import { postDemo } from "../../../src/server/handlers/demo.ts";

// Reads the environment and the database per request, never at build time.
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return postDemo(req, getDeps());
}
