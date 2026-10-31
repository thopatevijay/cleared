// canonicalHash: sha256 over canonicalJson (sorted keys, no whitespace), UTF-8, lowercase hex. One
// function binds an approval to a payload (M2-08) and keys the agent's content-hash cache (M2-02).
// node:crypto is pure computation, not I/O (ADR 0001 keeps I/O out of the core).
import { createHash } from "node:crypto";
import type { Sha256 } from "../ids.ts";
import { canonicalJson, type JsonValue } from "../actions/canonical-json.ts";

export function sha256Hex(data: string | Uint8Array): Sha256 {
  const hash = createHash("sha256");
  if (typeof data === "string") hash.update(data, "utf8");
  else hash.update(data);
  return hash.digest("hex") as Sha256;
}

export function canonicalHash(value: JsonValue): Sha256 {
  return sha256Hex(canonicalJson(value));
}
