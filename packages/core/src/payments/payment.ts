// Payment: Cleared's mirror of one PayPal capture, owned by one workspace.
import type { CaptureId, OrderId, WorkspaceId } from "../ids.ts";
import type { Money } from "../money.ts";
import type { Instant } from "../time.ts";
import type { PaymentState } from "./capture.ts";

/** Where a mirrored change came from: every change records its source (architecture §2). */
export const SYNC_SOURCES = ["webhook", "poll"] as const;
export type SyncSource = (typeof SYNC_SOURCES)[number];

export interface Payment {
  readonly workspaceId: WorkspaceId;
  readonly captureId: CaptureId;
  readonly orderId: OrderId | null;
  readonly amount: Money;
  readonly receivable: Money | null;
  readonly state: PaymentState;
  /** PayPal's update_time of the capture this state came from */
  readonly updateTime: Instant;
  readonly source: SyncSource;
  readonly syncedAt: Instant;
}
