// The web process's one send-only pg-boss producer and outbox publisher (M1-04, shared in M1-07), built
// lazily on the first request that enqueues (never at build time).
import { correlationIdOrNew } from "@cleared/adapters";
import { createPublisher, createQueue, type Publisher } from "@cleared/db";
import { getDb } from "./deps.ts";

let pending: Promise<Publisher> | undefined;

export function getPublisher(): Promise<Publisher> {
  pending ??= createQueue(getDb(), { background: false, max: 2 })
    .then((boss) => createPublisher(getDb(), boss, correlationIdOrNew))
    .catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  return pending;
}
