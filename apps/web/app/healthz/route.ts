import { healthz } from "../../src/lib/healthz.ts";

// Read the environment per request, never at build time.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(healthz(), { headers: { "cache-control": "no-store" } });
}
