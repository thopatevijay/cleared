// M4-05: the route manifest the authZ suite must cover. Read from the source tree (no Next build, no
// import), so a planted route file shows up even when it would not compile into a page.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

const EXPORT = new RegExp(
  `export\\s+(?:const|async\\s+function|function)\\s+(${HTTP_METHODS.join("|")})\\b`,
  "g",
);

/** `app/api/holds/[id]/route.ts` → `/api/holds/[id]` (route groups `(x)` drop out, as in Next). */
export function templateOf(appDir: string, file: string): string {
  const parts = relative(appDir, file).split(sep).slice(0, -1);
  return `/${parts.filter((p) => !/^\(.*\)$/.test(p)).join("/")}`;
}

/** Every `METHOD /template` the app directory serves through a `route.ts` (or .js/.tsx). */
export function routeManifest(appDir: string): string[] {
  const files = (readdirSync(appDir, { recursive: true }) as string[])
    .filter((f) => /(^|[\\/])route\.(ts|tsx|js|mjs)$/.test(f))
    .map((f) => join(appDir, f));
  const out: string[] = [];
  for (const file of files) {
    const template = templateOf(appDir, file);
    for (const m of readFileSync(file, "utf8").matchAll(EXPORT)) out.push(`${m[1] ?? ""} ${template}`);
  }
  return [...new Set(out)].sort();
}

/** Routes with no authZ case, and cases whose route no longer exists (both fail the suite). */
export function coverageGaps(
  manifest: readonly string[],
  cases: readonly string[],
): { uncovered: string[]; stale: string[] } {
  const have = new Set(cases);
  const served = new Set(manifest);
  return {
    uncovered: manifest.filter((r) => !have.has(r)),
    stale: cases.filter((c) => !served.has(c)),
  };
}
