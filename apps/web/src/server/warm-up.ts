// BL-01 6609550494: the first app-route request after `next start` loads the server's route and database
// chunks (~250 ms locally, measured; slower on Render's shared CPU), and every request that arrives meanwhile
// waits on it. Render's health check (/healthz) loads none of them. So at boot the server pings its own
// /readyz (read-only, already public) once it listens, which loads them before real traffic does.
// Best effort: it never throws, and gives up quietly after `tries` attempts.

export interface WarmUpOptions {
  readonly fetch?: (url: string) => Promise<unknown>;
  readonly tries?: number;
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The self-ping URL for a production `next start`, or null where no warm-up should run. */
export function warmUpUrl(env: NodeJS.ProcessEnv): string | null {
  if (env["NODE_ENV"] !== "production") return null;
  const port = env["PORT"] ?? "3000";
  return /^\d{1,5}$/.test(port) ? `http://127.0.0.1:${port}/readyz` : null;
}

/** Retries until the server answers (any status counts: a 503 has loaded the chunks too). */
export async function warmUp(url: string, opts: WarmUpOptions = {}): Promise<boolean> {
  const get = opts.fetch ?? ((u: string) => fetch(u, { signal: AbortSignal.timeout(10_000) }));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tries = opts.tries ?? 40;
  for (let i = 0; i < tries; i += 1) {
    try {
      await get(url);
      return true;
    } catch {
      await sleep(opts.delayMs ?? 250);
    }
  }
  return false;
}
