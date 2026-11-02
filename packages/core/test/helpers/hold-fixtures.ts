// M3-01: recorded fixtures for the hold tests (read here, outside src/, so the domain core imports no I/O).
import { readFileSync } from "node:fs";

const ROOT = new URL("../../../../fixtures/", import.meta.url);

/** A fixture file under fixtures/, parsed (the caller states its shape). */
export function fixtureJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));
}
