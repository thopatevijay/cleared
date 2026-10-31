"use client";
// The seller's draft edit (dispute-review.md "Interactions"): POST /api/disputes/:id/draft/revise with the
// notes and the selection. No model call; the server compiles the PDF again and writes a new proposal, so the
// fingerprint changes and Approve binds to the new hash. Also re-proposes a failed filing (BL-01 6537331741).
import { useRef, useState } from "react";
import { NETWORK_ERROR, newKey, postJson } from "../../lib/api.ts";
import { refusalOf } from "./text.ts";

export interface Revision {
  readonly notes: string;
  readonly itemIds: readonly string[];
}

/** Re-reads the dispute after a change. */
export type Refresh = () => Promise<unknown>;

export function useRevise(disputeRowId: string, draftId: string | null, onChanged: Refresh) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  async function revise(r: Revision): Promise<boolean> {
    if (draftId === null || inflight.current) return false;
    inflight.current = true;
    setBusy(true);
    setError(null);
    const res = await postJson(
      `/api/disputes/${disputeRowId}/draft/revise`,
      { draft_id: draftId, notes: r.notes, evidence_item_ids: r.itemIds },
      newKey(),
    );
    if (res.status === 200) await onChanged();
    else
      setError(
        res.status === NETWORK_ERROR ? "NETWORK" : (refusalOf(res.body) ?? `HTTP_${String(res.status)}`),
      );
    inflight.current = false;
    setBusy(false);
    return res.status === 200;
  }

  return { revise, busy, error };
}
