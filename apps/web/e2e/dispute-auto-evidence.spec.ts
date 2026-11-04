// BL-01 6595501766 E2E (local, fixture-backed): the approval card marks the client sign-off code added to the
// agent's draft ("Added by Cleared") and says why the scope snapshot was left out (PayPal's 10 MB limit), in
// EN and HI, at 360 / 375 / 768 / 1440 in light and dark with axe (ui-reviewer captures in
// .review/SWEEP-M4A/). The drafting job's own behaviour is proven in apps/worker draft-dispute.int.test.ts;
// here the draft row and its `dispute_draft.evidence_added` audit row are set up as that job leaves them.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { capture, demoWorkspace, local, seed, sql } from "./support/disputes.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only: the msw stub stands in for PayPal");

const DIR = fileURLToPath(new URL("../../../.review/SWEEP-M4A/", import.meta.url));

async function draftWithAuto(page: Page, locale: "en" | "hi"): Promise<string> {
  const ws = await demoWorkspace(page, locale);
  const s = await seed(ws);
  const text = "Client sign-off\nConfirmed by: Northwind Tea Co.";
  const sha = (v: string) => createHash("sha256").update(v).digest("hex");
  const add = async (kind: string, body: string): Promise<string> => {
    const id = crypto.randomUUID();
    await sql(
      "insert into evidence_items (id, workspace_id, pack_id, kind, text, sha256) select $1, $2, pack_id, $3, $4, $5 from dispute_drafts where id = $6",
      [id, ws, kind, body, sha(body), s.draftId],
    );
    return id;
  };
  const ack = await add("client_ack", text);
  // the snapshot is a PDF file, as M3-07 stores it (the left-out note then sits beside its "Open E5" link)
  const pdf = Buffer.from("%PDF-1.4\n% scope snapshot stand-in\n");
  const snap = crypto.randomUUID();
  await sql(
    "with b as (insert into blobs (workspace_id, mime, bytes, size, sha256) values ($1, 'application/pdf', $2, $3, $4) returning id) insert into evidence_items (id, workspace_id, pack_id, kind, blob_id, sha256) select $5, $1, d.pack_id, 'scope_snapshot', b.id, $4 from dispute_drafts d, b where d.id = $6",
    [ws, pdf, pdf.byteLength, sha(pdf.toString("latin1")), snap, s.draftId],
  );
  await sql(
    "update dispute_drafts set evidence_item_ids = array_append(evidence_item_ids, $1::uuid) where id = $2",
    [ack, s.draftId],
  );
  await sql(
    "insert into audit_log (workspace_id, actor, action, detail) values ($1, 'system', 'dispute_draft.evidence_added', $2::jsonb)",
    [
      ws,
      JSON.stringify({
        disputeId: s.disputeRowId,
        paypalDisputeId: s.paypalDisputeId,
        draftId: s.draftId,
        payloadSha256: s.payloadSha256,
        added: [{ id: ack, kind: "client_ack" }],
        leftOut: [{ id: snap, kind: "scope_snapshot", code: "pdf_too_large", bytes: 9_990_000 }],
      }),
    ],
  );
  return `/${locale}/disputes/${s.disputeRowId}`;
}

test("the card lists what Cleared added and why an item was left out (EN)", async ({ page }) => {
  await page.goto(await draftWithAuto(page, "en"));
  await expect(page.getByTestId("evidence-toggle")).toHaveCount(5);
  await expect(page.getByTestId("evidence-auto-hint")).toHaveText(
    "Cleared always adds your client's sign-off and the scope snapshot when your pack has them, within PayPal's limits.",
  );
  const added = page.getByTestId("evidence-auto-added");
  await expect(added).toHaveText("Added by Cleared");
  // the note is part of the checkbox's accessible name, and the added item is ticked
  const ackBox = page.getByRole("checkbox", { name: /client sign-off.*Added by Cleared/ });
  await expect(ackBox).toBeChecked();
  const left = page.getByTestId("evidence-auto-left-out");
  await expect(left).toHaveText(
    "Not added: with this item (9.99 MB) the PDF would reach PayPal's 10 MB limit.",
  );
  await expect(page.getByRole("checkbox", { name: /scope snapshot.*Not added/ })).not.toBeChecked();
  await expect(
    page.getByText(
      "Checked the draft for your client's sign-off and scope snapshot (see the evidence items)",
    ),
  ).toBeVisible();
  await capture(page, "en-auto-evidence", DIR);
});

test("the same in HI", async ({ page }) => {
  await page.goto(await draftWithAuto(page, "hi"));
  await expect(page.getByTestId("evidence-auto-added")).toHaveText("Cleared ने जोड़ा");
  await expect(page.getByTestId("evidence-auto-left-out")).toContainText("नहीं जोड़ा");
  await capture(page, "hi-auto-evidence", DIR);
});
