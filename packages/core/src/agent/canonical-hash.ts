// canonicalHash: sha256 over canonicalJson (sorted keys, no whitespace), UTF-8, lowercase hex. One
// function binds an approval to a payload (M2-08) and keys the agent's content-hash cache (M2-02).
// The hash is plain TypeScript (sha256.ts), not node:crypto, so client components importing the core barrel
// ship no crypto polyfill (BL-01 6601208506). Pure computation, not I/O (ADR 0001).
import type { Sha256 } from "../ids.ts";
import { canonicalJson, type JsonValue } from "../actions/canonical-json.ts";
import { sha256HexPure } from "./sha256.ts";

export function sha256Hex(data: string | Uint8Array): Sha256 {
  return sha256HexPure(data) as Sha256;
}

export function canonicalHash(value: JsonValue): Sha256 {
  return sha256Hex(canonicalJson(value));
}
