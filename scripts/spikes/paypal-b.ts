// M0-05 spike B: the dispute lifecycle on the PayPal SANDBOX through the product adapters, recording
// every distinct state, link set, write and error as scrubbed fixtures (fixtures/paypal/disputes/).
//
//   pnpm tsx --env-file=<path to .env> scripts/spikes/paypal-b.ts --record
//
// Three disputes, each on a fresh card capture (M0-04's helper), run concurrently:
//   full     chargeback → supporting info → evidence → adjudicate SELLER_FAVOR → RESOLVED → capture released
//   unknown  writes before their link exists (PayPal's refusals) → supporting info with a tiny client
//            timeout → re-read → retry with the SAME PayPal-Request-Id → re-read
//   accept   accept-claim, then the capture / refund state
// Polls are ≥ 60 s apart per dispute; each flow gives up 45 min after its chargeback.
// Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from the environment and never prints them.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowedActions,
  buildMultipart,
  createDisputesTransport,
  createHttpClient,
  createPayPalDisputesClient,
  createPayPalOrdersClient,
  createTokenProvider,
  DisputeWriteResponseSchema,
  firstCapture,
  HttpTimeoutError,
  PAYPAL_SANDBOX_BASE_URL,
  PayPalApiError,
  VENDOR_TIMEOUTS_MS,
  type Capture,
  type Dispute,
  type DisputeAction,
  type DisputesTransport,
  type EvidenceFile,
  type Exchange,
  type PayPalDisputesClient,
  type PayPalOrdersClient,
  type TokenCache,
} from "../../packages/adapters/src/index.ts";
import { toFixture } from "../../packages/adapters/src/testing/record.ts";
import { createScrubber, type Scrubber } from "../../packages/adapters/src/testing/scrub.ts";
import { EVIDENCE_PDF_PATH } from "./evidence-pdf.ts";

const TICKET = "M0-05";
const POLL_MS = 60_000;
const GIVE_UP_MS = 45 * 60_000;
const CARD = { number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "Asha Verma" };
const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/paypal/disputes/", import.meta.url));
const T0 = Date.now();

const record = process.argv.includes("--record");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const secs = (): number => Math.round((Date.now() - T0) / 1000);

interface Flow {
  readonly name: string;
  readonly dc: PayPalDisputesClient;
  readonly raw: DisputesTransport;
  readonly pp: PayPalOrdersClient;
  readonly rawGet: (path: string) => Promise<unknown>;
  /** Writes the exchanges since the last reset as `<name>.json`, `<name>.2.json`… */
  keep(name: string, note?: string): void;
  reset(): void;
  log(event: string, data?: Record<string, unknown>): void;
  readonly events: Record<string, unknown>[];
}

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    console.error(`missing ${name} in the environment`);
    process.exit(2);
  }
  return v;
}

function makeFlow(
  name: string,
  ctx: { credentials: { clientId: string; clientSecret: string }; cache: TokenCache; scrubber: Scrubber },
): Flow {
  const buf: Exchange[] = [];
  const events: Record<string, unknown>[] = [];
  const http = createHttpClient({
    vendor: "paypal",
    timeoutMs: VENDOR_TIMEOUTS_MS.paypal,
    onExchange: (e) => {
      if (!e.request.url.endsWith("/v1/oauth2/token")) buf.push(e);
    },
  });
  const tokens = createTokenProvider({
    http,
    baseUrl: PAYPAL_SANDBOX_BASE_URL,
    credentials: ctx.credentials,
    cache: ctx.cache,
  });
  const raw = createDisputesTransport({ http, tokens });
  return {
    name,
    raw,
    dc: createPayPalDisputesClient({ http, tokens, env: () => process.env.PAYPAL_ENV ?? "sandbox" }),
    pp: createPayPalOrdersClient({ http, tokens }),
    rawGet: async (path) => {
      const res = await tokens.withToken((b) =>
        http.request({
          method: "GET",
          url: `${PAYPAL_SANDBOX_BASE_URL}${path}`,
          headers: { authorization: `Bearer ${b}` },
        }),
      );
      return JSON.parse(res.bodyText) as unknown;
    },
    keep(fixture, note) {
      if (record) {
        buf.forEach((e, i) => {
          const file = join(FIXTURE_DIR, `${fixture}${i === 0 ? "" : `.${String(i + 1)}`}.json`);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(
            file,
            `${JSON.stringify(toFixture(e, ctx.scrubber, TICKET, new Date(), note), null, 2)}\n`,
          );
        });
      }
      buf.length = 0;
    },
    reset() {
      buf.length = 0;
    },
    log(event, data = {}) {
      const row = { t: secs(), at: new Date().toISOString(), flow: name, event, ...data };
      events.push(row);
      console.log(JSON.stringify(row));
    },
    events,
  };
}

const evidenceFile = (): EvidenceFile => ({
  name: "delivery-note.pdf",
  bytes: new Uint8Array(readFileSync(EVIDENCE_PDF_PATH)),
});

/** A fresh card capture + its merchant id (the order's payee). */
async function freshCapture(f: Flow, value: string): Promise<{ capture: Capture; merchantId: string }> {
  f.reset();
  const order = await f.pp.createOrder({
    amount: { currency_code: "USD", value },
    customId: `spike-${randomUUID()}`,
    referenceId: `dispute-${f.name}`,
    card: CARD,
    requestId: randomUUID(),
  });
  const capture = firstCapture(order);
  if (capture === undefined) throw new Error(`${f.name}: order ${order.id} has no capture`);
  const rawOrder = (await f.rawGet(`/v2/checkout/orders/${order.id}`)) as {
    purchase_units?: { payee?: { merchant_id?: string } }[];
  };
  const merchantId = rawOrder.purchase_units?.[0]?.payee?.merchant_id;
  if (merchantId === undefined) throw new Error(`${f.name}: no payee.merchant_id on order`);
  f.reset();
  f.log("capture", { order: order.id, capture: capture.id, status: capture.status, amount: value });
  return { capture, merchantId };
}

async function chargeback(f: Flow, capture: Capture, merchantId: string): Promise<string> {
  f.reset();
  const { dispute_id } = await f.dc.processChargeback({
    captureId: capture.id,
    amount: capture.amount,
    merchantId,
    requestId: randomUUID(),
  });
  f.keep(`${f.name}/chargeback`, "POST /v2/customer-support/process-chargeback (sandbox)");
  f.log("chargeback", { dispute: dispute_id });
  return dispute_id;
}

const stateKey = (d: Dispute): string =>
  [
    d.status,
    d.dispute_life_cycle_stage,
    d.links
      .map((l) => l.rel)
      .sort()
      .join(","),
    d.dispute_outcome?.outcome_code ?? "",
  ].join("|");

/** GET the dispute; keep a fixture the first time a (status, stage, links, outcome) combination is seen. */
function observer(f: Flow) {
  const seen = new Set<string>();
  return async (id: string): Promise<Dispute> => {
    f.reset();
    const d = await f.dc.getDispute(id);
    const key = stateKey(d);
    if (seen.has(key)) {
      f.reset();
      return d;
    }
    seen.add(key);
    f.keep(
      `${f.name}/state-${String(seen.size)}-${d.status.toLowerCase()}`,
      `links: ${d.links.map((l) => l.rel).join(", ")}`,
    );
    f.log("state", {
      status: d.status,
      stage: d.dispute_life_cycle_stage,
      links: d.links.map((l) => l.rel),
      outcome: d.dispute_outcome,
      update_time: d.update_time,
      due: d.seller_response_due_date,
    });
    return d;
  };
}

function captureObserver(f: Flow) {
  const seen = new Set<string>();
  return async (id: string): Promise<Capture> => {
    f.reset();
    const c = await f.pp.getCapture(id);
    const key = `${c.status}|${c.status_details?.reason ?? ""}`;
    if (seen.has(key)) {
      f.reset();
      return c;
    }
    seen.add(key);
    f.keep(
      `${f.name}/capture-${String(seen.size)}-${c.status.toLowerCase()}`,
      `capture ${c.status} ${c.status_details?.reason ?? ""}`.trim(),
    );
    f.log("capture-state", {
      status: c.status,
      reason: c.status_details?.reason,
      update_time: c.update_time,
    });
    return c;
  };
}

/** The raw body for an action, so PayPal's own refusal can be recorded (bypasses the guard on purpose). */
function rawSend(f: Flow, id: string, action: DisputeAction) {
  const path = `/v1/customer/disputes/${id}/${action.replaceAll("_", "-")}`;
  const base = { method: "POST" as const, path, schema: DisputeWriteResponseSchema, requestId: randomUUID() };
  switch (action) {
    case "provide_evidence":
      return f.raw.send({
        ...base,
        multipart: buildMultipart(
          {
            evidences: [
              {
                evidence_type: "PROOF_OF_FULFILLMENT",
                documents: [{ name: "delivery-note.pdf" }],
                notes: "Delivered; see delivery note.",
              },
            ],
          },
          [evidenceFile()],
        ),
      });
    case "provide_supporting_info":
      return f.raw.send({
        ...base,
        multipart: buildMultipart({ notes: "Supporting info sent while not offered." }, []),
      });
    case "adjudicate":
      return f.raw.send({ ...base, json: { adjudication_outcome: "SELLER_FAVOR" } });
    case "require_evidence":
      return f.raw.send({ ...base, json: { action: "SELLER_EVIDENCE" } });
    case "accept_claim":
      return f.raw.send({
        ...base,
        json: { note: "Accepting while not offered.", accept_claim_type: "REFUND" },
      });
    default:
      throw new Error(`no raw body for ${action}`);
  }
}

/** Sends an action whose link is ABSENT and records PayPal's refusal. */
async function refusal(f: Flow, id: string, action: DisputeAction, fixture: string): Promise<void> {
  f.reset();
  try {
    await rawSend(f, id, action);
    f.keep(`${fixture}-unexpected-success`, `${action} sent without its link: PayPal ACCEPTED it`);
    f.log("refusal-missing", { action, note: "PayPal accepted a write whose link was absent" });
  } catch (err) {
    if (!(err instanceof PayPalApiError)) throw err;
    f.keep(fixture, `${action} sent while its link is absent`);
    f.log("refusal", {
      action,
      status: err.status,
      name: err.paypal?.name,
      issue: err.paypal?.details?.[0]?.issue,
    });
  }
}

/** Runs a guarded write; keeps GET + POST under `fixture`. A link race is logged, not fatal. */
async function write(
  f: Flow,
  fixture: string,
  action: string,
  run: () => Promise<unknown>,
): Promise<boolean> {
  f.reset();
  try {
    await run();
    f.keep(fixture, `${action}: fresh GET (link re-check), then the write`);
    f.log("write", { action, ok: true });
    return true;
  } catch (err) {
    const e =
      err instanceof PayPalApiError
        ? { status: err.status, name: err.paypal?.name, issue: err.paypal?.details?.[0]?.issue }
        : { error: String(err) };
    f.keep(`${fixture}-failed`, `${action} failed`);
    f.log("write", { action, ok: false, ...e });
    return false;
  }
}

const notesFor = (what: string): string =>
  `${what} Synthetic sandbox case: the item was dispatched with tracking and delivered; the delivery note is attached.`;
const opts = (): { requestId: string } => ({ requestId: randomUUID() });

async function fullFlow(f: Flow): Promise<Record<string, unknown>> {
  const { capture, merchantId } = await freshCapture(f, "64.00");
  const cap = captureObserver(f);
  await cap(capture.id);
  const id = await chargeback(f, capture, merchantId);
  const t0 = Date.now();
  const look = observer(f);
  const done = { supporting: false, evidence: 0, adjudicated: false, require: false };
  let evidenceAt = 0;
  let d = await look(id);
  let c = await cap(capture.id);
  while (Date.now() - t0 < GIVE_UP_MS) {
    if (d.status === "RESOLVED" && c.status !== "PENDING") break;
    const acts = allowedActions(d);
    if (!done.supporting && acts.includes("provide_supporting_info")) {
      done.supporting = await write(f, "full/write-supporting-info", "provide_supporting_info", () =>
        f.dc.provideSupportingInfo(
          id,
          { notes: notesFor("Supporting info."), files: [evidenceFile()] },
          opts(),
        ),
      );
    } else if (done.evidence === 0 && acts.includes("provide_evidence")) {
      if (
        await write(f, "full/write-evidence", "provide_evidence", () =>
          f.dc.provideEvidence(
            id,
            { evidenceType: "PROOF_OF_FULFILLMENT", notes: notesFor("Evidence."), files: [evidenceFile()] },
            opts(),
          ),
        )
      )
        evidenceAt = Date.now();
      done.evidence = 1;
    } else if (!done.adjudicated && acts.includes("adjudicate")) {
      done.adjudicated = await write(f, "full/write-adjudicate", "adjudicate", () =>
        f.dc.adjudicate(id, "SELLER_FAVOR", opts()),
      );
    } else if (!done.require && done.evidence === 0 && acts.includes("require_evidence")) {
      done.require = await write(f, "full/write-require-evidence", "require_evidence", () =>
        f.dc.requireEvidence(id, "SELLER_EVIDENCE", opts()),
      );
    } else if (
      !done.adjudicated &&
      evidenceAt > 0 &&
      d.status !== "RESOLVED" &&
      Date.now() - evidenceAt > 6 * 60_000
    ) {
      done.adjudicated = await tryUnlinkedAdjudicate(f, id);
    }
    await sleep(POLL_MS);
    d = await look(id);
    c = await cap(capture.id);
  }
  f.log("full-end", {
    status: d.status,
    outcome: d.dispute_outcome,
    capture: c.status,
    minutes: (Date.now() - t0) / 60_000,
  });
  if (d.status === "RESOLVED") {
    await refusal(f, id, "accept_claim", "errors/accept-claim-resolved");
    await refusal(f, id, "provide_supporting_info", "errors/supporting-info-resolved");
  }
  return {
    dispute: id,
    capture: capture.id,
    status: d.status,
    outcome: d.dispute_outcome,
    captureStatus: c.status,
  };
}

/** If PayPal never shows an adjudicate link, record what a direct call does (finding, not product path). */
let unlinkedTries = 0;
async function tryUnlinkedAdjudicate(f: Flow, id: string): Promise<boolean> {
  unlinkedTries += 1;
  f.reset();
  try {
    await rawSend(f, id, "adjudicate");
    f.keep("full/write-adjudicate-without-link", "adjudicate accepted although no adjudicate link was shown");
    f.log("adjudicate-without-link", { ok: true, tries: unlinkedTries });
    return true;
  } catch (err) {
    if (!(err instanceof PayPalApiError)) throw err;
    if (unlinkedTries === 1) f.keep("errors/adjudicate-no-link", "adjudicate before any adjudicate link");
    f.reset();
    f.log("adjudicate-without-link", {
      ok: false,
      status: err.status,
      issue: err.paypal?.details?.[0]?.issue,
    });
    return false;
  }
}

async function unknownFlow(f: Flow): Promise<Record<string, unknown>> {
  const { capture, merchantId } = await freshCapture(f, "23.00");
  const id = await chargeback(f, capture, merchantId);
  const t0 = Date.now();
  const look = observer(f);
  let d = await look(id);
  for (const a of ["provide_evidence", "adjudicate", "require_evidence", "accept_claim"] as const) {
    if (
      !allowedActions(d).includes(a) &&
      (a !== "accept_claim" || d.status !== "WAITING_FOR_SELLER_RESPONSE")
    ) {
      await refusal(f, id, a, `errors/${a.replaceAll("_", "-")}-not-allowed`);
    }
  }
  // the guard refuses BEFORE any write when the link is absent (recorded as a GET-only fixture)
  f.reset();
  await f.dc
    .provideEvidence(id, { evidenceType: "PROOF_OF_FULFILLMENT", files: [evidenceFile()] }, opts())
    .then(
      () => f.log("guard", { refused: false }),
      (err: unknown) => {
        f.keep(
          "unknown/guard-refused-evidence",
          "provideEvidence: fresh GET shows no provide_evidence link → refused client-side, no POST",
        );
        f.log("guard", { refused: true, error: String(err) });
      },
    );
  while (!allowedActions(d).includes("provide_supporting_info") && Date.now() - t0 < GIVE_UP_MS) {
    await sleep(POLL_MS);
    d = await look(id);
  }
  if (!allowedActions(d).includes("provide_supporting_info"))
    return { dispute: id, skipped: "no provide_supporting_info link" };
  return { dispute: id, capture: capture.id, ...(await timeoutProbe(f, id, look)) };
}

/** Supporting info with a tiny client timeout → re-read → retry with the same request id → re-read. */
async function timeoutProbe(
  f: Flow,
  id: string,
  look: (id: string) => Promise<Dispute>,
): Promise<Record<string, unknown>> {
  f.reset();
  const before = await f.dc.getDispute(id);
  f.keep("unknown/before", "dispute right before the timed-out write");
  const requestId = randomUUID();
  const input = { notes: notesFor("Supporting info (timeout probe).") };
  const probe: Record<string, unknown> = { requestId };
  for (const timeoutMs of [300, 50, 5]) {
    f.reset();
    const started = Date.now();
    try {
      await f.dc.provideSupportingInfo(id, input, { requestId, timeoutMs });
      f.keep(
        `unknown/no-timeout-${String(timeoutMs)}ms`,
        `the write finished inside ${String(timeoutMs)} ms`,
      );
      f.log("timeout-probe", { timeoutMs, timedOut: false, ms: Date.now() - started });
    } catch (err) {
      if (!(err instanceof HttpTimeoutError)) throw err;
      f.keep(
        "unknown/timeout-precheck-get",
        "the guarded write's re-check GET before the timed-out POST (the POST has no response)",
      );
      f.log("timeout-probe", {
        timeoutMs,
        timedOut: true,
        outcomeUnknown: err.outcomeUnknown,
        ms: Date.now() - started,
      });
      probe.timeoutMs = timeoutMs;
      break;
    }
  }
  await sleep(POLL_MS);
  f.reset();
  const after = await f.dc.getDispute(id);
  f.keep("unknown/after-timeout", "re-read 60 s after the timeout: did the write land?");
  probe.afterTimeout = summary(before, after);
  f.log("after-timeout", probe.afterTimeout as Record<string, unknown>);
  await write(
    f,
    "unknown/retry-same-request-id",
    "provide_supporting_info (retry, same PayPal-Request-Id)",
    () => f.dc.provideSupportingInfo(id, input, { requestId }),
  );
  await sleep(POLL_MS);
  f.reset();
  const final = await f.dc.getDispute(id);
  f.keep("unknown/after-retry", "re-read 60 s after the same-id retry");
  probe.afterRetry = summary(before, final);
  f.log("after-retry", probe.afterRetry as Record<string, unknown>);
  await look(id);
  return probe;
}

function summary(before: Dispute, after: Dispute): Record<string, unknown> {
  return {
    supportingInfo: [before.supporting_info?.length ?? 0, after.supporting_info?.length ?? 0],
    sellerEvidence: [
      before.evidences?.filter((e) => e.source === "SUBMITTED_BY_SELLER").length ?? 0,
      after.evidences?.filter((e) => e.source === "SUBMITTED_BY_SELLER").length ?? 0,
    ],
    evidences: [before.evidences?.length ?? 0, after.evidences?.length ?? 0],
    updateTime: [before.update_time, after.update_time],
    links: [before.links.map((l) => l.rel), after.links.map((l) => l.rel)],
    status: [before.status, after.status],
  };
}

async function acceptFlow(f: Flow): Promise<Record<string, unknown>> {
  const { capture, merchantId } = await freshCapture(f, "9.00");
  const cap = captureObserver(f);
  await cap(capture.id);
  const id = await chargeback(f, capture, merchantId);
  const t0 = Date.now();
  const look = observer(f);
  let d = await look(id);
  let supported = false;
  while (!allowedActions(d).includes("accept_claim") && Date.now() - t0 < GIVE_UP_MS) {
    if (!supported && Date.now() - t0 > 8 * 60_000 && allowedActions(d).includes("provide_supporting_info")) {
      supported = await write(
        f,
        "accept/write-supporting-info",
        "provide_supporting_info (to move the case on)",
        () => f.dc.provideSupportingInfo(id, { notes: notesFor("Supporting info.") }, opts()),
      );
    }
    await sleep(POLL_MS);
    d = await look(id);
    await cap(capture.id);
  }
  if (!allowedActions(d).includes("accept_claim"))
    return { dispute: id, skipped: "accept_claim link never appeared" };
  await write(f, "accept/write-accept-claim", "accept_claim (REFUND)", () =>
    f.dc.acceptClaim(
      id,
      { note: "Accepting the claim; refund the buyer.", acceptClaimType: "REFUND" },
      opts(),
    ),
  );
  const t1 = Date.now();
  let c = await cap(capture.id);
  while ((d.status !== "RESOLVED" || c.status === "PENDING") && Date.now() - t1 < 15 * 60_000) {
    await sleep(POLL_MS);
    d = await look(id);
    c = await cap(capture.id);
  }
  return {
    dispute: id,
    capture: capture.id,
    status: d.status,
    outcome: d.dispute_outcome,
    captureStatus: c.status,
    supportedFirst: supported,
  };
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

/** Later reads: the released capture of the full path, the accept-claim dispute and its capture. */
async function laterSnapshots(f: Flow): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const fullCapture = arg("--full-capture");
  if (fullCapture !== undefined) {
    f.reset();
    const c = await f.pp.getCapture(fullCapture);
    f.keep("full/capture-3-completed", "the full path's capture after RESOLVED: hold released");
    out.fullCapture = { status: c.status, reason: c.status_details?.reason, update_time: c.update_time };
  }
  const acceptDispute = arg("--accept-dispute");
  const acceptCapture = arg("--accept-capture");
  if (acceptDispute !== undefined && acceptCapture !== undefined) {
    f.reset();
    const d = await f.dc.getDispute(acceptDispute);
    f.keep(`accept/later-${d.status.toLowerCase()}`, "the accept-claim dispute, read again later");
    const c = await f.pp.getCapture(acceptCapture);
    f.keep(`accept/later-capture-${c.status.toLowerCase()}`, "the accept-claim capture, read again later");
    out.accept = {
      status: d.status,
      outcome: d.dispute_outcome,
      update_time: d.update_time,
      capture: c.status,
      reason: c.status_details?.reason,
      capture_update: c.update_time,
    };
  }
  f.log("later", out);
  return out;
}

/**
 * Follow-up probe (`--idempotency [--dispute <id> --request-id <id>]`): what PayPal does with a
 * repeated PayPal-Request-Id on provide-supporting-info.
 * (a) the timed-out write's id resent RAW after the dispute moved on (link gone);
 * (b) on a fresh dispute, the same id sent twice while the link is present, then a re-read.
 */
async function idempotencyProbe(f: Flow): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const dispute = arg("--dispute");
  const requestId = arg("--request-id");
  const input = { notes: notesFor("Supporting info (timeout probe).") };
  if (dispute !== undefined && requestId !== undefined) {
    f.reset();
    const sent = f.raw.send({
      method: "POST",
      path: `/v1/customer/disputes/${dispute}/provide-supporting-info`,
      schema: DisputeWriteResponseSchema,
      requestId,
      multipart: buildMultipart(input, []),
    });
    out.rawRetry = await sent.then(
      () => ({ ok: true }),
      (err: unknown) =>
        err instanceof PayPalApiError
          ? { ok: false, status: err.status, issue: err.paypal?.details?.[0]?.issue }
          : { ok: false, error: String(err) },
    );
    f.keep(
      "unknown/raw-retry-same-request-id",
      "the timed-out write's PayPal-Request-Id resent raw (no link check) after the dispute moved to WAITING_FOR_SELLER_RESPONSE",
    );
    f.log("raw-retry", out.rawRetry as Record<string, unknown>);
  }
  if (process.argv.includes("--raw-retry-only")) return { ...out, ...(await laterSnapshots(f)) };
  const { capture, merchantId } = await freshCapture(f, "12.00");
  const id = await chargeback(f, capture, merchantId);
  const look = observer(f);
  const t0 = Date.now();
  let d = await look(id);
  while (!allowedActions(d).includes("provide_supporting_info") && Date.now() - t0 < 10 * 60_000) {
    await sleep(POLL_MS);
    d = await look(id);
  }
  const same = randomUUID();
  const twice = { notes: notesFor("Supporting info (same id twice).") };
  await write(f, "idempotency/first", "provide_supporting_info (id X)", () =>
    f.dc.provideSupportingInfo(id, twice, { requestId: same }),
  );
  await write(
    f,
    "idempotency/second-same-id",
    "provide_supporting_info (id X again, link still present)",
    () => f.dc.provideSupportingInfo(id, twice, { requestId: same }),
  );
  await sleep(POLL_MS);
  f.reset();
  const after = await f.dc.getDispute(id);
  f.keep("idempotency/after", "re-read 60 s after sending the same PayPal-Request-Id twice");
  out.twice = { dispute: id, supportingInfo: after.supporting_info?.length ?? 0, status: after.status };
  f.log("same-id-twice", out.twice as Record<string, unknown>);
  return out;
}

async function main(): Promise<void> {
  if ((process.env.PAYPAL_ENV ?? "sandbox") !== "sandbox") throw new Error("PAYPAL_ENV must be sandbox");
  const credentials = { clientId: env("PAYPAL_CLIENT_ID"), clientSecret: env("PAYPAL_CLIENT_SECRET") };
  const cache: TokenCache = new Map();
  const liveTokens = new Set<string>();
  const scrubber = createScrubber({
    secrets: () => [credentials.clientId, credentials.clientSecret, ...liveTokens],
  });
  const ctx = { credentials, cache, scrubber };
  const startIso = new Date(T0 - 60_000).toISOString();
  const flows = {
    full: makeFlow("full", ctx),
    unknown: makeFlow("unknown", ctx),
    accept: makeFlow("accept", ctx),
  };
  liveTokens.add(
    (
      await createTokenProvider({
        http: createHttpClient({ vendor: "paypal", timeoutMs: VENDOR_TIMEOUTS_MS.paypal }),
        baseUrl: PAYPAL_SANDBOX_BASE_URL,
        credentials,
        cache,
      }).getToken()
    ).value,
  );
  if (process.argv.includes("--idempotency")) {
    console.log(
      JSON.stringify({ done: true, probe: await idempotencyProbe(makeFlow("idempotency", ctx)) }, null, 2),
    );
    return;
  }
  const results = await Promise.allSettled([
    fullFlow(flows.full),
    unknownFlow(flows.unknown),
    acceptFlow(flows.accept),
  ]);
  const list = makeFlow("list", ctx);
  list.reset();
  const listed = await list.dc.listDisputes({ updateTimeAfter: startIso });
  list.keep("list/update-time-after", "GET /v1/customer/disputes?update_time_after=<run start>");
  const out = {
    started: new Date(T0).toISOString(),
    seconds: secs(),
    results: results.map((r) => (r.status === "fulfilled" ? r.value : { error: String(r.reason) })),
    listed: listed.items.map((i) => ({ id: i.dispute_id, status: i.status })),
    events: Object.values(flows).flatMap((f) => f.events),
  };
  const outFile = process.env.SPIKE_OUT;
  if (outFile !== undefined) writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ done: true, results: out.results, listed: out.listed.length }, null, 2));
}

main().catch((err: unknown) => {
  const e =
    err instanceof PayPalApiError
      ? { status: err.status, name: err.paypal?.name, debug: err.debugId, details: err.paypal?.details }
      : String(err);
  console.error("spike failed:", JSON.stringify(e));
  process.exit(1);
});
