// Worker process (M0-08, M1-03): connect to Postgres, start pg-boss with the registry's consumers, log
// `worker ready`, and stop gracefully on SIGTERM (in-flight jobs finish first).
import type { Logger } from "@cleared/adapters";
import { databaseUrl } from "@cleared/db";

/** What the worker holds while it runs: the Postgres pool and pg-boss with its consumers. */
export interface Resources {
  /** Stops pg-boss (graceful, bounded: in-flight jobs complete) and ends the pool. */
  stop(): Promise<void>;
}

/** Opens the pool, checks it answers, starts pg-boss and registers the consumers. */
export type Connect = (url: string) => Promise<Resources>;

export interface Worker {
  /** Idempotent: a second call returns the first call's promise. */
  stop(signal?: string): Promise<void>;
}

/** `RENDER_GIT_COMMIT` on Render; null elsewhere. */
export function commitOf(env: NodeJS.ProcessEnv): string | null {
  const commit = env["RENDER_GIT_COMMIT"];
  return commit ? commit : null;
}

export async function start(env: NodeJS.ProcessEnv, log: Logger, connect: Connect): Promise<Worker> {
  const commit = commitOf(env);
  const resources = await connect(databaseUrl(env));
  log.info({ commit }, "worker ready");
  let stopping: Promise<void> | undefined;
  return {
    stop(signal) {
      stopping ??= (async () => {
        log.info({ commit, signal: signal ?? null }, "worker stopping");
        await resources.stop();
        log.info({ commit }, "worker stopped");
      })();
      return stopping;
    },
  };
}

/** `--dry-run` boots nothing: it proves the entry loads (M0-02 contract). */
export function dryRun(log: Logger): number {
  log.info({ dryRun: true }, "dry run: nothing to consume");
  return 0;
}
