// M3-02 test helper (outside src: the core boundary check forbids I/O in packages/core/src): reads the
// recorded `fixtures/openai/explain_hold/*` answers (the message's `output_text`), unvalidated.
import { readFileSync } from "node:fs";

const ROOT = new URL("../../../../", import.meta.url);

export function recordedExplanation(name: string): unknown {
  const fx = JSON.parse(readFileSync(new URL(`fixtures/openai/explain_hold/${name}.json`, ROOT), "utf8")) as {
    response: { body: { output: { type: string; content?: { type: string; text?: string }[] }[] } };
  };
  const text = fx.response.body.output
    .flatMap((o) => (o.type === "message" ? (o.content ?? []) : []))
    .find((c) => c.type === "output_text")?.text;
  return JSON.parse(text ?? "null") as unknown;
}
