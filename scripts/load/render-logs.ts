// Server-side request timings from Render's log stream (M4-06). The web logs one `request` line per route call
// with `durationMs` (and `webhook_ack_ms` on the webhook route; apps/web/src/server/with-route.ts), so the
// time the server spent can be told apart from the network between this machine and Oregon. Needs the
// `render` CLI logged in (the DEPLOY holder); returns null when it isn't available.
import { execFileSync } from "node:child_process";
import { Histogram, Recorder, sleep, timedFetch, type ServerTimings } from "./run.ts";

/** Sequential GET /healthz (no DB): the round trip to the target, recorded as `healthz (network floor)`. */
export async function networkFloor(target: string, rec: Recorder, n = 20): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const r = await timedFetch(`${target}/healthz`, {}, performance.now());
    rec.record("healthz (network floor)", r.ms, r.status);
    await sleep(100);
  }
}

/** Render's request log for remote targets only (its ingestion lags a few seconds). */
export async function serverTimingsFor(target: string, start: Date, end: Date): Promise<ServerTimings | null> {
  if (["localhost", "127.0.0.1"].includes(new URL(target).hostname)) return null;
  await sleep(15_000);
  return serverTimings(start, end);
}

/** cleared-web on Render (not a secret: `render services`). */
export const RENDER_WEB_SERVICE_ID = "srv-dbheesg473hc739p3g0g";

interface LogLine {
  readonly id: string;
  readonly timestamp: string;
  readonly message: string;
}

function page(service: string, start: string, end: string, text: string): LogLine[] {
  const out = execFileSync(
    "render",
    ["logs", "-r", service, "--start", start, "--end", end, "--text", text, "--direction", "forward", "--limit", "100", "-o", "json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 },
  );
  const lines: LogLine[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < out.length; i += 1) {
    const c = out[i];
    if (c === "{") {
      if (depth === 0) from = i;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) lines.push(JSON.parse(out.slice(from, i + 1)) as LogLine);
    } else if (c === '"') {
      for (i += 1; i < out.length && out[i] !== '"'; i += 1) if (out[i] === "\\") i += 1;
    }
  }
  return lines;
}

/** Every `request` line of `service` between start and end, grouped by route: durationMs percentiles. */
export function serverTimings(start: Date, end: Date, service = RENDER_WEB_SERVICE_ID): ServerTimings | null {
  const hist = new Map<string, Histogram>();
  const statuses = new Map<string, Record<string, number>>();
  const seen = new Set<string>();
  let cursor = start.toISOString();
  try {
    for (;;) {
      const batch = page(service, cursor, end.toISOString(), "durationMs");
      const fresh = batch.filter((l) => !seen.has(l.id));
      if (fresh.length === 0) break;
      for (const l of fresh) {
        seen.add(l.id);
        let m: { route?: string; status?: number; durationMs?: number };
        try {
          m = JSON.parse(l.message) as typeof m;
        } catch {
          continue;
        }
        if (m.route === undefined || m.durationMs === undefined) continue;
        const h = hist.get(m.route) ?? new Histogram();
        h.record(m.durationMs);
        hist.set(m.route, h);
        const s = statuses.get(m.route) ?? {};
        s[String(m.status)] = (s[String(m.status)] ?? 0) + 1;
        statuses.set(m.route, s);
      }
      cursor = batch.reduce((a, l) => (l.timestamp > a ? l.timestamp : a), cursor);
    }
  } catch {
    return null;
  }
  const byRoute: ServerTimings["byRoute"] = {};
  for (const [route, h] of hist) byRoute[route] = { ...h.summary(), statuses: statuses.get(route) ?? {} };
  return { source: `render logs ${service}`, byRoute };
}
