// M1-05 live proof: sends ONE real magic-link email through the product's Resend sender and recipient
// guard to the first EMAIL_RECIPIENT_ALLOWLIST address, logs the Resend email id (never the token), and
// with --record writes the scrubbed exchange to fixtures/resend/send-email.json (`meta.env = "live"`:
// Resend has no sandbox). The token in the link is random and never stored, so the link cannot sign in.
//
//   pnpm tsx --env-file=<path to .env> scripts/spikes/resend.ts --record
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Exchange } from "../../packages/adapters/src/http/client.ts";
import { createResendSender } from "../../packages/adapters/src/email/resend.ts";
import { parseAllowlist, withRecipientGuard } from "../../packages/adapters/src/email/sender.ts";
import { magicLinkEmail } from "../../packages/adapters/src/email/templates/render.ts";
import { createRecorder } from "../../packages/adapters/src/testing/record.ts";
import { createScrubber, REDACTED } from "../../packages/adapters/src/testing/scrub.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RECORD = process.argv.includes("--record");

const apiKey = process.env.RESEND_API_KEY ?? "";
const from = process.env.EMAIL_FROM ?? "";
const allowlist = parseAllowlist(process.env.EMAIL_RECIPIENT_ALLOWLIST);
if (apiKey === "" || from === "") throw new Error("RESEND_API_KEY / EMAIL_FROM not set (node --env-file)");
if (allowlist === null || allowlist[0] === undefined) throw new Error("EMAIL_RECIPIENT_ALLOWLIST is not set");
const to = allowlist[0];

const token = randomBytes(32).toString("base64url");
const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
const url = `${base}/api/auth/verify?token=${token}`;

const scrubber = createScrubber({ secrets: () => [apiKey, token] });
const recorder = createRecorder({
  dir: join(ROOT, "fixtures/resend"),
  ticket: "M1-05",
  scrubber,
  env: "live",
  // The token is also removed by `secrets`; this keeps the redaction explicit in the stored body.
  transform: (e: Exchange) => ({
    ...e,
    request: { ...e.request, body: e.request.body?.split(token).join(REDACTED) },
  }),
});
recorder.label("send-email", "one live magic-link send to the allowlisted test recipient (M1-05 live proof)");

const sender = withRecipientGuard(
  createResendSender({ apiKey, from, ...(RECORD ? { onExchange: recorder.onExchange } : {}) }),
  allowlist,
);
const rendered = magicLinkEmail("en", { url, minutes: 15 });
const result = await sender.send({ to, ...rendered, idempotencyKey: randomUUID() });
if (result.kind !== "sent") throw new Error(`send refused: ${result.reason}`);
console.log(JSON.stringify({ msg: "resend email sent", emailId: result.id, recorded: recorder.written }));
