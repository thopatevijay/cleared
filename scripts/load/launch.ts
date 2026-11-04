// `pnpm load:launch --target <url> --sessions 20 --minutes 10 --out <file.json>` (M4-06): the launch-load
// scenario. N judge-like sessions, each in its own `loadtest` workspace created server-side by the seed CLI
// (`seed.ts --loadtest N`: on the worker over `render ssh` for a remote target, on DATABASE_URL for
// localhost), browse the dashboard, payment, pack, hold and dispute pages and their read APIs with a 2–5 s
// think time. Nothing it calls writes, runs AI or calls PayPal. The workspaces are purged at the end, also
// on failure. Session tokens stay in this process: never printed or written.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lastJsonLine, onProduction } from "../../packages/db/src/count.ts";
import type { LoadtestWorkspace } from "../../packages/db/src/loadtest.ts";
import {
  commitSha,
  flag,
  NOT_OK,
  numFlag,
  overallOf,
  parseArgs,
  Recorder,
  sleep,
  timedFetch,
  writeResult,
} from "./run.ts";
import { networkFloor, serverTimingsFor } from "./render-logs.ts";

const COOKIE = "__Host-cleared_session";

interface Step {
  readonly label: string;
  readonly path: (w: LoadtestWorkspace, i: number) => string;
}

const pick = (ids: readonly string[], i: number): string => ids[i % ids.length] ?? "";

/** One judge's loop: the dashboard, then each kind of detail page with the API it reads. */
export const JOURNEY: readonly Step[] = [
  { label: "page /en/payments (dashboard)", path: () => "/en/payments" },
  { label: "GET /api/payments", path: () => "/api/payments" },
  { label: "page /en/payments/[id]/pack", path: (w, i) => `/en/payments/${pick(w.paymentIds, i)}/pack` },
  { label: "GET /api/packs/[id]", path: (w, i) => `/api/packs/${pick(w.packIds, i)}` },
  { label: "page /en/holds", path: () => "/en/holds" },
  { label: "GET /api/holds", path: () => "/api/holds" },
  { label: "page /en/holds/[id]", path: (w, i) => `/en/holds/${pick(w.holdIds, i)}` },
  { label: "GET /api/holds/[id]", path: (w, i) => `/api/holds/${pick(w.holdIds, i)}` },
  { label: "page /en/disputes", path: () => "/en/disputes" },
  { label: "GET /api/disputes", path: () => "/api/disputes" },
  { label: "page /en/disputes/[id]", path: (w, i) => `/en/disputes/${pick(w.disputeIds, i)}` },
  { label: "GET /api/disputes/[id]", path: (w, i) => `/api/disputes/${pick(w.disputeIds, i)}` },
  { label: "GET /api/notifications", path: () => "/api/notifications" },
];

const isLocal = (target: string): boolean => ["localhost", "127.0.0.1"].includes(new URL(target).hostname);

/** Runs a db CLI (`seed.ts …`) where the target's database is, and returns its last JSON line. */
function dbCli(target: string, script: string, args: readonly string[]): Record<string, unknown> {
  if (!isLocal(target)) return lastJsonLine(onProduction(script, args));
  const out = execFileSync(
    "node",
    [fileURLToPath(new URL(`../../packages/db/src/${script}`, import.meta.url)), ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return lastJsonLine(out);
}

async function session(
  target: string,
  w: LoadtestWorkspace,
  endAt: number,
  rec: Recorder,
  seed: number,
): Promise<void> {
  let i = seed;
  await sleep(Math.random() * 3000);
  while (performance.now() < endAt) {
    const step = JOURNEY[i % JOURNEY.length];
    if (step === undefined) break;
    const r = await timedFetch(
      target + step.path(w, Math.floor(i / JOURNEY.length)),
      { headers: { cookie: `${COOKIE}=${w.token}`, "user-agent": "cleared-load/M4-06" } },
      performance.now(),
    );
    rec.record(step.label, r.ms, r.status);
    i += 1;
    await sleep(2000 + Math.random() * 3000);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const target = flag(flags, "target").replace(/\/$/, "");
  const sessions = numFlag(flags, "sessions", 20);
  const minutes = numFlag(flags, "minutes", 10);
  const out = flag(flags, "out");
  const notes: string[] = [];
  const created = dbCli(target, "seed.ts", ["--loadtest", String(sessions)]) as {
    workspaces?: LoadtestWorkspace[];
  };
  const ws = created.workspaces ?? [];
  if (ws.length !== sessions)
    throw new Error(`seed returned ${String(ws.length)} workspaces, expected ${String(sessions)}`);
  console.log(
    `load:launch: ${String(ws.length)} loadtest workspaces seeded; ${String(minutes)} min against ${target}`,
  );
  const rec = new Recorder(NOT_OK);
  const startedAt = new Date();
  // The measurement is written BEFORE the purge (M4-06, 2026-11-03: a failed purge used to lose the run).
  try {
    const endAt = performance.now() + minutes * 60_000;
    await Promise.all(ws.map((w, n) => session(target, w, endAt, rec, n)));
    const endedAt = new Date();
    const floor = new Recorder();
    await networkFloor(target, floor);
    const server = await serverTimingsFor(target, startedAt, endedAt);
    writeResult(out, {
      kind: "launch",
      target,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      commit: commitSha(),
      params: { sessions, minutes, thinkTimeS: "2-5", journey: JOURNEY.length },
      overall: overallOf(rec),
      routes: [...rec.routes(), ...floor.routes()],
      ...(server === null ? {} : { server }),
      notes,
    });
  } finally {
    purge(target);
  }
}

/** Purges the run's workspaces; on failure prints the CLI's own output (the remote error) and exits 1. */
function purge(target: string): void {
  try {
    console.log(`load:launch: purged ${JSON.stringify(dbCli(target, "seed.ts", ["--purge", "loadtest"]))}`);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    console.error(`load:launch: PURGE FAILED: ${err.message ?? String(e)}`);
    console.error(
      [err.stdout, err.stderr]
        .filter((s) => s !== undefined && s !== "")
        .join("\n")
        .slice(-4000),
    );
    console.error(
      "load:launch: loadtest workspaces are left; run `seed.ts --purge loadtest` once the cause is fixed",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
