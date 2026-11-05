// The client IP behind Render's proxy (M1-05). Render sets `True-Client-IP`; otherwise the LAST
// `X-Forwarded-For` hop is the one the proxy appended. The first hop is whatever the client sent, so it
// is never trusted. Confirmed on Render (BL-01 6530992863): production `render logs` on 2026-11-05 show
// `"ipSource":"true-client-ip"` on all 10 recent `demo client ip source` lines, so Render sets
// `True-Client-IP`. The X-Forwarded-For fallback stays for any proxy path that omits it.
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

/**
 * Which header `clientIp` used (M1-07): logged on demo creation (never the IP itself) so the Render
 * deploy shows which header its proxy actually sets.
 */
export function clientIpSource(headers: Headers): "true-client-ip" | "x-forwarded-for" | "none" {
  if (headers.get("true-client-ip")?.trim()) return "true-client-ip";
  return (headers.get("x-forwarded-for") ?? "").trim() !== "" ? "x-forwarded-for" : "none";
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
