// The fixture format (fixtures/README.md): one recorded exchange per file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const FixtureSchema = z.object({
  meta: z.object({
    recorded_at: z.string(),
    // "sandbox" for PayPal; "live" for vendors without a sandbox (OpenAI, M0-07)
    env: z.enum(["sandbox", "live"]),
    ticket: z.string(),
    scrubbed: z.literal(true),
    note: z.string().optional(),
  }),
  request: z.object({
    method: z.string(),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.unknown(),
  }),
  response: z.object({
    status: z.number().int(),
    headers: z.record(z.string(), z.string()),
    body: z.unknown(),
  }),
});
export type Fixture = z.infer<typeof FixtureSchema>;

/** Absolute path of the repo-root `fixtures/` directory. */
export const FIXTURES_DIR = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));

/** Loads `fixtures/<rel>.json` (rel like `paypal/orders/create-goods-a`) and validates its shape. */
export function loadFixture(rel: string): Fixture {
  const file = `${FIXTURES_DIR}${rel}.json`;
  return FixtureSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** The response body as JSON text, the way the vendor sent it. */
export function responseText(f: Fixture): string {
  return typeof f.response.body === "string" ? f.response.body : JSON.stringify(f.response.body);
}
