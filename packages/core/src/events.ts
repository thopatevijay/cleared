// Domain events (architecture §2 / §6): the outbox payloads. Each carries `version: 1`; a breaking change
// to an event's data adds a new version, never edits this one. PayPal states travel as PayPal's raw strings.
import { z } from "zod";
import { ACTION_KINDS } from "./actions/action.ts";
import {
  ActionIdSchema,
  CaptureIdSchema,
  DisputeIdSchema,
  EvidenceItemIdSchema,
  HoldIdSchema,
  OrderIdSchema,
  ProofPackIdSchema,
  Sha256Schema,
  WorkspaceIdSchema,
} from "./ids.ts";
import { MoneySchema } from "./money.ts";
import { SYNC_SOURCES } from "./payments/payment.ts";
import { EVIDENCE_KINDS } from "./proof/evidence.ts";
import { InstantSchema } from "./time.ts";

const paypalState = z.object({ status: z.string().min(1), reason: z.string().min(1).nullable() });

function event<T extends string, D extends z.ZodRawShape>(type: T, data: D) {
  return z.object({
    type: z.literal(type),
    version: z.literal(1),
    workspaceId: WorkspaceIdSchema,
    occurredAt: InstantSchema,
    data: z.object(data),
  });
}

export const PaymentCapturedEvent = event("payment.captured", {
  captureId: CaptureIdSchema,
  orderId: OrderIdSchema.nullable(),
  amount: MoneySchema,
  state: paypalState,
});
export const PaymentStatusChangedEvent = event("payment.status_changed", {
  captureId: CaptureIdSchema,
  from: paypalState,
  to: paypalState,
  source: z.enum(SYNC_SOURCES),
  updateTime: InstantSchema,
});
export const EvidenceAddedEvent = event("evidence.added", {
  packId: ProofPackIdSchema,
  evidenceItemId: EvidenceItemIdSchema,
  kind: z.enum(EVIDENCE_KINDS),
  sha256: Sha256Schema,
});
/** M2-03: an item's facts were written (with this row, same tx); M2-04's scope check runs on it. */
export const PackExtractedEvent = event("pack.extracted", {
  packId: ProofPackIdSchema,
  evidenceItemId: EvidenceItemIdSchema,
  factsId: z.uuid(),
  runId: z.uuid(),
});
export const PackCheckedEvent = event("pack.checked", {
  packId: ProofPackIdSchema,
  checkedAt: InstantSchema,
});
export const HoldOpenedEvent = event("hold.opened", {
  holdId: HoldIdSchema,
  captureId: CaptureIdSchema,
  reason: z.string().min(1),
});
export const HoldReleasedEvent = event("hold.released", {
  holdId: HoldIdSchema,
  captureId: CaptureIdSchema,
  releasedAt: InstantSchema,
});
export const DisputeOpenedEvent = event("dispute.opened", {
  disputeId: DisputeIdSchema,
  captureId: CaptureIdSchema.nullable(),
  status: z.string().min(1),
  sellerResponseDueDate: InstantSchema.nullable(),
});
export const DisputeStatusChangedEvent = event("dispute.status_changed", {
  disputeId: DisputeIdSchema,
  from: z.string().min(1),
  to: z.string().min(1),
  source: z.enum(SYNC_SOURCES),
  updateTime: InstantSchema,
});
const actionRef = { actionId: ActionIdSchema, kind: z.enum(ACTION_KINDS) };
/** M2-02: the agent harness wrote a proposal (with this outbox row, one transaction). */
export const ActionProposedEvent = event("action.proposed", {
  ...actionRef,
  payloadSha256: Sha256Schema,
  runId: z.uuid(),
});
export const ActionApprovedEvent = event("action.approved", {
  ...actionRef,
  payloadSha256: Sha256Schema,
  approvedBy: z.string().min(1),
});
export const ActionExecutedEvent = event("action.executed", {
  ...actionRef,
  paypalDebugId: z.string().nullable(),
});
export const ActionFailedEvent = event("action.failed", {
  ...actionRef,
  paypalDebugId: z.string().nullable(),
  reason: z.string().min(1),
});
export const ActionUnknownEvent = event("action.unknown", { ...actionRef });

export const DomainEventSchema = z.discriminatedUnion("type", [
  PaymentCapturedEvent,
  PaymentStatusChangedEvent,
  EvidenceAddedEvent,
  PackExtractedEvent,
  PackCheckedEvent,
  HoldOpenedEvent,
  HoldReleasedEvent,
  DisputeOpenedEvent,
  DisputeStatusChangedEvent,
  ActionProposedEvent,
  ActionApprovedEvent,
  ActionExecutedEvent,
  ActionFailedEvent,
  ActionUnknownEvent,
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type DomainEventType = DomainEvent["type"];
export type EventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;

export const DOMAIN_EVENT_TYPES = DomainEventSchema.options.map((o) => o.shape.type.value);
