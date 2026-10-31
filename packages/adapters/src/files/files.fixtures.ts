// Test-only: reads the synthetic evidence files (fixtures/files/, made by test/files/make-fixtures.ts)
// and the M0 sample evidence (fixtures/samples/evidence/).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));

export const fixtureFile = (name: string): Uint8Array => new Uint8Array(readFileSync(`${ROOT}files/${name}`));
export const sampleEvidence = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(`${ROOT}samples/evidence/${name}`));

/** True when the bytes contain the ASCII text anywhere. */
export const containsAscii = (bytes: Uint8Array, text: string): boolean =>
  Buffer.from(bytes).includes(Buffer.from(text, "latin1"));
