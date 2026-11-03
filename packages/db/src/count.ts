// `pnpm db:count --tag loadtest [--target production]` (M4-06): prints how many workspaces carry the tag.
// Local: counts on DATABASE_URL. `--target production`: the production database is private (render.yaml
// ipAllowList: []), so the same command runs on the worker over `render ssh` (owner-approved for the seed
// and pool CLIs) and its answer is printed here.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { closeDb, createDb, databaseUrl } from "./client.ts";
import { countLoadtestWorkspaces, LOADTEST_TAG } from "./loadtest.ts";

/** cleared-worker on Render (not a secret: the service id `render services` lists). */
export const RENDER_WORKER_SERVICE_ID = "srv-dbhehn0473hc739paf3g";

/** Runs `node packages/db/src/<script> <args>` on the production worker and returns its stdout. */
export function onProduction(script: string, args: readonly string[]): string {
  const cmd = ["node", `packages/db/src/${script}`, ...args].join(" ");
  if (!/^[\w ./-]+$/.test(cmd)) throw new Error("refusing a remote command with shell characters");
  // the remote stderr is merged into stdout: `render ssh -o text` doesn't carry it, so a remote failure
  // (M4-06 purge, 2026-11-03) was otherwise silent. The caller's error then holds it in `stdout`.
  return execFileSync(
    "render",
    ["ssh", RENDER_WORKER_SERVICE_ID, "--confirm", "-o", "text", "--", `${cmd} 2>&1`],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

/** The last line of `out` that parses as a JSON object (render ssh may print banners around it). */
export function lastJsonLine(out: string): Record<string, unknown> {
  for (const line of out.trim().split("\n").reverse()) {
    try {
      const v = JSON.parse(line.trim()) as unknown;
      if (typeof v === "object" && v !== null) return v as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  throw new Error("no JSON line in the remote output");
}

async function main(argv: readonly string[]): Promise<void> {
  const i = argv.indexOf("--tag");
  const tag = i === -1 ? undefined : argv[i + 1];
  if (tag !== LOADTEST_TAG) throw new Error(`usage: count.ts --tag ${LOADTEST_TAG} [--target production]`);
  const t = argv.indexOf("--target");
  if (t !== -1 && argv[t + 1] === "production") {
    const r = lastJsonLine(onProduction("count.ts", ["--tag", tag]));
    console.log(JSON.stringify({ target: "production", tag, count: r["count"] }));
    console.log(String(r["count"]));
    if (r["count"] !== 0) process.exitCode = 1;
    return;
  }
  const db = createDb(databaseUrl());
  try {
    const count = await countLoadtestWorkspaces(db);
    console.log(JSON.stringify({ tag, count }));
    console.log(String(count));
  } finally {
    await closeDb(db);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
