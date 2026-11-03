// Load-test core (M4-06): an open-loop fixed-rate scheduler, an HDR-style log-bucket histogram, the JSON +
// markdown result writer, and `pnpm load:assert <result.json> [thresholds]`. Native fetch, no dependency.
// Latency is measured from each request's *scheduled* send time, so a stalled server can't hide its queue
// (coordinated omission).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** 1% relative precision: bucket i holds values in [1.01^i, 1.01^(i+1)) ms. */
const GROWTH = 1.01;
const LOG_GROWTH = Math.log(GROWTH);

export class Histogram {
  private readonly buckets = new Map<number, number>();
  count = 0;
  max = 0;
  private sum = 0;

  record(ms: number): void {
    const v = Math.max(ms, 0.001);
    const i = Math.floor(Math.log(v) / LOG_GROWTH);
    this.buckets.set(i, (this.buckets.get(i) ?? 0) + 1);
    this.count += 1;
    this.sum += v;
    if (v > this.max) this.max = v;
  }

  /** The upper edge of the bucket holding the q-th quantile (0 < q ≤ 1), capped at the max seen. */
  quantile(q: number): number {
    if (this.count === 0) return 0;
    const rank = Math.ceil(q * this.count);
    let seen = 0;
    for (const i of [...this.buckets.keys()].sort((a, b) => a - b)) {
      seen += this.buckets.get(i) ?? 0;
      if (seen >= rank) return Math.min(GROWTH ** (i + 1), this.max);
    }
    return this.max;
  }

  mergeFrom(other: Histogram): void {
    for (const [i, n] of other.buckets) this.buckets.set(i, (this.buckets.get(i) ?? 0) + n);
    this.count += other.count;
    this.sum += other.sum;
    this.max = Math.max(this.max, other.max);
  }

  summary(): LatencySummary {
    const r = (n: number): number => Math.round(n * 10) / 10;
    return {
      n: this.count,
      p50: r(this.quantile(0.5)),
      p95: r(this.quantile(0.95)),
      p99: r(this.quantile(0.99)),
      max: r(this.max),
      mean: r(this.count === 0 ? 0 : this.sum / this.count),
    };
  }
}

export interface LatencySummary {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

/** Which statuses count as errors: by default network errors and 5xx (a webhook burst expects its 401s). */
export type ErrorRule = (status: string) => boolean;
export const SERVER_ERRORS: ErrorRule = (s) => s === "error" || /^5\d\d$/.test(s);
/** Read routes: anything but a 2xx or a redirect is an error. */
export const NOT_OK: ErrorRule = (s) => !/^[23]\d\d$/.test(s);

/** Per-label latency and status counts. */
export class Recorder {
  private readonly isError: ErrorRule;
  constructor(isError: ErrorRule = SERVER_ERRORS) {
    this.isError = isError;
  }
  private readonly hist = new Map<string, Histogram>();
  private readonly statuses = new Map<string, Map<string, number>>();

  record(label: string, ms: number, status: number | "error"): void {
    let h = this.hist.get(label);
    if (h === undefined) {
      h = new Histogram();
      this.hist.set(label, h);
    }
    h.record(ms);
    let s = this.statuses.get(label);
    if (s === undefined) {
      s = new Map();
      this.statuses.set(label, s);
    }
    const key = String(status);
    s.set(key, (s.get(key) ?? 0) + 1);
  }

  routes(): RouteResult[] {
    return [...this.hist.keys()].sort().map((label) => {
      const statuses = Object.fromEntries(this.statuses.get(label) ?? []);
      const lat = (this.hist.get(label) ?? new Histogram()).summary();
      return {
        label,
        ...lat,
        statuses,
        errors: countErrors(statuses, this.isError),
        fiveXx: count5xx(statuses),
      };
    });
  }

  /** Every label merged into one histogram (for the overall p95). */
  overall(): LatencySummary {
    const all = new Histogram();
    for (const h of this.hist.values()) all.mergeFrom(h);
    return all.summary();
  }
}

export interface RouteResult extends LatencySummary {
  readonly label: string;
  readonly statuses: Record<string, number>;
  /** per the recorder's ErrorRule */
  readonly errors: number;
  readonly fiveXx: number;
}

const count5xx = (s: Record<string, number>): number =>
  Object.entries(s).reduce((n, [k, v]) => (/^5\d\d$/.test(k) ? n + v : n), 0);
const countErrors = (s: Record<string, number>, isError: ErrorRule): number =>
  Object.entries(s).reduce((n, [k, v]) => (isError(k) ? n + v : n), 0);

export interface Phase {
  /** requests per second */
  readonly rate: number;
  readonly durationMs: number;
}

/**
 * Open loop: request i of a phase is due at phaseStart + i / rate, whether or not earlier ones answered.
 * `fire` gets the scheduled time and must not throw. Resolves when every fired request has settled.
 */
export async function runSchedule(
  phases: readonly Phase[],
  fire: (index: number, scheduledAt: number) => Promise<void>,
): Promise<{ sent: number; startedAt: number; endedAt: number }> {
  const inflight = new Set<Promise<void>>();
  const startedAt = performance.now();
  let t0 = startedAt;
  let index = 0;
  for (const p of phases) {
    const total = Math.round((p.rate * p.durationMs) / 1000);
    for (let i = 0; i < total; i += 1) {
      const due = t0 + (i * 1000) / p.rate;
      const wait = due - performance.now();
      if (wait > 1) await sleep(wait);
      const pr = fire(index, due).finally(() => inflight.delete(pr));
      inflight.add(pr);
      index += 1;
    }
    t0 += p.durationMs;
    const rest = t0 - performance.now();
    if (rest > 1) await sleep(rest);
  }
  const lastSentAt = performance.now();
  await Promise.all(inflight);
  return { sent: index, startedAt, endedAt: lastSentAt };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One timed fetch; latency from `scheduledAt` (performance.now() clock). */
export async function timedFetch(
  url: string,
  init: RequestInit,
  scheduledAt: number,
  timeoutMs = 30_000,
): Promise<{ ms: number; status: number | "error"; body: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    const body = await res.text();
    return { ms: performance.now() - scheduledAt, status: res.status, body };
  } catch {
    return { ms: performance.now() - scheduledAt, status: "error", body: "" };
  }
}

// ---------- CLI args ----------

export function parseArgs(argv: readonly string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(a.slice(2), "true");
    else {
      flags.set(a.slice(2), next);
      i += 1;
    }
  }
  return { positional, flags };
}

export function flag(flags: Map<string, string>, name: string, fallback?: string): string {
  const v = flags.get(name) ?? fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}

export function numFlag(flags: Map<string, string>, name: string, fallback?: number): number {
  const raw = flags.get(name);
  if (raw === undefined) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number (got ${raw})`);
  return n;
}

// ---------- results ----------

export interface LoadResult {
  readonly kind: "launch" | "burst";
  readonly target: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly commit: string;
  readonly params: Record<string, unknown>;
  readonly overall: LatencySummary & {
    readonly requests: number;
    readonly errorRate: number;
    readonly fiveXx: number;
  };
  readonly routes: readonly RouteResult[];
  /** burst only: queue and table probes (local runs with DATABASE_URL) */
  readonly queue?: QueueResult;
  /** remote runs: the server's own timings per route, from Render's request log (render-logs.ts) */
  readonly server?: ServerTimings;
  readonly notes: readonly string[];
}

export interface ServerTimings {
  readonly source: string;
  readonly byRoute: Record<string, LatencySummary & { readonly statuses: Record<string, number> }>;
}

/** Rows that measure the network, not a route: never held to a route threshold. */
const isProbe = (label: string): boolean => label.startsWith("healthz");

export interface QueueResult {
  readonly samples: readonly { readonly tSec: number; readonly pending: number }[];
  /** seconds from the last request sent to an empty queue; null = never drained within the window */
  readonly drainSec: number | null;
  readonly peakPending: number;
  readonly events: number;
  readonly eventsWithOneRow: number;
  readonly duplicates: number;
  readonly dlq: number;
  readonly failedJobs: number;
  readonly openAiUsd: number;
}

export function commitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return process.env["GIT_COMMIT"] ?? "unknown";
  }
}

export function overallOf(rec: Recorder): LoadResult["overall"] {
  const routes = rec.routes();
  const requests = routes.reduce((n, r) => n + r.n, 0);
  const errors = routes.reduce((n, r) => n + r.errors, 0);
  const fiveXx = routes.reduce((n, r) => n + r.fiveXx, 0);
  return { ...rec.overall(), requests, errorRate: requests === 0 ? 0 : errors / requests, fiveXx };
}

export function writeResult(out: string, r: LoadResult): void {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
  writeFileSync(out.replace(/\.json$/, "") + ".md", markdown(r));
  console.log(markdown(r));
}

export function markdown(r: LoadResult): string {
  const lines = [
    `### ${r.kind} · ${r.target}`,
    "",
    `${r.startedAt} → ${r.endedAt} · commit \`${r.commit}\` · ${JSON.stringify(r.params)}`,
    "",
    "| Route | n | p50 ms | p95 ms | p99 ms | max ms | statuses | errors |",
    "|---|---:|---:|---:|---:|---:|---|---:|",
    ...r.routes.map(
      (x) =>
        `| ${x.label} | ${String(x.n)} | ${String(x.p50)} | ${String(x.p95)} | ${String(x.p99)} | ${String(x.max)} | ${Object.entries(
          x.statuses,
        )
          .map(([k, v]) => `${k}×${String(v)}`)
          .join(" ")} | ${String(x.errors)} |`,
    ),
    `| **all** | ${String(r.overall.requests)} | ${String(r.overall.p50)} | ${String(r.overall.p95)} | ${String(r.overall.p99)} | ${String(r.overall.max)} | 5xx×${String(r.overall.fiveXx)} | ${(r.overall.errorRate * 100).toFixed(2)}% |`,
  ];
  if (r.queue !== undefined) {
    const q = r.queue;
    lines.push(
      "",
      `Queue: peak ${String(q.peakPending)} pending · drain ${q.drainSec === null ? "NOT drained" : `${String(q.drainSec)} s`} after the last send · events ${String(q.events)} (${String(q.eventsWithOneRow)} with exactly one row) · duplicates ${String(q.duplicates)} · DLQ ${String(q.dlq)} · failed jobs ${String(q.failedJobs)} · OpenAI $${q.openAiUsd.toFixed(4)}`,
    );
  }
  if (r.server !== undefined) {
    lines.push(
      "",
      `Server-side (${r.server.source}, \`durationMs\` per request line):`,
      "",
      "| Route | n | p50 ms | p95 ms | p99 ms | max ms | statuses |",
      "|---|---:|---:|---:|---:|---:|---|",
      ...Object.entries(r.server.byRoute).map(
        ([route, x]) =>
          `| ${route} | ${String(x.n)} | ${String(x.p50)} | ${String(x.p95)} | ${String(x.p99)} | ${String(x.max)} | ${Object.entries(
            x.statuses,
          )
            .map(([k, v]) => `${k}×${String(v)}`)
            .join(" ")} |`,
      ),
    );
  }
  for (const n of r.notes) lines.push("", `- ${n}`);
  return `${lines.join("\n")}\n`;
}

// ---------- assert ----------

/** Returns the failed checks (empty = pass). Threshold flags: see the usage line below. */
export function assertResult(r: LoadResult, flags: Map<string, string>): string[] {
  const fails: string[] = [];
  const check = (ok: boolean, msg: string): void => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
    if (!ok) fails.push(msg);
  };
  const p95 = flags.get("p95");
  if (p95 !== undefined) {
    for (const route of r.routes.filter((x) => !x.label.startsWith("forged") && !isProbe(x.label))) {
      check(route.p95 < Number(p95), `${route.label} p95 ${String(route.p95)} ms < ${p95} ms`);
    }
  }
  const err = flags.get("err");
  if (err !== undefined) {
    check(
      r.overall.errorRate < Number(err),
      `error rate ${(r.overall.errorRate * 100).toFixed(3)}% < ${String(Number(err) * 100)}%`,
    );
  }
  const ackP95 = flags.get("ack-p95");
  if (ackP95 !== undefined) {
    for (const route of r.routes.filter((x) => !x.label.startsWith("forged") && !isProbe(x.label))) {
      check(route.p95 < Number(ackP95), `${route.label} ack p95 ${String(route.p95)} ms < ${ackP95} ms`);
      // a refused connection is fast too: an ack only counts when the server answered
      check(
        route.errors === 0,
        `${route.label}: every request answered, no 5xx (${JSON.stringify(route.statuses)})`,
      );
    }
  }
  const forgedP95 = flags.get("forged-p95") ?? (ackP95 !== undefined ? "200" : undefined);
  // The refusal time is the server's (`webhook_ack_ms`, what PayPal waits on). From a client far from
  // Oregon, the round trip alone exceeds 200 ms (the `healthz (network floor)` row), so when the run captured
  // Render's request log the server-side p95 of the webhook route is checked, and the client figure is shown.
  const serverWebhook = r.server?.byRoute["/api/webhooks/paypal"];
  for (const route of r.routes.filter((x) => x.label.startsWith("forged"))) {
    if (forgedP95 !== undefined && serverWebhook !== undefined) {
      check(
        serverWebhook.p95 < Number(forgedP95),
        `${route.label}: server-side refusal p95 ${String(serverWebhook.p95)} ms < ${forgedP95} ms (client-side ${String(route.p95)} ms incl. network; ${r.server?.source ?? ""})`,
      );
    } else if (forgedP95 !== undefined) {
      check(
        route.p95 < Number(forgedP95),
        `${route.label} p95 ${String(route.p95)} ms < ${forgedP95} ms (client-side)`,
      );
    }
    const accepted = Object.entries(route.statuses).filter(([k]) => !/^4\d\d$/.test(k));
    check(
      accepted.length === 0,
      `${route.label}: every forged delivery refused with a 4xx (${JSON.stringify(route.statuses)})`,
    );
  }
  const fiveXx = flags.get("5xx");
  if (fiveXx !== undefined)
    check(r.overall.fiveXx <= Number(fiveXx), `5xx ${String(r.overall.fiveXx)} ≤ ${fiveXx}`);
  const q = r.queue;
  const need = (name: string): boolean => flags.has(name);
  if ((need("dup") || need("dlq") || need("drain")) && q === undefined) {
    check(false, "queue probes present (run the burst with DATABASE_URL set)");
    return fails;
  }
  if (q !== undefined) {
    if (need("dup"))
      check(
        q.duplicates <= Number(flags.get("dup")),
        `duplicates ${String(q.duplicates)} ≤ ${String(flags.get("dup"))}`,
      );
    if (need("dlq"))
      check(q.dlq <= Number(flags.get("dlq")), `DLQ ${String(q.dlq)} ≤ ${String(flags.get("dlq"))}`);
    if (need("drain")) {
      check(
        q.drainSec !== null && q.drainSec <= Number(flags.get("drain")),
        `drain ${String(q.drainSec)} s ≤ ${String(flags.get("drain"))} s`,
      );
    }
    if (need("dup")) {
      const sent = r.routes.find((x) => x.label === "signed")?.n ?? 0;
      check(
        q.events > 0 && q.events === sent,
        `every signed event acked 200 (${String(q.events)}/${String(sent)})`,
      );
      check(
        q.eventsWithOneRow === q.events,
        `every event has exactly one webhook_events row (${String(q.eventsWithOneRow)}/${String(q.events)})`,
      );
    }
    check(q.openAiUsd === 0, `OpenAI spend during the run $${q.openAiUsd.toFixed(4)} = $0`);
  }
  return fails;
}

function assertMain(argv: readonly string[]): void {
  const { positional, flags } = parseArgs(argv);
  const file = positional[0];
  if (file === undefined) {
    throw new Error(
      "usage: pnpm load:assert <result.json> [--p95 ms] [--err ratio] [--ack-p95 ms] [--forged-p95 ms] [--5xx n] [--dup n] [--dlq n] [--drain s]",
    );
  }
  const r = JSON.parse(readFileSync(file, "utf8")) as LoadResult;
  const fails = assertResult(r, flags);
  console.log(fails.length === 0 ? "load:assert: PASS" : `load:assert: FAIL (${String(fails.length)})`);
  if (fails.length > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    assertMain(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
