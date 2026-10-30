// Request/job context carried across async calls (M1-03). A request sets it, `enqueue`/`emit` copy the
// correlation id into the job envelope, and the worker restores it before the handler runs, so every
// log line of one causal chain shares a correlationId.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface ObsContext {
  readonly correlationId: string;
  readonly workspaceId?: string;
  readonly messageId?: string;
}

const storage = new AsyncLocalStorage<ObsContext>();

/** Runs `fn` with `ctx` as the current context (nested calls see the innermost one). */
export function withContext<T>(ctx: ObsContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): ObsContext | undefined {
  return storage.getStore();
}

/** The current correlation id, or a new one when nothing set a context. */
export function correlationIdOrNew(): string {
  return storage.getStore()?.correlationId ?? randomUUID();
}
