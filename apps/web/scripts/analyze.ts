// M4-04 bundle analysis: the first-load JavaScript of every route of the last `next build`, gzipped (level
// 9, what a CDN serves), from Next's own route list (`.next/diagnostics/route-bundle-stats.json`: the root
// main files plus the route's entry chunks). The dashboard (`/[locale]/payments`) has a 200 KB budget
// (engineering standards §3.5); the Bryntum engine is loaded at runtime from /vendor and never counted.
// `--json` prints one JSON object (the Validation Gate reads `dashboardFirstLoadGzipKB`); without it, a table.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const DASHBOARD_ROUTE = "/[locale]/payments";
export const DASHBOARD_BUDGET_KB = 200;

interface RouteStats {
  readonly route: string;
  readonly firstLoadChunkPaths: readonly string[];
}

export interface RouteSize {
  readonly route: string;
  readonly gzipKB: number;
  readonly rawKB: number;
  readonly chunks: number;
}

const kb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10;

/** Gzipped and raw first-load size per route, largest first. `web` is the apps/web directory. */
export function routeSizes(web: string): RouteSize[] {
  const stats = JSON.parse(
    readFileSync(join(web, ".next/diagnostics/route-bundle-stats.json"), "utf8"),
  ) as RouteStats[];
  return stats
    .map((r) => {
      let gz = 0;
      let raw = 0;
      for (const path of r.firstLoadChunkPaths) {
        const body = readFileSync(join(web, path));
        raw += body.length;
        gz += gzipSync(body, { level: 9 }).length;
      }
      return { route: r.route, gzipKB: kb(gz), rawKB: kb(raw), chunks: r.firstLoadChunkPaths.length };
    })
    .sort((a, b) => b.gzipKB - a.gzipKB);
}

function main(): void {
  const web = join(dirname(fileURLToPath(import.meta.url)), "..");
  const routes = routeSizes(web);
  const dashboard = routes.find((r) => r.route === DASHBOARD_ROUTE);
  if (dashboard === undefined) {
    console.error(`analyze: no ${DASHBOARD_ROUTE} in the build; run \`next build\` first`);
    process.exit(1);
  }
  if (process.argv.includes("--json")) {
    const out = {
      dashboardFirstLoadGzipKB: dashboard.gzipKB,
      budgetKB: DASHBOARD_BUDGET_KB,
      routes,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  for (const r of routes) {
    console.log(`${r.gzipKB.toFixed(1).padStart(7)} KB gz  ${r.rawKB.toFixed(1).padStart(8)} KB  ${r.route}`);
  }
  console.log(`dashboard ${String(dashboard.gzipKB)} KB gz (budget ${String(DASHBOARD_BUDGET_KB)} KB)`);
}

main();
