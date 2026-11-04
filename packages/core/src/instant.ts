// The zod-free half of time.ts (M4-08): browser code that only needs Instant arithmetic (hold rules, the
// dispute deadline) must not pull zod into a page's first load. time.ts re-exports all of it.
import type { z } from "zod";

/** Same type as `z.infer<typeof InstantSchema>` (a branded string); InstantSchema stays in time.ts. */
export type Instant = string & z.$brand<"Instant">;

export function fromEpochMs(ms: number): Instant {
  return new Date(ms).toISOString() as Instant;
}

export function toEpochMs(instant: Instant): number {
  return Date.parse(instant);
}

/** Negative when a is earlier than b, zero when equal, positive when later. */
export function compareInstants(a: Instant, b: Instant): number {
  return toEpochMs(a) - toEpochMs(b);
}

export function addMinutes(instant: Instant, minutes: number): Instant {
  return fromEpochMs(toEpochMs(instant) + minutes * 60_000);
}
