// Readiness (M1-08): `/readyz` is 200 only when the database answers, the pg-boss schema is reachable
// and a worker beat within the last 2 minutes (it beats every 30 s); otherwise 503. Each check has
// its own 2 s timeout and the three run in parallel, so the probe answers within about 2 s.
// Liveness is `/healthz` (no dependencies), which Render's health check keeps using.
import { pingDb, pingQueue, platform, type Db } from "@cleared/db";

export const CHECK_TIMEOUT_MS = 2_000;
export const HEARTBEAT_MAX_AGE_MS = 2 * 60_000;

export interface Readiness {
  readonly ok: boolean;
  readonly checks: { readonly db: boolean; readonly queue: boolean; readonly worker: boolean };
}

export interface ReadinessDeps {
  readonly db: Db;
  readonly now: () => Date;
  readonly timeoutMs?: number;
}

/** Resolves true when `probe` succeeds within `ms`; false on an error or a timeout. */
export async function within(probe: () => Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([probe().then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkReadiness(deps: ReadinessDeps): Promise<Readiness> {
  const ms = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
  const [db, queue, worker] = await Promise.all([
    within(() => pingDb(deps.db), ms),
    within(() => pingQueue(deps.db), ms),
    within(async () => {
      const beat = await platform(deps.db).workerHeartbeats.latest();
      if (beat === null || deps.now().getTime() - beat.beatAt.getTime() >= HEARTBEAT_MAX_AGE_MS) {
        throw new Error("no recent worker heartbeat");
      }
    }, ms),
  ]);
  return { ok: db && queue && worker, checks: { db, queue, worker } };
}

export async function readyzResponse(deps: ReadinessDeps): Promise<Response> {
  const r = await checkReadiness(deps);
  return Response.json(r, { status: r.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
