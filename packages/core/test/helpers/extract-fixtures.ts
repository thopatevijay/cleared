// M2-03 test helper (outside src: the core boundary check forbids I/O in packages/core/src): reads the
// recorded `fixtures/openai/extract-v1/*` answers and the synthetic samples they were recorded on.
import { readFileSync } from "node:fs";
import type { Facts } from "../../src/proof/facts-schema.ts";

const ROOT = new URL("../../../../", import.meta.url);

/** The `facts@v1` answer a fixture recorded (its message's `output_text`), unvalidated. */
export function recordedFacts(name: string): Facts {
  const fx = JSON.parse(readFileSync(new URL(`fixtures/openai/extract-v1/${name}.json`, ROOT), "utf8")) as {
    response: { body: { output: { type: string; content?: { type: string; text?: string }[] }[] } };
  };
  const text = fx.response.body.output
    .flatMap((o) => (o.type === "message" ? (o.content ?? []) : []))
    .find((c) => c.type === "output_text")?.text;
  return JSON.parse(text ?? "null") as Facts;
}

export function sampleText(file: string): string {
  return readFileSync(new URL(`fixtures/samples/evidence/${file}`, ROOT), "utf8");
}

export function sampleBase64(file: string): string {
  return readFileSync(new URL(`fixtures/samples/evidence/${file}`, ROOT)).toString("base64");
}
