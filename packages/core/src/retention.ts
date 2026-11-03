// Demo-data retention (M4-07, ADR 0020; ADR 0007, architecture §5). Pure: the purge job reads the
// workspaces and asks this module which ones are due.
// - A demo workspace created before 2026-12-16 expires then (the judging cohort); one created later lives
//   7 days from its creation.
// - It is purged 6 days after it expires: 2026-12-22 for the judging cohort.
// - A seller workspace is never purged automatically.
import { DEMO_WORKSPACE_EXPIRES_AT, type WorkspaceKind } from "./accounts/workspace.ts";
import { addMinutes, compareInstants, type Instant } from "./time.ts";

/** A demo workspace created on or after the cohort expiry lives this long. */
export const LATE_DEMO_LIFETIME_DAYS = 7;
/** Days between a demo workspace's expiry and its purge. */
export const PURGE_GRACE_DAYS = 6;
/** The daily retention purge, 04:00 UTC (after the 03:00 synthetic run). */
export const RETENTION_PURGE_CRON = "0 4 * * *";

const DAY_MINUTES = 24 * 60;

export interface RetentionSubject {
  readonly kind: WorkspaceKind;
  readonly createdAt: Instant;
  /** the stored expiry; a demo workspace without one falls back to `demoExpiresAt(createdAt)` */
  readonly expiresAt: Instant | null;
}

export interface Retention {
  readonly expiresAt: Instant;
  readonly purgeAt: Instant;
}

/** The expiry a demo workspace gets at creation. */
export function demoExpiresAt(createdAt: Instant): Instant {
  return compareInstants(createdAt, DEMO_WORKSPACE_EXPIRES_AT) < 0
    ? DEMO_WORKSPACE_EXPIRES_AT
    : addMinutes(createdAt, LATE_DEMO_LIFETIME_DAYS * DAY_MINUTES);
}

/** When an expired demo workspace is purged. */
export function purgeAt(expiresAt: Instant): Instant {
  return addMinutes(expiresAt, PURGE_GRACE_DAYS * DAY_MINUTES);
}

/** A workspace's expiry and purge instants, or null for a seller workspace (never purged automatically). */
export function retentionOf(ws: RetentionSubject): Retention | null {
  if (ws.kind !== "demo") return null;
  const expiresAt = ws.expiresAt ?? demoExpiresAt(ws.createdAt);
  return { expiresAt, purgeAt: purgeAt(expiresAt) };
}

/** True once `now ≥ expires_at + 6 days` for a demo workspace; always false for a seller workspace. */
export function isPurgeDue(ws: RetentionSubject, now: Instant): boolean {
  const r = retentionOf(ws);
  return r !== null && compareInstants(now, r.purgeAt) >= 0;
}
