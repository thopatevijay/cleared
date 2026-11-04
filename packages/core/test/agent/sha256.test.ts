// BL-01 6601208506: the core's SHA-256 is plain TypeScript (no node:crypto in the client bundle). It must
// equal node:crypto byte for byte: approvals are bound to the payload hash, and stored hashes must not move.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256HexPure } from "../../src/agent/sha256.ts";

const node = (d: string | Uint8Array): string =>
  typeof d === "string"
    ? createHash("sha256").update(d, "utf8").digest("hex")
    : createHash("sha256").update(d).digest("hex");

describe("sha256HexPure", () => {
  it("matches the FIPS 180-4 vectors", () => {
    expect(sha256HexPure("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256HexPure("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256HexPure("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("equals node:crypto for every length across the block and padding boundaries", () => {
    for (let n = 0; n <= 200; n += 1) {
      const b = randomBytes(n);
      expect(sha256HexPure(new Uint8Array(b)), `length ${String(n)}`).toBe(node(b));
    }
  });

  it("equals node:crypto for multi-byte UTF-8 strings and a 1 MB buffer", () => {
    for (const s of ["नमस्ते, दुनिया", "€ 120.00 — ✓", "😀 emoji 𝔘𝔫𝔦𝔠𝔬𝔡𝔢", '{"a":1,"b":[true,null]}']) {
      expect(sha256HexPure(s)).toBe(node(s));
    }
    const big = randomBytes(1024 * 1024 + 13);
    expect(sha256HexPure(new Uint8Array(big))).toBe(node(big));
  });
});
