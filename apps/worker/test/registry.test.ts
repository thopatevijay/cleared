// The production registry's shape (BL-01 6568052054): every domain event the code emits has a consumer,
// or its outbox row is never marked published and the relay re-sends it every minute.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMAIN_EVENT_TYPES } from "@cleared/core";
import type { Db, Queue } from "@cleared/db";
import { describe, expect, it } from "vitest";
import { aiFromEnv } from "../src/ai.ts";
import { paypalClientsFromEnv } from "../src/paypal.ts";
import { defaultRegistry } from "../src/registry.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Product source (tests excluded) that may emit domain events. */
const SOURCE_DIRS = ["apps/worker/src", "apps/web/app", "apps/web/src", "packages/adapters/src", "packages/db/src"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Domain event types that appear as an event literal (`type: "<event>"`) in product source. */
function emittedEventTypes(): string[] {
  const known = new Set<string>(DOMAIN_EVENT_TYPES);
  const found = new Set<string>();
  for (const file of SOURCE_DIRS.flatMap((d) => sourceFiles(join(ROOT, d)))) {
    for (const m of readFileSync(file, "utf8").matchAll(/\btype:\s*"([a-z_]+\.[a-z_]+)"/g)) {
      if (known.has(m[1] ?? "")) found.add(m[1] ?? "");
    }
  }
  return [...found].sort();
}

const registry = defaultRegistry(
  { db: {} as unknown as Db, boss: {} as unknown as Queue },
  paypalClientsFromEnv({}),
  aiFromEnv({}),
);
const queues = registry.map((r) => r.queue.name);

describe("default registry", () => {
  it("has a consumer for every domain event the product emits", () => {
    const emitted = emittedEventTypes();
    // the scan finds the emitters it must (outbox writers in the worker, db and adapters)
    expect(emitted).toEqual(expect.arrayContaining(["action.proposed", "evidence.added", "payment.captured"]));
    expect(emitted.filter((t) => !queues.includes(t))).toEqual([]);
  });

  // BL-01 6538667217: two `work()` calls on one queue would compete for its jobs (each job reaches one
  // of them), so a second consumer of e.g. `pack.checked` silently skips drafting for some packs.
  it("registers each queue once (a second consumer composes into the entry, never competes)", () => {
    expect(queues.filter((q, i) => queues.indexOf(q) !== i)).toEqual([]);
  });
});
