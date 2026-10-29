// One circuit breaker per client (ADR 0011). It counts only timeouts, network errors, 5xx and 429;
// a 4xx is the caller's problem, not the vendor's. Consecutive counted failures >= threshold → open;
// after the cool-down one trial call is let through (half-open): success closes, failure re-opens.

export interface BreakerOptions {
  readonly threshold: number;
  readonly cooldownMs: number;
  readonly now: () => number;
}

export type BreakerState = "closed" | "open" | "half-open";

export interface Breaker {
  allow(): { ok: true } | { ok: false; retryAt: number };
  record(failed: boolean): void;
  state(): BreakerState;
}

export function createBreaker(partial: Partial<BreakerOptions> = {}): Breaker {
  const opts: BreakerOptions = {
    threshold: partial.threshold ?? 5,
    cooldownMs: partial.cooldownMs ?? 30_000,
    now: partial.now ?? Date.now,
  };
  let failures = 0;
  let openedAt: number | undefined;
  let trialInFlight = false;

  function state(): BreakerState {
    if (openedAt === undefined) return "closed";
    return opts.now() - openedAt >= opts.cooldownMs ? "half-open" : "open";
  }

  return {
    state,
    allow() {
      const s = state();
      if (s === "closed") return { ok: true };
      if (s === "half-open" && !trialInFlight) {
        trialInFlight = true;
        return { ok: true };
      }
      return { ok: false, retryAt: (openedAt ?? 0) + opts.cooldownMs };
    },
    record(failed) {
      trialInFlight = false;
      if (!failed) {
        failures = 0;
        openedAt = undefined;
        return;
      }
      failures += 1;
      if (openedAt !== undefined || failures >= opts.threshold) openedAt = opts.now();
    },
  };
}
