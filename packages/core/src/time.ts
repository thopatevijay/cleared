// Instant: a UTC ISO-8601 timestamp in the canonical `toISOString()` form (`2026-10-29T04:57:06.000Z`).
// PayPal sends `…Z` with or without milliseconds; parseInstant normalises, so equal instants are equal strings.
// The arithmetic lives in instant.ts (no zod) so browser code can use it without loading zod (M4-08).
import { z } from "zod";
import { domainError, type DomainError } from "./errors.ts";
import { fromEpochMs, type Instant } from "./instant.ts";
import { err, ok, type Result } from "./result.ts";

export { addMinutes, compareInstants, fromEpochMs, toEpochMs, type Instant } from "./instant.ts";

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function isCanonical(raw: string): boolean {
  const ms = Date.parse(raw);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === raw;
}

export const InstantSchema = z.string().refine(isCanonical, "not a canonical UTC instant").brand<"Instant">();

export function parseInstant(raw: string): Result<Instant, DomainError> {
  const ms = ISO_WITH_ZONE.test(raw) ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(ms))
    return err(domainError("invalid_instant", "not an ISO-8601 instant with a zone", { raw }));
  return ok(fromEpochMs(ms));
}
