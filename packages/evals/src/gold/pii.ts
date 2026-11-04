// PII scan (AC 5): no real-looking email, phone number or PayPal id outside the reserved synthetic
// patterns. Reserved: emails at example.com/.test/.org/.net (and the scrubber's `payer-N@example.test`),
// phones with a `00000` block (`+91-00000-12345`), ids starting `SYNTH`, and UPU postal tracking
// numbers (`EE123456789IN`), which share the 13-character shape of a PayPal payer id.

export interface PiiFinding {
  readonly kind: "email" | "phone" | "paypal_id";
  readonly match: string;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const RESERVED_DOMAIN = /(^|\.)example\.(com|test|org|net)$/i;

// international (+cc …) numbers, and bare local mobile shapes (IN 10 digits from 6-9; KE/NG/PH/ID 0-prefixed)
const PHONE_RES = [/\+\d{1,3}[\s-]?\(?\d[\d\s().-]{6,}\d/g, /\b[6-9]\d{9}\b/g, /\b0[789]\d{8,10}\b/g];
const RESERVED_PHONE = /00000/;

// PayPal transaction/capture/order ids (17) and payer/merchant ids (13): uppercase alphanumerics with
// at least one digit and one letter
const PAYPAL_ID_RE = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])(?:[A-Z0-9]{17}|[A-Z0-9]{13})\b/g;
const UPU_TRACKING = /^[A-Z]{2}\d{9}[A-Z]{2}$/;

export function scanText(text: string): PiiFinding[] {
  const out: PiiFinding[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    if (!RESERVED_DOMAIN.test(m[1] ?? "")) out.push({ kind: "email", match: m[0] });
  }
  for (const re of PHONE_RES) {
    for (const m of text.matchAll(re)) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= 9 && !RESERVED_PHONE.test(digits)) out.push({ kind: "phone", match: m[0] });
    }
  }
  for (const m of text.matchAll(PAYPAL_ID_RE)) {
    if (!m[0].startsWith("SYNTH") && !UPU_TRACKING.test(m[0])) out.push({ kind: "paypal_id", match: m[0] });
  }
  return out;
}

/** Every string inside a JSON value. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}
