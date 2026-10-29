// Scrubber for recorded vendor exchanges (fixtures/README.md). Removes credentials outright and
// replaces personal data with STABLE placeholders (same input → same placeholder across one run),
// while keeping the ids a flow needs (order, capture, tracker, dispute, debug ids).

export const REDACTED = "[REDACTED]";

/** Headers kept in fixtures; everything else (Authorization, cookies, OpenAI org/project…) is dropped. */
export const REQUEST_HEADER_ALLOW = ["content-type", "accept", "prefer", "paypal-request-id"] as const;
export const RESPONSE_HEADER_ALLOW = ["content-type", "paypal-debug-id", "retry-after"] as const;

// Keys whose value is a credential: replaced by [REDACTED] (kept so the shape still parses on replay).
const SECRET_KEYS = new Set([
  "authorization",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "nonce",
  "cookie",
  "set-cookie",
  "openai-organization",
  "openai-project",
  "security_code",
  "password",
  "token",
]);

type Kind = "payer-email" | "merchant-email" | "person" | "merchant" | "payer" | "account" | "app" | "address" | "phone" | "ip" | "card";

const ID_KEYS: Readonly<Record<string, Kind>> = {
  merchant_id: "merchant",
  payer_id: "payer",
  account_id: "account",
  app_id: "app",
  given_name: "person",
  surname: "person",
  middle_name: "person",
  full_name: "person",
  alternate_full_name: "person",
  address_line_1: "address",
  address_line_2: "address",
  address_line_3: "address",
  admin_area_1: "address",
  admin_area_2: "address",
  postal_code: "address",
  national_number: "phone",
  phone_number: "phone",
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CARD_RE = /\b\d{13,19}\b/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const PAYPAL_TOKEN_RE = /\bA21[A-Za-z0-9_-]{20,}/g;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{20,}/g;

export interface Scrubber {
  /** Scrubs any JSON-like value; `path` is the key trail used for context-dependent rules. */
  value(input: unknown, path?: readonly string[]): unknown;
  /** Scrubs free text (URLs, form bodies, error messages). */
  text(input: string): string;
  headers(input: Readonly<Record<string, string>>, allow: readonly string[]): Record<string, string>;
}

export interface ScrubberOptions {
  /** Exact strings to remove wherever they appear (client id, secret, live token). */
  readonly secrets?: () => readonly string[];
}

export function createScrubber(options: ScrubberOptions = {}): Scrubber {
  const seen = new Map<string, string>();
  const counters = new Map<Kind, number>();

  function placeholder(kind: Kind, original: string): string {
    const key = `${kind}:${original}`;
    const hit = seen.get(key);
    if (hit !== undefined) return hit;
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    const made = render(kind, n);
    seen.set(key, made);
    return made;
  }

  function text(input: string): string {
    let out = input;
    for (const secret of options.secrets?.() ?? []) {
      if (secret.length >= 8) out = out.split(secret).join(REDACTED);
    }
    return out
      .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
      .replace(PAYPAL_TOKEN_RE, REDACTED)
      .replace(OPENAI_KEY_RE, REDACTED)
      .replace(EMAIL_RE, (m) => (m.endsWith("@example.test") ? m : placeholder("payer-email", m)))
      .replace(CARD_RE, (m) => placeholder("card", m))
      .replace(IPV4_RE, (m) => placeholder("ip", m));
  }

  function value(input: unknown, path: readonly string[] = []): unknown {
    const key = (path.at(-1) ?? "").toLowerCase();
    if (Array.isArray(input)) return input.map((v) => value(v, path));
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, value(v, [...path, k])]));
    }
    if (typeof input !== "string") return input;
    if (SECRET_KEYS.has(key)) return REDACTED;
    const parent = (path.at(-2) ?? "").toLowerCase();
    if (key === "number" && parent === "card") return placeholder("card", input);
    if (key === "name" && (parent === "card" || parent === "shipping")) return placeholder("person", input);
    if (key === "email_address" || key === "email") {
      return placeholder(path.some((p) => p.toLowerCase() === "payee") ? "merchant-email" : "payer-email", input);
    }
    if (key === "ip_address" || key === "ip") return placeholder("ip", input);
    const kind = ID_KEYS[key];
    if (kind !== undefined) return placeholder(kind, input);
    return text(input);
  }

  function headers(input: Readonly<Record<string, string>>, allow: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) {
      const lower = k.toLowerCase();
      if (allow.includes(lower)) out[lower] = text(v);
    }
    return out;
  }

  return { value, text, headers };
}

function render(kind: Kind, n: number): string {
  switch (kind) {
    case "payer-email":
      return `payer-${String(n)}@example.test`;
    case "merchant-email":
      return `merchant-${String(n)}@example.test`;
    case "person":
      return `Person ${String(n)}`;
    case "merchant":
      return `MERCHANT-${String(n)}`;
    case "payer":
      return `PAYER-${String(n)}`;
    case "account":
      return `ACCOUNT-${String(n)}`;
    case "app":
      return `APP-${String(n)}`;
    case "address":
      return `Address ${String(n)}`;
    case "phone":
      return `PHONE-${String(n)}`;
    case "ip":
      return `IP-${String(n)}`;
    case "card":
      return `CARD-${String(n)}`;
  }
}
