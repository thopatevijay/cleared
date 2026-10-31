// canonicalJson: the hash input for an approval (sorted keys, no whitespace). canonicalHash
// (agent/canonical-hash.ts) is sha256 over it.
// The same value always yields the same string, whatever order its keys were built in.

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue | undefined };

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .flatMap((key) => {
      const v = value[key];
      return v === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(v)}`];
    });
  return `{${entries.join(",")}}`;
}

function isArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
