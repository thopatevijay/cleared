// What a goods hold shows about tracking (M3-03; dashboard.md elements 10–12, hold.md action slot): the
// route advice for the chosen carrier (the tracking action's, else the one in the shipment evidence),
// where the tracking action stands, and the form prefill. Pure: the web layer passes the rows in.
import { z } from "zod";
import { AddTrackingPayloadSchema } from "../actions/policy.ts";
import type { ActionState } from "../actions/state.ts";
import { adviseRoute, carrierDisplayName } from "./advice.ts";
import { countryFromTimeZone } from "./countries.ts";
import { CARRIER_TIERS, matchCarrier, OTHER_CARRIER, type TierSource } from "./tiers.ts";

export const TRACKING_STATES = ["none", "proposed", "filing", "filed", "failed"] as const;
export type TrackingState = (typeof TRACKING_STATES)[number];

const TierSourceSchema = z.object({
  title: z.string().min(1),
  url: z.url().nullable(),
  date: z.iso.date(),
  note: z.string().optional(),
});

const CarrierRefSchema = z.object({ code: z.string().min(1), name: z.string().min(1) });

export const TrackingPrefillSchema = z.object({
  carrier: z.string().min(1),
  carrier_name_other: z.string().optional(),
  tracking_number: z.string(),
});
export type TrackingPrefill = z.infer<typeof TrackingPrefillSchema>;

export const TrackingSummarySchema = z.object({
  state: z.enum(TRACKING_STATES),
  /** the latest `add_tracking` action on the capture */
  actionId: z.uuid().nullable(),
  chosen: CarrierRefSchema.extend({ tier: z.enum(CARRIER_TIERS) }).nullable(),
  /** ISO alpha-2 the alternatives are for */
  country: z.string().nullable(),
  /** the chosen carrier is accepted / other: show the advice line */
  flagged: z.boolean(),
  /** approved carriers for the country, featured first (display names) */
  alternatives: z.array(CarrierRefSchema),
  sources: z.object({ approved: TierSourceSchema, accepted: TierSourceSchema }),
  prefill: TrackingPrefillSchema.nullable(),
});
export type TrackingSummary = z.infer<typeof TrackingSummarySchema>;

export interface TrackingInputs {
  readonly holdState: string;
  readonly action: {
    readonly id: string;
    readonly state: ActionState;
    readonly payload: unknown;
  } | null;
  /** the newest shipment fact in the payment's proof pack (M2-03) */
  readonly shipment: { readonly carrier: string; readonly tracking_number: string } | null;
  readonly timeZone: string;
}

function stateOf(holdState: string, action: TrackingInputs["action"]): TrackingState {
  if (holdState === "filed" || holdState === "still_held" || action?.state === "succeeded") return "filed";
  switch (action?.state) {
    case "proposed":
      return "proposed";
    case "approved":
    case "executing":
    case "unknown":
      return "filing";
    case "failed":
      return "failed";
    default:
      return "none";
  }
}

const TRACKING_NUMBER = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

function prefillOf(i: TrackingInputs): TrackingPrefill | null {
  const p = AddTrackingPayloadSchema.safeParse(i.action?.payload);
  if (p.success) {
    const { carrier, carrier_name_other: other, tracking_number } = p.data;
    return { carrier, ...(other === undefined ? {} : { carrier_name_other: other }), tracking_number };
  }
  if (i.shipment === null) return null;
  const m = matchCarrier(i.shipment.carrier);
  const n = i.shipment.tracking_number.replace(/\s+/g, "");
  return {
    carrier: m.code,
    ...(m.nameOther === undefined ? {} : { carrier_name_other: m.nameOther }),
    tracking_number: TRACKING_NUMBER.test(n) ? n : "",
  };
}

const source = (s: TierSource) => ({
  title: s.title,
  url: s.url,
  date: s.date,
  ...(s.note === undefined ? {} : { note: s.note }),
});

export function trackingSummary(i: TrackingInputs): TrackingSummary {
  const prefill = prefillOf(i);
  const chosen =
    prefill === null
      ? undefined
      : {
          code: prefill.carrier,
          ...(prefill.carrier_name_other === undefined ? {} : { nameOther: prefill.carrier_name_other }),
        };
  const a = adviseRoute(countryFromTimeZone(i.timeZone), chosen);
  // the seller's own country wins; with none known, the chosen carrier's country (adviseRoute) is used
  const c = a.chosen;
  return {
    state: stateOf(i.holdState, i.action),
    actionId: i.action?.id ?? null,
    chosen:
      c === null
        ? null
        : {
            code: c.code,
            name: c.code === OTHER_CARRIER ? c.name : carrierDisplayName(c.name),
            tier: c.tier,
          },
    country: a.country,
    flagged: a.flagged,
    alternatives: a.alternatives.map((x) => ({ code: x.code, name: carrierDisplayName(x.name) })),
    sources: { approved: source(a.sources.approved), accepted: source(a.sources.accepted) },
    prefill,
  };
}
