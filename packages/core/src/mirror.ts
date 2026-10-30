// Mirror-only state (Payment, PayPal-side Dispute): Cleared records what PayPal reports, never invents a
// state, and never trusts event order. A value from PayPal we don't know is kept verbatim, not coerced.
import { domainError, type DomainError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";
import { compareInstants, type Instant } from "./time.ts";

/** A PayPal enum value: one we know, or the raw string PayPal sent. */
export type Mirrored<T extends string> =
  { readonly kind: "known"; readonly value: T } | { readonly kind: "unrecognised"; readonly raw: string };

export function mirrorEnum<T extends string>(known: readonly T[], raw: string): Mirrored<T> {
  const match = known.find((k) => k === raw);
  return match === undefined ? { kind: "unrecognised", raw } : { kind: "known", value: match };
}

/** The raw PayPal string, whichever way it was mirrored. */
export function mirroredRaw(m: Mirrored<string>): string {
  return m.kind === "known" ? m.value : m.raw;
}

export interface MirrorRecord<T> {
  readonly value: T;
  /** PayPal's `update_time` of the resource this value came from. */
  readonly updateTime: Instant;
}

/**
 * Applies a freshly fetched PayPal resource over the stored one. An older `update_time` is rejected
 * (`stale_update`); an equal or newer one is accepted, so a replayed fetch is idempotent.
 */
export function applyMirror<T>(
  prev: MirrorRecord<T> | null,
  next: T,
  updateTime: Instant,
): Result<MirrorRecord<T>, DomainError> {
  if (prev !== null && compareInstants(updateTime, prev.updateTime) < 0) {
    return err(
      domainError("stale_update", "PayPal resource is older than the stored mirror", {
        storedUpdateTime: prev.updateTime,
        receivedUpdateTime: updateTime,
      }),
    );
  }
  return ok({ value: next, updateTime });
}
