// Self-verification of PayPal webhook signatures (ADR 0012). PayPal signs
// `transmissionId|transmissionTime|webhookId|crc32(rawBody)` with SHA256withRSA; the public key is the
// cert at `paypal-cert-url`. That URL comes from the request, so it is an SSRF vector: it must be
// `https:` on exactly `api.paypal.com` or `api.sandbox.paypal.com` (checked before any network call),
// it is fetched through the shared HTTP client with redirects NOT followed, and the cert is cached by
// URL with its validity dates checked on every use.
import { verify as verifySignature, X509Certificate, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
import { crc32 } from "node:zlib";
import type { HttpClient } from "../http/client.ts";
import { HttpStatusError } from "../http/errors.ts";

export const PAYPAL_CERT_HOSTS: readonly string[] = ["api.paypal.com", "api.sandbox.paypal.com"];
/** A delivery whose transmission time is further than this from now is rejected (replay guard). */
export const WEBHOOK_MAX_SKEW_MS = 5 * 60_000;
/** Simulator (mock) events are signed with this literal webhook id (PayPal integrate guide). */
export const SIMULATOR_WEBHOOK_ID = "WEBHOOK_ID";
export const PAYPAL_AUTH_ALGO = "SHA256withRSA";

export const PAYPAL_WEBHOOK_HEADERS = {
  transmissionId: "paypal-transmission-id",
  transmissionTime: "paypal-transmission-time",
  transmissionSig: "paypal-transmission-sig",
  certUrl: "paypal-cert-url",
  authAlgo: "paypal-auth-algo",
} as const;

export type WebhookVerifyFailure =
  | "missing_header"
  | "unsupported_algo"
  | "cert_url_invalid"
  | "cert_url_not_https"
  | "cert_host_ip_literal"
  | "cert_host_not_allowed"
  | "stale_transmission_time"
  | "cert_fetch_failed"
  /** The cert host answered a redirect (never followed). Conclusive: no API fallback (M1-04). */
  | "cert_redirect_refused"
  | "cert_invalid"
  | "cert_not_valid_now"
  | "bad_signature";

export type WebhookVerifyResult =
  | { readonly ok: true; readonly certUrl: string; readonly crc32: number }
  | { readonly ok: false; readonly reason: WebhookVerifyFailure; readonly detail?: string };

/** Node's `IncomingHttpHeaders`, a plain record (any case), or a Fetch `Headers`. */
export type WebhookHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface VerifyWebhookInput {
  /** The body exactly as received: never parsed and re-serialised. */
  readonly rawBody: string | Uint8Array;
  readonly headers: WebhookHeaders;
  /** Our webhook's id (`PAYPAL_WEBHOOK_ID`), or `SIMULATOR_WEBHOOK_ID` for simulator events. */
  readonly webhookId: string;
}

export interface CachedCert {
  readonly publicKey: KeyObject;
  readonly validFrom: Date;
  readonly validTo: Date;
}
export type CertCache = Map<string, CachedCert>;

export interface WebhookVerifierOptions {
  readonly http: HttpClient;
  /** Shared per process; keyed by the exact cert URL. */
  readonly cache?: CertCache;
  readonly now?: () => number;
  readonly maxSkewMs?: number;
  readonly certTimeoutMs?: number;
}

export interface WebhookVerifier {
  verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerifyResult>;
  readonly cache: CertCache;
}

type CertUrlCheck = { readonly ok: true; readonly url: string } | Extract<WebhookVerifyResult, { ok: false }>;

/** The SSRF guard: pure, no network. Exact host match; no port, credentials or IP literal. */
export function checkCertUrl(raw: string): CertUrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "cert_url_invalid" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "cert_url_not_https", detail: u.protocol };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return { ok: false, reason: "cert_host_ip_literal", detail: host };
  if (!PAYPAL_CERT_HOSTS.includes(host) || u.port !== "" || u.username !== "" || u.password !== "") {
    return { ok: false, reason: "cert_host_not_allowed", detail: u.host };
  }
  return { ok: true, url: u.href };
}

/** The string PayPal signs: `transmissionId|transmissionTime|webhookId|crc32` (CRC32 in decimal). */
export function signedString(o: {
  transmissionId: string;
  transmissionTime: string;
  webhookId: string;
  rawBody: string | Uint8Array;
}): string {
  return `${o.transmissionId}|${o.transmissionTime}|${o.webhookId}|${String(crc32(o.rawBody))}`;
}

/** Reads one header case-insensitively from any of the accepted shapes. */
export function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    const value = typeof v === "string" ? v : v?.[0];
    return value === undefined || value.trim() === "" ? undefined : value.trim();
  }
  return undefined;
}

export function createWebhookVerifier(options: WebhookVerifierOptions): WebhookVerifier {
  const cache: CertCache = options.cache ?? new Map<string, CachedCert>();
  const now = options.now ?? Date.now;
  const maxSkewMs = options.maxSkewMs ?? WEBHOOK_MAX_SKEW_MS;

  async function loadCert(url: string): Promise<CachedCert | WebhookVerifyFailure> {
    const hit = cache.get(url);
    if (hit !== undefined) return hit;
    let pem: string;
    try {
      const res = await options.http.request({
        method: "GET",
        url,
        headers: { accept: "*/*" },
        redirect: "manual",
        ...(options.certTimeoutMs === undefined ? {} : { timeoutMs: options.certTimeoutMs }),
      });
      pem = res.bodyText;
    } catch (err) {
      if (err instanceof HttpStatusError && err.status >= 300 && err.status < 400) {
        return "cert_redirect_refused";
      }
      return "cert_fetch_failed";
    }
    try {
      const x = new X509Certificate(pem);
      const cert = { publicKey: x.publicKey, validFrom: new Date(x.validFrom), validTo: new Date(x.validTo) };
      cache.set(url, cert);
      return cert;
    } catch {
      return "cert_invalid";
    }
  }

  async function verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerifyResult> {
    const h = PAYPAL_WEBHOOK_HEADERS;
    const transmissionId = headerValue(input.headers, h.transmissionId);
    const transmissionTime = headerValue(input.headers, h.transmissionTime);
    const sig = headerValue(input.headers, h.transmissionSig);
    const certUrlRaw = headerValue(input.headers, h.certUrl);
    const algo = headerValue(input.headers, h.authAlgo);
    if (!transmissionId || !transmissionTime || !sig || !certUrlRaw || !algo || !input.webhookId) {
      return { ok: false, reason: "missing_header" };
    }
    if (algo !== PAYPAL_AUTH_ALGO) return { ok: false, reason: "unsupported_algo", detail: algo };
    const certUrl = checkCertUrl(certUrlRaw);
    if (!certUrl.ok) return certUrl;
    const sentAt = Date.parse(transmissionTime);
    if (Number.isNaN(sentAt) || Math.abs(now() - sentAt) > maxSkewMs) {
      return { ok: false, reason: "stale_transmission_time", detail: transmissionTime };
    }
    const cert = await loadCert(certUrl.url);
    if (typeof cert === "string") return { ok: false, reason: cert };
    if (now() < cert.validFrom.getTime() || now() > cert.validTo.getTime()) {
      return { ok: false, reason: "cert_not_valid_now" };
    }
    const message = signedString({
      transmissionId,
      transmissionTime,
      webhookId: input.webhookId,
      rawBody: input.rawBody,
    });
    const valid = verifySignature(
      "sha256",
      Buffer.from(message, "utf8"),
      cert.publicKey,
      Buffer.from(sig, "base64"),
    );
    if (!valid) return { ok: false, reason: "bad_signature" };
    return { ok: true, certUrl: certUrl.url, crc32: crc32(input.rawBody) };
  }

  return { verifyWebhook, cache };
}
