// sha256 for evidence (M2-01). The rule (what is hashed) is @cleared/core's; the digest is taken here.
import { createHash } from "node:crypto";
import { evidenceHashInput, Sha256Schema, type Sha256 } from "@cleared/core";

export function sha256Of(bytes: Uint8Array): Sha256 {
  return Sha256Schema.parse(createHash("sha256").update(bytes).digest("hex"));
}

/** Stored bytes for a file item; the normalised text's UTF-8 bytes for a text item. */
export function evidenceSha256(
  input:
    { readonly kind: "file"; readonly bytes: Uint8Array } | { readonly kind: "text"; readonly text: string },
): Sha256 {
  return sha256Of(evidenceHashInput(input));
}
