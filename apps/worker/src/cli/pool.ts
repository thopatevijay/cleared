// Review-hold pool CLI (M3-10, ADR 0019; owner runbook: docs/runbooks/review-hold-pool.md):
//   pnpm --filter ./apps/worker run pool:create -- --count N --purpose video|judge
//   pnpm --filter ./apps/worker run pool:capture
//   pnpm --filter ./apps/worker run pool:status [-- --urls]
//   pnpm --filter ./apps/worker run pool:assign -- --workspace <uuid>      (the video pool only)
// Reads DATABASE_URL, PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET and APP_BASE_URL from the environment and
// prints ids, states and the buyer-approval URLs only: never a token, secret or credential. `pool:status`
// reads the database only (no PayPal call).
import { correlationIdOrNew } from "@cleared/adapters";
import { REVIEW_POOL_PURPOSES, type ReviewPoolPurpose } from "@cleared/core";
import { closeDb, createDb, createPublisher, createQueue, databaseUrl, platform, type Db } from "@cleared/db";
import { paypalClientsFromEnv } from "../paypal.ts";
import { assignVideo, capturePool, createPool, statusTable, type PoolDeps } from "./pool-ops.ts";

export const POOL_COMMANDS = ["create", "capture", "status", "assign"] as const;
type Command = (typeof POOL_COMMANDS)[number];

const USAGE = [
  "usage: pool.ts create --count N --purpose video|judge",
  "       pool.ts capture",
  "       pool.ts status [--urls]",
  "       pool.ts assign --workspace <workspace uuid>",
].join("\n");

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function isPurpose(v: string | undefined): v is ReviewPoolPurpose {
  return (REVIEW_POOL_PURPOSES as readonly (string | undefined)[]).includes(v);
}

export interface PoolIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Runs one command with `deps` (PayPal-backed except `status`); returns the exit code. */
export async function runPool(
  argv: readonly string[],
  deps: {
    readonly db: Db;
    readonly paypal: () => Promise<PoolDeps>;
    readonly now: () => Date;
    readonly returnUrl: string;
  },
  io: PoolIo,
): Promise<number> {
  const [command, ...rest] = argv.filter((a) => a !== "--");
  switch (command as Command | undefined) {
    case "status": {
      const rows = await platform(deps.db).reviewHoldPool.list();
      io.out(statusTable(rows, deps.now()));
      if (rest.includes("--urls")) {
        for (const r of rows.filter((x) => x.state === "awaiting_buyer"))
          io.out(`approve ${r.orderId}: ${r.approveUrl}`);
      }
      return 0;
    }
    case "create": {
      const purpose = arg(rest, "--purpose");
      const count = Number(arg(rest, "--count"));
      if (!isPurpose(purpose) || !Number.isInteger(count)) break;
      const created = await createPool(await deps.paypal(), { count, purpose, returnUrl: deps.returnUrl });
      io.out(
        `created ${String(created.length)} ${purpose}-pool order(s); approve each as the sandbox buyer:`,
      );
      for (const c of created) io.out(`${c.orderId}  ${c.amount}  ${c.approveUrl}`);
      return 0;
    }
    case "capture": {
      const results = await capturePool(await deps.paypal());
      for (const r of results) {
        const paypal =
          r.result === "error"
            ? (r.captureReason ?? "-")
            : r.captureStatus === null
              ? (r.orderStatus ?? "-")
              : `${r.captureStatus}/${r.captureReason ?? "-"}`;
        io.out(
          `${r.purpose.padEnd(5)}  ${r.orderId}  ${r.result.padEnd(17)}  ${r.captureId ?? "-"}  ${paypal}`,
        );
      }
      const failed = results.filter((r) => r.result === "error").length;
      io.out(`${String(results.length)} pool rows checked, ${String(failed)} failed`);
      return failed === 0 ? 0 : 1;
    }
    case "assign": {
      const workspaceId = arg(rest, "--workspace");
      if (workspaceId === undefined) break;
      const a = await assignVideo(deps.db, workspaceId, deps.now());
      if (a === null) {
        io.err(
          "no video-pool payment is assignable (held, unassigned, under 20 h old): create and approve one",
        );
        return 1;
      }
      io.out(`assigned capture ${a.captureId} (order ${a.orderId}) to workspace ${a.workspaceId}`);
      return 0;
    }
  }
  io.err(USAGE);
  return 2;
}

async function main(argv: readonly string[]): Promise<number> {
  const db = createDb(databaseUrl());
  const queue: { stop?: () => Promise<void> } = {};
  const paypal = async (): Promise<PoolDeps> => {
    const boss = await createQueue(db, { background: false, max: 2 });
    queue.stop = () => boss.stop({ graceful: false });
    return {
      db,
      orders: paypalClientsFromEnv(process.env).orders,
      publisher: createPublisher(db, boss, correlationIdOrNew),
      now: () => new Date(),
    };
  };
  try {
    return await runPool(
      argv,
      { db, paypal, now: () => new Date(), returnUrl: process.env["APP_BASE_URL"] ?? "https://example.com/" },
      {
        out: (l) => {
          console.log(l);
        },
        err: (l) => {
          console.error(l);
        },
      },
    );
  } finally {
    await queue.stop?.();
    await closeDb(db);
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // the message only: an HTTP error's body or headers never reach stdout
      console.error(error instanceof Error ? error.message : "pool command failed");
      process.exitCode = 1;
    },
  );
}
