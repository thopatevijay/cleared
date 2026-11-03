// The webhook test signing harness at runtime (M4-06; the M1-04 re-signing of `test/webhooks/support.ts`
// made available to a running server). With NODE_ENV=test and PAYPAL_WEBHOOK_TEST_PUBLIC_KEY_FILE set,
// the route's verifier trusts that public key for ONE cert URL (`TEST_CERT_URL`, on the sandbox cert
// host), so the local 100× burst can post unique signed events without PayPal. Any other NODE_ENV with
// the variable set refuses to boot (instrumentation.ts) and the route refuses to build its verifier:
// production can never trust a key it didn't fetch from PayPal.
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CertCache } from "@cleared/adapters";

export const TEST_SIGNING_KEY_ENV = "PAYPAL_WEBHOOK_TEST_PUBLIC_KEY_FILE";
/** The cert URL test-signed deliveries name (a real-looking path on the sandbox cert host). */
export const TEST_CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-M4-06-TEST-HARNESS";

export class TestSigningRefusedError extends Error {
  override readonly name = "TestSigningRefusedError";
}

type Env = Readonly<Record<string, string | undefined>>;

/** Throws when the harness is configured outside NODE_ENV=test. Called at boot and when the verifier is built. */
export function assertTestSigningAllowed(env: Env): void {
  const file = env[TEST_SIGNING_KEY_ENV];
  if (file === undefined || file === "") return;
  if (env["NODE_ENV"] !== "test") {
    throw new TestSigningRefusedError(
      `${TEST_SIGNING_KEY_ENV} is set but NODE_ENV is ${env["NODE_ENV"] ?? "unset"}: the webhook test signing harness runs only under NODE_ENV=test`,
    );
  }
}

/** Under NODE_ENV=test with the key file set: trusts that key for TEST_CERT_URL in `cache`. Returns whether it did. */
export function installTestSigningKey(env: Env, cache: CertCache, now = Date.now()): boolean {
  assertTestSigningAllowed(env);
  const file = env[TEST_SIGNING_KEY_ENV];
  if (file === undefined || file === "") return false;
  cache.set(TEST_CERT_URL, {
    publicKey: createPublicKey(readFileSync(file, "utf8")),
    validFrom: new Date(now - 86_400_000),
    validTo: new Date(now + 86_400_000),
  });
  return true;
}
