// Worker process (M0-08): connect to Postgres, start pg-boss, log `worker ready`, stop cleanly on
// SIGTERM. The consumers arrive in M1-03; until then the worker only proves it boots on the deploy.
import { databaseUrl } from "@cleared/db";

export interface Log {
  (line: Record<string, unknown>): void;
}

/** What the worker holds while it runs: the Postgres pool and pg-boss. */
export interface Resources {
  /** Stops pg-boss (graceful, bounded) and ends the pool. */
  stop(): Promise<void>;
}

/** Opens the pool, checks it answers, and starts pg-boss. */
export type Connect = (url: string) => Promise<Resources>;

export interface Worker {
  /** Idempotent: a second call returns the first call's promise. */
  stop(signal?: string): Promise<void>;
}

const SERVICE = "worker";

/** `RENDER_GIT_COMMIT` on Render; null elsewhere. */
export function commitOf(env: NodeJS.ProcessEnv): string | null {
  const commit = env["RENDER_GIT_COMMIT"];
  return commit ? commit : null;
}

export async function start(env: NodeJS.ProcessEnv, log: Log, connect: Connect): Promise<Worker> {
  const commit = commitOf(env);
  const resources = await connect(databaseUrl(env));
  log({ service: SERVICE, msg: "worker ready", commit });
  let stopping: Promise<void> | undefined;
  return {
    stop(signal) {
      stopping ??= (async () => {
        log({ service: SERVICE, msg: "worker stopping", commit, signal: signal ?? null });
        await resources.stop();
        log({ service: SERVICE, msg: "worker stopped", commit });
      })();
      return stopping;
    },
  };
}

/** `--dry-run` boots nothing: it proves the entry loads (M0-02 contract). */
export function dryRun(log: Log): number {
  log({ service: SERVICE, msg: "dry run: nothing to consume", dryRun: true });
  return 0;
}
