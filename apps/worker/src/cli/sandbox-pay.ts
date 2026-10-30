// `pnpm --filter @cleared/worker sandbox:pay -- --workspace <id> [--amount 42.00]` (M1-04): one real
// sandbox card payment owned by the workspace, through the same code as the `sandbox.test_payment`
// job. Prints the order and capture ids; the payment row then arrives through the webhook path.
// Reads DATABASE_URL and PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from the environment, never printing them.
import { randomUUID } from "node:crypto";
import { closeDb, createDb, databaseUrl } from "@cleared/db";
import { runTestPayment, TestPaymentInputSchema } from "../jobs/test-payment.ts";
import { paypalClientsFromEnv } from "../paypal.ts";

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

async function cli(argv: readonly string[]): Promise<number> {
  const workspaceId = arg(argv, "--workspace");
  const value = arg(argv, "--amount");
  const input = TestPaymentInputSchema.safeParse({
    workspaceId,
    ...(value === undefined ? {} : { amount: { currency_code: "USD", value } }),
  });
  if (!input.success) {
    console.error("usage: sandbox:pay -- --workspace <workspace uuid> [--amount 42.00]");
    return 2;
  }
  const db = createDb(databaseUrl());
  try {
    const requestId = randomUUID();
    const started = Date.now();
    const out = await runTestPayment(
      { db, orders: paypalClientsFromEnv(process.env).orders },
      input.data,
      requestId,
    );
    console.log(
      JSON.stringify({
        msg: "sandbox test payment captured",
        workspaceId: input.data.workspaceId,
        requestId,
        ...out,
        capturedAt: new Date().toISOString(),
        ms: Date.now() - started,
      }),
    );
    return 0;
  } finally {
    await closeDb(db);
  }
}

cli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
