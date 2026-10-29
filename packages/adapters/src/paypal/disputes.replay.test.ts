// Offline replay of the M0-05 live sandbox dispute runs (fixtures/paypal/disputes/). No network:
// an unrecorded request is unhandled and fails the test.
import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpClient, type HttpClient } from "../http/client.ts";
import { FIXTURES_DIR, loadFixture } from "../testing/fixture.ts";
import { startReplay, type Replay } from "../testing/replay.ts";
import { DisputeSchema, DisputeWriteResponseSchema, type Dispute } from "./dispute-schemas.ts";
import {
  allowedActions,
  buildMultipart,
  createDisputesTransport,
  createPayPalDisputesClient,
  describeOutcome,
  DisputeActionNotAllowedError,
  DISPUTE_WRITES_IDEMPOTENT,
  reconcileAfterTimeout,
  type DisputeAction,
  type EvidenceFile,
} from "./disputes.ts";
import { createPayPalOrdersClient, PayPalApiError } from "./orders.ts";
import { CaptureSchema } from "./schemas.ts";
import { createTokenProvider, type TokenCache } from "./token.ts";

const DIR = "paypal/disputes";
let replay: Replay | undefined;
afterEach(() => {
  replay?.close();
  replay = undefined;
});

function paypal(fixtures: readonly string[]) {
  replay = startReplay(["paypal/oauth/token", ...fixtures.map((f) => `${DIR}/${f}`)]);
  const http: HttpClient = createHttpClient({ vendor: "paypal", timeoutMs: 10_000, maxRetries: 0 });
  const cache: TokenCache = new Map();
  const tokens = createTokenProvider({
    http,
    baseUrl: "https://api-m.sandbox.paypal.com",
    credentials: { clientId: "replay", clientSecret: "replay" },
    cache,
  });
  return {
    dc: createPayPalDisputesClient({ http, tokens, env: () => "sandbox" }),
    raw: createDisputesTransport({ http, tokens }),
    pp: createPayPalOrdersClient({ http, tokens }),
    replay,
  };
}

const dispute = (name: string): Dispute => DisputeSchema.parse(loadFixture(`${DIR}/${name}`).response.body);
const requestIdOf = (name: string): string =>
  loadFixture(`${DIR}/${name}`).request.headers["paypal-request-id"] ?? "";
const idOf = (name: string): string =>
  /disputes\/([^/?]+)/.exec(loadFixture(`${DIR}/${name}`).request.url)?.[1] ?? "";
const pdf: EvidenceFile = { name: "delivery-note.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) };

/** Every recorded distinct state (`<flow>/state-N-<status>`), in recording order. */
function stateFixtures(): string[] {
  return ["full", "unknown", "accept", "idempotency", "require"].flatMap((flow) => {
    let files: string[];
    try {
      files = readdirSync(`${FIXTURES_DIR}${DIR}/${flow}`);
    } catch {
      return [];
    }
    return files
      .filter((f) => /^state-\d+-[a-z_]+\.json$/.test(f))
      .map((f) => `${flow}/${f.replace(/\.json$/, "")}`);
  });
}

describe("dispute states (replay of the recorded sandbox runs)", () => {
  const states = stateFixtures();

  it("recorded every status of the lifecycle", () => {
    const statuses = new Set(states.map((s) => dispute(s).status));
    expect([...statuses].sort()).toEqual(["OPEN", "RESOLVED", "UNDER_REVIEW", "WAITING_FOR_SELLER_RESPONSE"]);
  });

  it.each(states)("%s: allowedActions = exactly the action rels in its links", (name) => {
    const d = dispute(name);
    const rels = d.links.map((l) => l.rel).filter((r) => r !== "self");
    expect(new Set<string>(allowedActions(d))).toEqual(new Set(rels));
  });

  it("the same status offers different actions: links decide, never a status map", () => {
    const underReview = states.map(dispute).filter((d) => d.status === "UNDER_REVIEW");
    const sets = new Set(underReview.map((d) => allowedActions(d).sort().join(",")));
    // before the seller is asked; after evidence (sandbox decision offered); after adjudicate (none)
    expect(sets).toEqual(
      new Set(["provide_supporting_info", "adjudicate,provide_supporting_info,require_evidence", ""]),
    );
    const resolved = states.map(dispute).filter((d) => d.status === "RESOLVED");
    for (const d of resolved) expect(allowedActions(d)).toEqual([]);
  });
});

describe("guarded writes", () => {
  it("a write whose link is absent is refused after the fresh GET, before any write call", async () => {
    const { dc, replay: r } = paypal(["unknown/guard-refused-evidence"]);
    const id = idOf("unknown/guard-refused-evidence");
    const err = await dc
      .provideEvidence(
        id,
        { evidenceType: "PROOF_OF_FULFILLMENT", files: [pdf] },
        { requestId: "never-sent" },
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisputeActionNotAllowedError);
    expect((err as DisputeActionNotAllowedError).status).toBe("OPEN");
    expect(r.unused()).toEqual([]); // only the GET was served; a POST would have been unhandled
  });

  const writes: [string, DisputeAction, string][] = [
    ["provide_supporting_info", "provide_supporting_info", "full/write-supporting-info"],
    ["provide_evidence", "provide_evidence", "full/write-evidence"],
    ["adjudicate (sandbox)", "adjudicate", "full/write-adjudicate"],
    ["accept_claim", "accept_claim", "accept/write-accept-claim"],
    ["require_evidence (sandbox)", "require_evidence", "require/write-require-evidence"],
  ];

  it.each(writes)(
    "%s: fresh GET shows the link → the write is sent with its PayPal-Request-Id → 200",
    async (_l, action, name) => {
      const { dc, replay: r } = paypal([name, `${name}.2`]);
      expect(allowedActions(dispute(name))).toContain(action);
      const id = idOf(name);
      const o = { requestId: requestIdOf(`${name}.2`) };
      const run: Record<string, () => Promise<unknown>> = {
        provide_supporting_info: () => dc.provideSupportingInfo(id, { notes: "replay", files: [pdf] }, o),
        provide_evidence: () =>
          dc.provideEvidence(id, { evidenceType: "PROOF_OF_FULFILLMENT", notes: "replay", files: [pdf] }, o),
        adjudicate: () => dc.adjudicate(id, "SELLER_FAVOR", o),
        accept_claim: () => dc.acceptClaim(id, { note: "replay" }, o),
        require_evidence: () => dc.requireEvidence(id, "SELLER_EVIDENCE", o),
      };
      const res = DisputeWriteResponseSchema.parse(await run[action]?.());
      expect(res.links?.length ?? 0).toBeGreaterThanOrEqual(0);
      expect(loadFixture(`${DIR}/${name}.2`).response.status).toBe(200);
      expect(r.unused()).toEqual([]);
    },
  );

  it.each([
    ["provide-evidence", 422],
    ["adjudicate", 400],
    ["require-evidence", 400],
    ["accept-claim", 422],
  ] as const)(
    "%s without its link → PayPal answers %i ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE",
    async (path, status) => {
      const name = `errors/${path}-not-allowed`;
      const f = loadFixture(`${DIR}/${name}`);
      const { raw } = paypal([name]);
      const multipart = path === "provide-evidence" ? { multipart: buildMultipart({}, []) } : { json: {} };
      const err = await raw
        .send({
          method: "POST",
          path: new URL(f.request.url).pathname,
          schema: DisputeWriteResponseSchema,
          requestId: requestIdOf(name),
          ...multipart,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PayPalApiError);
      expect((err as PayPalApiError).status).toBe(status);
      expect((err as PayPalApiError).paypal?.details?.[0]?.issue).toBe(
        "ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE",
      );
    },
  );
});

describe("outcome and the money", () => {
  it("the resolved dispute maps to 'seller keeps the money (PayPal covered the case)'", () => {
    const resolved = stateFixtures().filter((s) => s.startsWith("full/") && s.endsWith("-resolved"));
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    for (const name of resolved) {
      const d = dispute(name);
      expect(d.dispute_outcome?.outcome_code).toBe("RESOLVED_WITH_PAYOUT");
      expect(d.dispute_outcome?.outcome_reason).toBe("REPRESENTED_BY_PAYPAL");
      const summary = describeOutcome(d);
      expect(summary).toEqual({
        kind: "seller_keeps_paypal_covered",
        text: "seller keeps the money (PayPal covered the case)",
      });
      expect(JSON.stringify(summary)).not.toMatch(/\bwon\b|\bwin\b/i);
    }
  });

  it("the capture goes COMPLETED → PENDING / BUYER_COMPLAINT (dispute hold) → COMPLETED (released)", () => {
    const caps = ["full/capture-1-completed", "full/capture-2-pending", "full/capture-3-completed"].map((n) =>
      CaptureSchema.parse(loadFixture(`${DIR}/${n}`).response.body),
    );
    expect(caps.map((c) => [c.status, c.status_details?.reason])).toEqual([
      ["COMPLETED", undefined],
      ["PENDING", "BUYER_COMPLAINT"],
      ["COMPLETED", undefined],
    ]);
  });

  it("chargeback (sandbox) answers 201 with a dispute id; GET capture replays", async () => {
    const { dc, pp } = paypal(["full/chargeback", "full/capture-1-completed"]);
    const f = loadFixture(`${DIR}/full/chargeback`);
    const body = f.request.body as {
      merchant_id: string;
      transaction: { id_enc: string; amount: { currency_code: string; value: string } };
    };
    const res = await dc.processChargeback({
      captureId: body.transaction.id_enc,
      amount: body.transaction.amount,
      merchantId: body.merchant_id,
      requestId: requestIdOf("full/chargeback"),
    });
    expect(res.dispute_id).toMatch(/^PP-[A-Z]-/);
    const cap = await pp.getCapture(body.transaction.id_enc);
    expect(cap.status).toBe("COMPLETED");
  });

  it("listDisputes(updateTimeAfter) returns the run's disputes", async () => {
    const f = loadFixture(`${DIR}/list/update-time-after`);
    const after = new URL(f.request.url).searchParams.get("update_time_after") ?? "";
    const { dc } = paypal(["list/update-time-after"]);
    const list = await dc.listDisputes({ updateTimeAfter: after });
    const ids = list.items.map((i) => i.dispute_id);
    expect(ids).toEqual(
      expect.arrayContaining([
        idOf("full/state-1-open"),
        idOf("unknown/state-1-open"),
        idOf("accept/state-1-open"),
      ]),
    );
  });
});

describe("require-evidence (sandbox)", () => {
  it("moves the dispute back to WAITING_FOR_SELLER_RESPONSE with a new seller deadline", () => {
    const before = dispute("require/write-require-evidence");
    const after = dispute("require/after");
    expect(before.status).toBe("UNDER_REVIEW");
    expect(after.status).toBe("WAITING_FOR_SELLER_RESPONSE");
    expect(allowedActions(after).sort()).toEqual(["accept_claim", "provide_evidence"]);
    expect(after.seller_response_due_date).toBeTruthy();
    expect(reconcileAfterTimeout("require_evidence", before, after)).toBe("landed");
  });
});

describe("unknown outcome (client timeout on a write)", () => {
  it("the timed-out provide-supporting-info LANDED: the re-read shows it; reconcile says landed", () => {
    const before = dispute("unknown/before");
    const after = dispute("unknown/after-timeout");
    expect(reconcileAfterTimeout("provide_supporting_info", before, after)).toBe("landed");
    expect(reconcileAfterTimeout("provide_supporting_info", before, before)).toBe("not_landed");
  });

  it("after it landed, the action's link is gone, so a guarded retry is refused before any write", async () => {
    const { dc, replay: r } = paypal(["unknown/retry-same-request-id-failed"]);
    const err = await dc
      .provideSupportingInfo(idOf("unknown/after-timeout"), { notes: "retry" }, { requestId: "same" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisputeActionNotAllowedError);
    expect(r.unused()).toEqual([]);
  });

  it("the same PayPal-Request-Id resent after the state moved is NOT replayed: PayPal refuses it (422)", async () => {
    const name = "unknown/raw-retry-same-request-id";
    const f = loadFixture(`${DIR}/${name}`);
    expect(f.request.headers["paypal-request-id"]).toBeTruthy();
    const { raw } = paypal([name]);
    const err = await raw
      .send({
        method: "POST",
        path: new URL(f.request.url).pathname,
        schema: DisputeWriteResponseSchema,
        requestId: requestIdOf(name),
        multipart: buildMultipart({}, []),
      })
      .catch((e: unknown) => e);
    expect((err as PayPalApiError).status).toBe(422);
    expect((err as PayPalApiError).paypal?.details?.[0]?.issue).toBe(
      "ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE",
    );
  });

  it("the same PayPal-Request-Id sent twice while the link is present creates TWO entries (not idempotent)", async () => {
    expect(requestIdOf("idempotency/second-same-id.2")).toBe(requestIdOf("idempotency/first.2"));
    const { dc, replay: r } = paypal([
      "idempotency/first",
      "idempotency/first.2",
      "idempotency/second-same-id",
      "idempotency/second-same-id.2",
    ]);
    const id = idOf("idempotency/first");
    const o = { requestId: requestIdOf("idempotency/first.2") };
    await dc.provideSupportingInfo(id, { notes: "x" }, o);
    await dc.provideSupportingInfo(id, { notes: "x" }, o);
    expect(r.unused()).toEqual([]);
    const after = dispute("idempotency/after");
    expect(after.supporting_info?.length).toBe(2);
    expect(DISPUTE_WRITES_IDEMPOTENT).toBe(false); // so the shared client never auto-retries a dispute write
  });
});
