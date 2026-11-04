// `pnpm load:server-timing --routes payments,disputes-id,… --p95 400` (M4-08): the server-side time of the
// data routes on a local production build. It starts `next start` (the build must exist; nothing else is
// needed: the journey only reads), seeds `--sessions` loadtest workspaces on DATABASE_URL with the seed CLI,
// runs the launch-load session mix (`launch.ts` JOURNEY, 2–5 s think time) for `--minutes`, purges the
// workspaces and asserts each named route's p95. On loopback the client-side time is the server's time
// (the network adds well under 1 ms: see the healthz floor in the output), so this is the number to compare
// with Render's `durationMs`. Session tokens stay in this process. No PayPal, OpenAI or e-mail call is made.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lastJsonLine } from "../../packages/db/src/count.ts";
import type { LoadtestWorkspace } from "../../packages/db/src/loadtest.ts";
import { JOURNEY } from "./launch.ts";
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

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const web = join(root, "apps/web");
const COOKIE = "__Host-cleared_session";

/** `--routes` names → the journey's labels (the seven routes M4-06 measured over 800 ms in production). */
export const ROUTES: Readonly<Record<string, string>> = {
  payments: "GET /api/payments",
  "disputes-id": "GET /api/disputes/[id]",
  "packs-id": "GET /api/packs/[id]",
  holds: "GET /api/holds",
  "holds-id": "GET /api/holds/[id]",
  "page-holds-id": "page /en/holds/[id]",
  "page-pack": "page /en/payments/[id]/pack",
};

function seedCli(args: readonly string[]): Record<string, unknown> {
  const out = execFileSync("node", [join(root, "packages/db/src/seed.ts"), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  });
  return lastJsonLine(out);
}

function startWeb(port: number): Promise<ChildProcess> {
  const origin = `http://localhost:${String(port)}`;
  const child = spawn(join(web, "node_modules/.bin/next"), ["start", "-p", String(port)], {
    cwd: web,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PAYPAL_ENV: "sandbox",
      PAYPAL_CLIENT_ID: "timing-local-client",
      PAYPAL_CLIENT_SECRET: "timing-local-secret",
      PAYPAL_WEBHOOK_ID: "WH-TIMING-LOCAL",
      APP_BASE_URL: origin,
      SESSION_SECRET: randomBytes(32).toString("base64"),
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // `next start` forks `next-server`: stop the whole group
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("next start not ready in 120 s")), 120_000);
    const onData = (b: Buffer) => {
      if (/Ready in/.test(b.toString())) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`next start exited ${String(code)} before it was ready`));
    });
  });
}

async function session(origin: string, w: LoadtestWorkspace, endAt: number, rec: Recorder, seed: number) {
  let i = seed;
  await sleep(Math.random() * 3000);
  while (performance.now() < endAt) {
    const step = JOURNEY[i % JOURNEY.length];
    if (step === undefined) break;
    const r = await timedFetch(
      origin + step.path(w, Math.floor(i / JOURNEY.length)),
      { headers: { cookie: `${COOKIE}=${w.token}`, "user-agent": "cleared-load/M4-08" } },
      performance.now(),
    );
    rec.record(step.label, r.ms, r.status);
    i += 1;
    await sleep(2000 + Math.random() * 3000);
  }
}

/** The route names over the p95 budget (or with an error), with a line each. */
export function overBudget(rec: Recorder, names: readonly string[], p95: number): string[] {
  const byLabel = new Map(rec.routes().map((r) => [r.label, r]));
  return names.flatMap((n) => {
    const r = byLabel.get(ROUTES[n] ?? "");
    if (r === undefined) return [`${n}: no samples`];
    if (r.errors > 0) return [`${n}: ${String(r.errors)} error(s) ${JSON.stringify(r.statuses)}`];
    return r.p95 > p95 ? [`${n}: p95 ${r.p95.toFixed(1)} ms > ${String(p95)} ms`] : [];
  });
}

async function main(argv: readonly string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const names = flag(flags, "routes", Object.keys(ROUTES).join(",")).split(",");
  const unknown = names.filter((n) => ROUTES[n] === undefined);
  if (unknown.length > 0) throw new Error(`unknown route(s): ${unknown.join(", ")}`);
  const p95 = numFlag(flags, "p95", 400);
  const sessions = numFlag(flags, "sessions", 20);
  const minutes = numFlag(flags, "minutes", 2);
  const port = numFlag(flags, "port", 3400 + Number(process.env["PORT_OFFSET"] ?? 0));
  const out = flag(flags, "out", join(process.env["TMPDIR"] ?? "/tmp", "server-timing.json"));
  const origin = `http://localhost:${String(port)}`;
  const ws =
    (seedCli(["--loadtest", String(sessions)]) as { workspaces?: LoadtestWorkspace[] }).workspaces ?? [];
  const server = await startWeb(port);
  const rec = new Recorder(NOT_OK);
  const floor = new Recorder();
  const startedAt = new Date();
  try {
    if (ws.length !== sessions) throw new Error(`seed returned ${String(ws.length)} workspaces`);
    console.log(
      `load:server-timing: ${String(sessions)} sessions × ${String(minutes)} min against ${origin}`,
    );
    // one untimed pass of the journey per session, all sessions at once, so every route is loaded and the
    // database pool is at its working size, as in a production server that has been up (the timed run
    // measures steady state; `--no-warmup` measures a cold start)
    if (!flags.has("no-warmup"))
      await Promise.all(
        ws.map(async (w) => {
          for (const step of JOURNEY)
            await fetch(origin + step.path(w, 0), { headers: { cookie: `${COOKIE}=${w.token}` } });
        }),
      );
    const endAt = performance.now() + minutes * 60_000;
    await Promise.all(ws.map((w, n) => session(origin, w, endAt, rec, n)));
    for (let i = 0; i < 20; i += 1) {
      const r = await timedFetch(`${origin}/healthz`, {}, performance.now());
      floor.record("healthz (loopback floor)", r.ms, r.status);
    }
  } finally {
    if (server.pid !== undefined) process.kill(-server.pid, "SIGTERM");
    console.log(`load:server-timing: purged ${JSON.stringify(seedCli(["--purge", "loadtest"]))}`);
  }
  writeResult(out, {
    kind: "server-timing",
    target: origin,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    commit: commitSha(),
    params: { sessions, minutes, thinkTimeS: "2-5", journey: JOURNEY.length },
    overall: overallOf(rec),
    routes: [...rec.routes(), ...floor.routes()],
    notes: ["local production build on loopback: client time = server time"],
  });
  for (const r of [...rec.routes(), ...floor.routes()]) {
    const mark = Object.values(ROUTES).includes(r.label) ? "*" : " ";
    console.log(
      `${mark} ${r.label.padEnd(34)} n=${String(r.n).padStart(4)}  p50 ${r.p50.toFixed(1).padStart(6)}  p95 ${r.p95.toFixed(1).padStart(6)}  max ${r.max.toFixed(1).padStart(7)} ms`,
    );
  }
  const failed = overBudget(rec, names, p95);
  if (failed.length > 0) {
    console.error(`load:server-timing: FAIL (p95 ≤ ${String(p95)} ms)\n  ${failed.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`load:server-timing: PASS: ${names.join(", ")} p95 ≤ ${String(p95)} ms (written to ${out})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
