// Worker heartbeat (M1-08): upserts `worker_heartbeats(worker_id, beat_at)` at start and every 30 s.
// The web's `/readyz` reports `worker:false` when the newest beat is 2 minutes old or more. A failed
// beat is logged and retried on the next tick; it never stops the worker.
import { hostname } from "node:os";
import type { Logger } from "@cleared/adapters";
import { platform, type Db } from "@cleared/db";

export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Render's instance id when present, else host and pid (stable for the process). */
export function workerIdOf(env: NodeJS.ProcessEnv = process.env): string {
  return env["RENDER_INSTANCE_ID"] ?? `${hostname()}:${String(process.pid)}`;
}

export interface HeartbeatOptions {
  readonly db: Db;
  readonly log: Logger;
  readonly workerId?: string;
  readonly intervalMs?: number;
  readonly now?: () => Date;
}

export interface Heartbeat {
  /** Resolves once the first beat is written (or failed). */
  readonly first: Promise<void>;
  stop(): void;
}

export function startHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const workerId = opts.workerId ?? workerIdOf();
  const now = opts.now ?? (() => new Date());
  const repo = platform(opts.db).workerHeartbeats;
  const beat = async (): Promise<void> => {
    try {
      await repo.beat(workerId, now());
    } catch (error) {
      opts.log.warn({ workerId, error: String(error) }, "worker heartbeat failed");
    }
  };
  const first = beat();
  const timer = setInterval(() => void beat(), opts.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    first,
    stop() {
      clearInterval(timer);
    },
  };
}
