// M4-06 AC 4: the webhook test signing harness works under NODE_ENV=test and is refused anywhere else,
// at boot (instrumentation `register`) and when the route builds its verifier.
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpClient, createWebhookVerifier, signedString } from "@cleared/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertTestSigningAllowed,
  installTestSigningKey,
  TEST_CERT_URL,
  TEST_SIGNING_KEY_ENV,
  TestSigningRefusedError,
} from "../../src/server/test-signing.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyFile = join(mkdtempSync(join(tmpdir(), "m406-")), "pub.pem");
writeFileSync(keyFile, keys.publicKey.export({ type: "spki", format: "pem" }));

function offlineVerifier() {
  const http = createHttpClient({
    vendor: "paypal-cert",
    timeoutMs: 100,
    maxRetries: 0,
    fetch: () => Promise.reject(new Error("no network in this test")),
  });
  return createWebhookVerifier({ http });
}

function signed(webhookId: string) {
  const rawBody = JSON.stringify({ id: "WH-M4-06-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} });
  const transmissionId = "11111111-2222-4333-8444-555555555555";
  const transmissionTime = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const sig = sign("sha256", Buffer.from(signedString({ transmissionId, transmissionTime, webhookId, rawBody })), keys.privateKey);
  return {
    rawBody,
    webhookId,
    headers: {
      "paypal-transmission-id": transmissionId,
      "paypal-transmission-time": transmissionTime,
      "paypal-transmission-sig": sig.toString("base64"),
      "paypal-cert-url": TEST_CERT_URL,
      "paypal-auth-algo": "SHA256withRSA",
    },
  };
}

describe("webhook test signing harness (M4-06)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("verifies a harness-signed delivery under NODE_ENV=test, with no network", async () => {
    const verifier = offlineVerifier();
    expect(installTestSigningKey({ NODE_ENV: "test", [TEST_SIGNING_KEY_ENV]: keyFile }, verifier.cache)).toBe(true);
    const r = await verifier.verifyWebhook(signed("WH-LOADTEST-LOCAL"));
    expect(r.ok).toBe(true);
  });

  it("is off when the key file is not configured", () => {
    const verifier = offlineVerifier();
    expect(installTestSigningKey({ NODE_ENV: "production" }, verifier.cache)).toBe(false);
    expect(verifier.cache.size).toBe(0);
  });

  it.each(["production", "development", undefined])("refuses the harness under NODE_ENV=%s", (nodeEnv) => {
    const env = { NODE_ENV: nodeEnv, [TEST_SIGNING_KEY_ENV]: keyFile };
    expect(() => {
      assertTestSigningAllowed(env);
    }).toThrow(TestSigningRefusedError);
    const verifier = offlineVerifier();
    expect(() => installTestSigningKey(env, verifier.cache)).toThrow(TestSigningRefusedError);
    expect(verifier.cache.size).toBe(0);
  });

  it("production refuses it at boot: instrumentation register() throws", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(TEST_SIGNING_KEY_ENV, keyFile);
    const { register } = await import("../../instrumentation.ts");
    await expect(register()).rejects.toThrow(TestSigningRefusedError);
  });
});
