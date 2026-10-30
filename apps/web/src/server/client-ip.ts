// The client IP behind Render's proxy (M1-05). Render sets `True-Client-IP`; otherwise the LAST
// `X-Forwarded-For` hop is the one the proxy appended. The first hop is whatever the client sent, so it
// is never trusted. The real header is confirmed on Render in M1-07.
import { createHmac } from "node:crypto";

export const UNKNOWN_IP = "unknown";

export function clientIp(headers: Headers): string {
  const trueClient = headers.get("true-client-ip")?.trim();
  if (trueClient) return trueClient;
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
  return hops.at(-1) ?? UNKNOWN_IP;
}

/** HMAC-SHA256(secret, ip) as hex: what the caps store and count; the raw IP is never stored. */
export function ipHash(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(`ip:${ip}`).digest("hex");
}

/**
 * A stable uuid for an anonymous caller (derived from the IP hash), used as the Idempotency-Key scope on
 * routes that run before a session exists (demo, magic link).
 */
export function anonymousScopeId(ipHashHex: string): string {
  const h = ipHashHex.slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
