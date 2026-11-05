// Review-hold pool (M3-10, ADR 0019): pre-staged PayPal-wallet payments that a buyer approved in a browser,
// held by PayPal for payment review (`PENDING / PENDING_REVIEW`, about 24 h). Pure rules only: the
// outcome of a capture, whether a pool row may be assigned, its expected release, and the synthetic
// catalogue the orders are priced from. The tables and PayPal calls live in db / worker.
import { addMinutes, toEpochMs, type Instant } from "../time.ts";
import { holdRule, type HoldEstimate } from "./rules.ts";

export const REVIEW_POOL_PURPOSES = ["judge", "video"] as const;
export type ReviewPoolPurpose = (typeof REVIEW_POOL_PURPOSES)[number];

/** `awaiting_buyer` → `held` | `not_held` (recorded, never retried); `held` → `released` (PayPal released it). */
export const REVIEW_POOL_STATES = ["awaiting_buyer", "held", "not_held", "released"] as const;
export type ReviewPoolState = (typeof REVIEW_POOL_STATES)[number];

/** A held pool payment is assigned only while it is younger than this (it releases about 24 h after capture). */
export const REVIEW_POOL_MAX_AGE_HOURS = 20;

/** The rule every pool hold is explained and estimated with (`rules.ts`). */
export const REVIEW_POOL_RULE_ID = "payment_review";

/** The capture PayPal returned decides the row: only `PENDING / PENDING_REVIEW` is a review hold. */
export function poolCaptureOutcome(status: string, reason: string | null): "held" | "not_held" {
  return status === "PENDING" && reason === "PENDING_REVIEW" ? "held" : "not_held";
}

export type PoolRefusal = "not_pool_owned" | "not_held" | "released" | "too_old" | "already_assigned";

export interface PoolCandidate {
  readonly state: ReviewPoolState;
  readonly poolWorkspaceId: string;
  /** the workspace `paypal_resource_owner` names for the capture now */
  readonly ownerWorkspaceId: string | null;
  readonly assignedWorkspaceId: string | null;
  readonly capturedAt: Instant | null;
  /** the payments mirror's capture status (PayPal's value), null when not mirrored yet */
  readonly mirrorStatus: string | null;
}

/** Why a pool row may not be assigned now, or null when it may (checked again under the row lock). */
export function poolRefusal(c: PoolCandidate, now: Instant): PoolRefusal | null {
  if (c.ownerWorkspaceId !== c.poolWorkspaceId) return "not_pool_owned";
  if (c.assignedWorkspaceId !== null) return "already_assigned";
  if (c.state === "released" || (c.mirrorStatus !== null && c.mirrorStatus !== "PENDING")) return "released";
  if (c.state !== "held" || c.capturedAt === null) return "not_held";
  if (toEpochMs(now) - toEpochMs(c.capturedAt) >= REVIEW_POOL_MAX_AGE_HOURS * 3_600_000) return "too_old";
  return null;
}

/** PayPal's payment review lasts about 24 h from capture: the `payment_review` rule's estimate. */
export function poolExpectedRelease(capturedAt: Instant): HoldEstimate | null {
  return holdRule(REVIEW_POOL_RULE_ID)?.estimate(capturedAt) ?? null;
}

/** The latest capture time that is still assignable at `now`. */
export function poolAssignableSince(now: Instant): Instant {
  return addMinutes(now, -REVIEW_POOL_MAX_AGE_HOURS * 60);
}

/** Synthetic catalogue (data policy: no real personal data). Amounts in USD, the sandbox buyer's currency. */
export const REVIEW_POOL_CATALOGUE = [
  { description: "Logo design, 3 concepts", value: "64.00" },
  { description: "Website copy edit, 2 pages", value: "48.00" },
  { description: "Hand-dyed scarf", value: "37.50" },
  { description: "Product photo retouch, 10 images", value: "72.00" },
] as const;

export function poolCatalogueItem(i: number): (typeof REVIEW_POOL_CATALOGUE)[number] {
  const item = REVIEW_POOL_CATALOGUE[i % REVIEW_POOL_CATALOGUE.length];
  if (item === undefined) throw new Error("empty catalogue");
  return item;
}
