// Payments v2 capture read for the sync job (M1-04): `GET /v2/payments/captures/{id}` through the shared
// HTTP client and the token provider, parsed by core's `mapCapture` (lenient on status: an unknown PayPal
// value is mirrored verbatim, unlike the orders client's strict enum).
import { mapCapture, type CaptureMirror } from "@cleared/core";
import type { HttpClient } from "../http/client.ts";
import { HttpStatusError } from "../http/errors.ts";
import { PAYPAL_SANDBOX_BASE_URL, PayPalApiError } from "./orders.ts";
import type { TokenProvider } from "./token.ts";

export interface FetchedCapture {
  readonly mirror: CaptureMirror;
  /** The body as PayPal sent it (for audit and fixtures). */
  readonly raw: unknown;
  readonly debugId: string | undefined;
}

export interface PayPalCapturesClient {
  getCapture(captureId: string): Promise<FetchedCapture>;
}

export interface PayPalCapturesClientOptions {
  readonly http: HttpClient;
  readonly tokens: TokenProvider;
  readonly baseUrl?: string;
}

export class InvalidCaptureError extends Error {
  readonly captureId: string;
  readonly code: string;

  constructor(captureId: string, code: string) {
    super(`PayPal capture ${captureId} could not be mapped: ${code}`);
    this.name = "InvalidCaptureError";
    this.captureId = captureId;
    this.code = code;
  }
}

export function createPayPalCapturesClient(o: PayPalCapturesClientOptions): PayPalCapturesClient {
  const base = o.baseUrl ?? PAYPAL_SANDBOX_BASE_URL;
  return {
    async getCapture(captureId) {
      if (!/^[A-Z0-9]{6,32}$/.test(captureId)) throw new Error(`invalid capture id: ${captureId}`);
      try {
        const res = await o.tokens.withToken((bearer) =>
          o.http.request({
            method: "GET",
            url: `${base}/v2/payments/captures/${captureId}`,
            headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
          }),
        );
        const raw: unknown = JSON.parse(res.bodyText);
        const mapped = mapCapture(raw);
        if (!mapped.ok) throw new InvalidCaptureError(captureId, mapped.error.code);
        return { mirror: mapped.value, raw, debugId: res.debugId };
      } catch (err) {
        if (err instanceof HttpStatusError) throw new PayPalApiError(err);
        throw err;
      }
    },
  };
}
