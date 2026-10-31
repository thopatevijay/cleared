// M2-04 test helper (outside src: the core boundary check forbids I/O in packages/core/src): the M0-07 spike's
// recorded `check_scope` answers (`fixtures/openai/scope-pass{1,2}/*`) and the synthetic sample packs they were
// recorded on, as `ScopeCheckInput`s in the spike's block order (E1 brief, E2 chat, E3.. deliveries).
import { readFileSync } from "node:fs";
import type { EvidenceKind } from "../../src/proof/evidence.ts";
import type { ScopeCheckInput, ScopeItemInput } from "../../src/proof/scope-check.ts";
import { sampleBase64, sampleText } from "./extract-fixtures.ts";

const ROOT = new URL("../../../../", import.meta.url);

/** The JSON answer a fixture recorded (its message's `output_text`), unvalidated. */
export function recordedAnswer(path: string): unknown {
  const fx = JSON.parse(readFileSync(new URL(`fixtures/openai/${path}.json`, ROOT), "utf8")) as {
    response: { body: { output: { type: string; content?: { type: string; text?: string }[] }[] } };
  };
  const text = fx.response.body.output
    .flatMap((o) => (o.type === "message" ? (o.content ?? []) : []))
    .find((c) => c.type === "output_text")?.text;
  return JSON.parse(text ?? "null") as unknown;
}

/** A sample file as M2-01 stores it: text (a PDF's text layer from its `.pdf.txt`), or an image's bytes. */
export function sampleItem(ref: string, kind: EvidenceKind, file: string): ScopeItemInput {
  const sha256 = ref.slice(1).padStart(64, "0");
  if (file.endsWith(".png"))
    return {
      ref,
      kind,
      sha256,
      content: { type: "image", mimeType: "image/png", base64: sampleBase64(file) },
    };
  const text = sampleText(file.endsWith(".pdf") ? `${file}.txt` : file);
  return { ref, kind, sha256, content: { type: "text", text } };
}

export const SPIKE_PACKS = {
  logo: ["brief-logo.txt", "chat-logo.txt", "delivery-logo.pdf", "screenshot-logo.png"],
  "logo-control": ["brief-logo.txt", "chat-logo-control.txt", "delivery-logo.pdf", "screenshot-logo.png"],
  translation: ["brief-translation.txt", "chat-translation.txt", "delivery-translation.pdf"],
  website: ["brief-website.txt", "chat-website.txt", "screenshot-website.png"],
} as const;
export type SpikePack = keyof typeof SPIKE_PACKS;

const KIND_BY_PREFIX: Record<string, EvidenceKind> = {
  brief: "scope",
  chat: "communication",
  delivery: "delivery",
  screenshot: "delivery",
};

export function spikePackInput(pack: SpikePack): ScopeCheckInput {
  const items = SPIKE_PACKS[pack].map((file, i) =>
    sampleItem(`E${String(i + 1)}`, KIND_BY_PREFIX[file.split("-")[0] ?? ""] ?? "delivery", file),
  );
  return { items, facts: [] };
}

/** The M0-07 runs: which sample pack each recorded run used. */
export const SPIKE_RUNS: Readonly<Record<string, SpikePack>> = {
  r1: "logo",
  r2: "translation",
  r3: "website",
  r4: "logo",
  r5: "logo",
  c1: "logo-control",
};
