// A data screen's first view, rendered on the server (M4-08). The page calls the SAME handler its API route
// uses (no second copy of the queries or the authZ), with the page request's headers (the session cookie),
// and hands the JSON body to the client as SWR's `fallback` under the route's own key. The client renders
// it at once, so the largest element is in the HTML, and SWR refreshes it as before. A non-200 answer or a
// throw gives no fallback for that key: the client then loads it as it always did (loading, then the data
// or the error state), so those states are unchanged.
import { reportError } from "@cleared/adapters";
import { headers } from "next/headers";
import { getDeps, type Deps } from "./deps.ts";

export type FirstViewHandler = (req: Request, deps: Deps) => Promise<Response>;

/**
 * The local e2e run's way to reach the loading and error states, which a server-rendered first view no
 * longer shows on its own: with `E2E_FIRST_VIEW_SWITCH=1` (playwright.config.ts only, never deployed) a
 * page request carrying `x-e2e-first-view: off` renders without a first view, as when its read fails.
 */
export const FIRST_VIEW_OFF_HEADER = "x-e2e-first-view";

/** `[apiPath, handler]` pairs → `{ [apiPath]: body }` for the 200s. The paths are the client's SWR keys. */
export async function firstView(
  entries: ReadonlyArray<readonly [string, FirstViewHandler]>,
): Promise<Record<string, unknown>> {
  const h = await headers();
  if (process.env["E2E_FIRST_VIEW_SWITCH"] === "1" && h.get(FIRST_VIEW_OFF_HEADER) === "off") return {};
  const deps = getDeps();
  const bodies = await Promise.all(
    entries.map(async ([path, handler]) => {
      try {
        const res = await handler(new Request(`http://page.local${path}`, { headers: h }), deps);
        return res.status === 200 ? ([path, (await res.json()) as unknown] as const) : null;
      } catch (error) {
        reportError(error);
        return null;
      }
    }),
  );
  return Object.fromEntries(bodies.filter((b) => b !== null));
}
