// M2-07 test helper (outside src: the core boundary check forbids I/O in packages/core/src): reads the
// recorded M0-05 dispute GETs (`fixtures/paypal/disputes/full/*`).
import { readFileSync } from "node:fs";

const ROOT = new URL("../../../../", import.meta.url);

export interface RecordedDispute {
  readonly dispute_id: string;
  readonly reason: string;
  readonly evidences: { readonly evidence_type: string; readonly source?: string }[];
}

export function recordedDispute(name: string): RecordedDispute {
  const fx = JSON.parse(
    readFileSync(new URL(`fixtures/paypal/disputes/full/${name}.json`, ROOT), "utf8"),
  ) as { response: { body: RecordedDispute } };
  return fx.response.body;
}
