// `pnpm load:burst` (M4-06): a fixed-rate burst against /api/webhooks/paypal. Two modes:
//
//   --replay <dir> --rate 5 --minutes 5      (production) the recorded real deliveries under <dir> posted
//        with their original headers (label `replay`), and every 5th request a forged one (label `forged`):
//        a recorded delivery with a fresh transmission time and a signature that isn't PayPal's, so it
//        reaches the signature check. Nothing is stored either way; no job is enqueued.
//   --rate 5 --count 1500 [--spike 20:30]    (local, NODE_ENV=test stack) unique PAYMENT.CAPTURE.COMPLETED
//        events signed with the test signing harness (LOAD_SIGNING_PRIVATE_KEY_FILE, PAYPAL_WEBHOOK_ID from
//        scripts/load/local-env.sh; label `signed`), then a spike at 20/s for 30 s; 5% are posted a second
//        time as PayPal's redelivery would (label `redelivery`: must answer `duplicate`). With DATABASE_URL
//        set it then samples the queue every 5 s until it drains (or --drain-window s) and checks the rows.
import { randomUUID, sign } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, createDb, type Db } from "../../packages/db/src/client.ts";
import {
  commitSha,
  flag,
  numFlag,
  overallOf,
  parseArgs,
  Recorder,
  runSchedule,
  sleep,
  timedFetch,
  writeResult,
  type Phase,
  type QueueResult,
} from "./run.ts";
import { networkFloor, serverTimingsFor } from "./render-logs.ts";

/** apps/web/src/server/test-signing.ts TEST_CERT_URL (duplicated: scripts don't import the web app) */
const TEST_CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-M4-06-TEST-HARNESS";
const DELIVERY = new URL(
  "../../fixtures/paypal/webhooks/deliveries/payment-capture-completed.json",
  import.meta.url,
);

interface Delivery {
  readonly headers: Record<string, string>;
  readonly raw_body: string;
}

const paypalTime = (d = new Date()): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const hex15 = (): string => randomUUID().replaceAll("-", "").toUpperCase().slice(0, 15);

/** Every `{headers, raw_body}` delivery file under `dir`, recursively (exchange fixtures are skipped). */
export function loadDeliveries(dir: string): Delivery[] {
  const out: Delivery[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...loadDeliveries(p));
    else if (name.endsWith(".json")) {
      const d = JSON.parse(readFileSync(p, "utf8")) as Partial<Delivery>;
      if (typeof d.raw_body === "string" && typeof d.headers === "object") out.push(d as Delivery);
    }
  }
  return out;
}

function phasesOf(flags: Map<string, string>): Phase[] {
  const rate = numFlag(flags, "rate", 5);
  const minutes = flags.get("minutes");
  const count = flags.get("count");
  const durationMs = count !== undefined ? (Number(count) / rate) * 1000 : Number(minutes ?? 5) * 60_000;
  const phases: Phase[] = [{ rate, durationMs }];
  const spike = flags.get("spike");
  if (spike !== undefined) {
    const [r, s] = spike.split(":").map(Number);
    if (!r || !s) throw new Error("--spike takes <rate>:<seconds>, e.g. 20:30");
    phases.push({ rate: r, durationMs: s * 1000 });
  }
  return phases;
}

function forge(d: Delivery): { body: string; headers: Record<string, string> } {
  return {
    body: d.raw_body,
    headers: {
      ...d.headers,
      "paypal-transmission-id": randomUUID(),
      "paypal-transmission-time": paypalTime(),
      "paypal-transmission-sig": Buffer.from(randomUUID().repeat(8)).toString("base64"),
    },
  };
}

interface Signer {
  readonly key: string;
  readonly webhookId: string;
  readonly workspace: string;
}

/** A unique capture-completed event for a fresh `LB…` capture, signed with the harness key. */
function signedEvent(
  s: Signer,
  base: Delivery,
  tail: string,
): { eventId: string; body: string; headers: Record<string, string> } {
  const event = JSON.parse(base.raw_body) as {
    id: string;
    create_time: string;
    resource: Record<string, unknown> & { supplementary_data: { related_ids: Record<string, string> } };
  };
  event.id = `WH-LB-${randomUUID()}`;
  event.create_time = new Date().toISOString();
  event.resource["id"] = `LB${tail}`;
  event.resource["custom_id"] = s.workspace;
  event.resource.supplementary_data.related_ids["order_id"] = `LO${tail}`;
  const body = JSON.stringify(event);
  const transmissionId = randomUUID();
  const transmissionTime = paypalTime();
  const crc = crc32(body);
  const message = `${transmissionId}|${transmissionTime}|${s.webhookId}|${String(crc)}`;
  return {
    eventId: event.id,
    body,
    headers: {
      ...base.headers,
      "paypal-cert-url": TEST_CERT_URL,
      "paypal-transmission-id": transmissionId,
      "paypal-transmission-time": transmissionTime,
      "paypal-transmission-sig": sign("sha256", Buffer.from(message), s.key).toString("base64"),
    },
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
/** CRC-32 (IEEE) of the UTF-8 bytes, as PayPal signs it. */
export function crc32(s: string): number {
  let c = 0xffffffff;
  for (const b of Buffer.from(s, "utf8")) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One row of a parameterised read-only query on the pool behind `db`. */
async function one<T>(db: Db, text: string, params: readonly unknown[]): Promise<T | undefined> {
  const r = await db.$client.query(text, [...params]);
  return r.rows[0] as T | undefined;
}

/**
 * The burst's orders were created by Cleared in the product (the M1-04 test payment claims the order for
 * the workspace before PayPal's capture webhook arrives), so their `order` owner rows exist first. Locally
 * (DATABASE_URL) the burst writes those claims; without them every capture waits out the unowned window.
 */
async function claimOrders(workspace: string, tails: readonly string[]): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") throw new Error("the signed burst needs DATABASE_URL (local stack)");
  const db = createDb(url);
  try {
    await db.$client.query(
      `insert into paypal_resource_owner (resource_type, resource_id, workspace_id)
       select 'order', 'LO' || t, $2::uuid from jsonb_array_elements_text($1::jsonb) t on conflict do nothing`,
      [JSON.stringify(tails), workspace],
    );
  } finally {
    await closeDb(db);
  }
}

/** `event_id in (…)` over one JSON array parameter ($1), however many ids. */
const IN_IDS = "(select jsonb_array_elements_text($1::jsonb))";

/** Jobs still to run, excluding the cron schedules' own ticks. */
async function pendingJobs(db: Db, since: Date): Promise<number> {
  const r = await one<{ n: number }>(
    db,
    `select count(*)::int as n from pgboss.job
     where state in ('created', 'retry', 'active') and created_on >= $1
       and name not in (select name from pgboss.schedule)`,
    [since],
  );
  return r?.n ?? 0;
}

async function probeQueue(
  db: Db,
  since: Date,
  eventIds: readonly string[],
  windowS: number,
): Promise<QueueResult> {
  const samples: { tSec: number; pending: number }[] = [];
  const t0 = performance.now();
  const ids = JSON.stringify(eventIds);
  let drainSec: number | null = null;
  let peak = 0;
  for (;;) {
    const tSec = Math.round((performance.now() - t0) / 1000);
    const pending = await pendingJobs(db, since);
    const unprocessed =
      (
        await one<{ n: number }>(
          db,
          `select count(*)::int as n from webhook_events where event_id in ${IN_IDS} and status = 'received'`,
          [ids],
        )
      )?.n ?? 0;
    samples.push({ tSec, pending });
    peak = Math.max(peak, pending);
    if (pending === 0 && unprocessed === 0) {
      drainSec = tSec;
      break;
    }
    if (tSec >= windowS) break;
    await sleep(5000);
  }
  const perEvent = await one<{ one: number; extra: number }>(
    db,
    `select count(*) filter (where n = 1)::int as one, coalesce(sum(n - 1), 0)::int as extra
     from (select event_id, count(*) as n from webhook_events where event_id in ${IN_IDS} group by event_id) e`,
    [ids],
  );
  const dupPayments =
    (
      await one<{ n: number }>(
        db,
        `select coalesce(sum(n - 1), 0)::int as n from
         (select capture_id, count(*) as n from payments where capture_id like 'LB%' group by capture_id) p`,
        [],
      )
    )?.n ?? 0;
  const jobs = await one<{ dlq: number; failed: number }>(
    db,
    `select count(*) filter (where name like '%.dlq')::int as dlq,
       count(*) filter (where state = 'failed')::int as failed from pgboss.job where created_on >= $1`,
    [since],
  );
  const usd = (
    await one<{ usd: string }>(
      db,
      "select coalesce(sum(cost_usd), 0)::text as usd from agent_runs where created_at >= $1",
      [since],
    )
  )?.usd;
  return {
    samples,
    drainSec,
    peakPending: peak,
    events: eventIds.length,
    eventsWithOneRow: perEvent?.one ?? 0,
    duplicates: (perEvent?.extra ?? 0) + dupPayments,
    dlq: jobs?.dlq ?? 0,
    failedJobs: jobs?.failed ?? 0,
    openAiUsd: Number(usd ?? 0),
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const target = flag(flags, "target").replace(/\/$/, "");
  const out = flag(flags, "out");
  const url = `${target}/api/webhooks/paypal`;
  const replayDir = flags.get("replay");
  const phases = phasesOf(flags);
  const rec = new Recorder();
  const notes: string[] = [];
  const startedAt = new Date();
  const sentIds: string[] = [];
  const post = (label: string, body: string, headers: Record<string, string>, at: number) =>
    timedFetch(url, { method: "POST", headers, body }, at, 10_000).then((r) => {
      rec.record(label, r.ms, r.status);
      return r;
    });
  let sched: Awaited<ReturnType<typeof runSchedule>>;
  if (replayDir !== undefined) {
    const deliveries = loadDeliveries(replayDir);
    if (deliveries.length === 0) throw new Error(`no deliveries under ${replayDir}`);
    notes.push(
      `${String(deliveries.length)} recorded deliveries replayed with their original headers; every 5th request forged`,
    );
    sched = await runSchedule(phases, async (i, at) => {
      const d = deliveries[i % deliveries.length] as Delivery;
      if (i % 5 === 4) {
        const f = forge(d);
        await post("forged", f.body, f.headers, at);
      } else await post("replay", d.raw_body, d.headers, at);
    });
  } else {
    const signer: Signer = {
      key: readFileSync(flag(flags, "key", process.env["LOAD_SIGNING_PRIVATE_KEY_FILE"]), "utf8"),
      webhookId: flag(flags, "webhook-id", process.env["PAYPAL_WEBHOOK_ID"]),
      workspace: flag(flags, "workspace", process.env["LOAD_REPLAY_WORKSPACE"]),
    };
    const base = JSON.parse(readFileSync(DELIVERY, "utf8")) as Delivery;
    const total = phases.reduce((n, p) => n + Math.round((p.rate * p.durationMs) / 1000), 0);
    const tails = Array.from({ length: total }, hex15);
    await claimOrders(signer.workspace, tails);
    notes.push(
      `${String(total)} orders claimed for ${signer.workspace} first, as Cleared's own order creation does`,
    );
    sched = await runSchedule(phases, async (i, at) => {
      const e = signedEvent(signer, base, tails[i] ?? hex15());
      const r = await post("signed", e.body, e.headers, at);
      if (r.status === 200) sentIds.push(e.eventId);
      if (i % 20 === 7) {
        const again = await post("redelivery", e.body, e.headers, performance.now());
        if (again.status === 200 && !again.body.includes('"duplicate"'))
          notes.push(`redelivery of ${e.eventId} not deduped`);
      }
    });
  }
  console.log(`load:burst: ${String(sched.sent)} scheduled requests sent to ${url}`);
  const endedAt = new Date();
  const floor = new Recorder();
  await networkFloor(target, floor);
  const server = await serverTimingsFor(target, startedAt, endedAt);
  let queue: QueueResult | undefined;
  const dbUrl = process.env["DATABASE_URL"];
  if (replayDir === undefined && dbUrl !== undefined && dbUrl !== "") {
    const db = createDb(dbUrl);
    try {
      queue = await probeQueue(db, startedAt, sentIds, numFlag(flags, "drain-window", 900));
    } finally {
      await closeDb(db);
    }
  }
  writeResult(out, {
    kind: "burst",
    target,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    commit: commitSha(),
    params: Object.fromEntries([...flags].filter(([k]) => k !== "key")),
    overall: overallOf(rec),
    routes: [...rec.routes(), ...floor.routes()],
    ...(queue === undefined ? {} : { queue }),
    ...(server === null ? {} : { server }),
    notes,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
