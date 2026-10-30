// Reads the recorded PayPal sandbox responses (M0-04 / M0-05). Tests only: src/ never touches the filesystem.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const FIXTURES_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "paypal");

interface Recording {
  readonly request?: { readonly method?: string; readonly url?: string };
  readonly response?: { readonly status?: number; readonly body?: unknown };
}

export interface FoundBody {
  readonly file: string;
  readonly where: string;
  readonly body: Record<string, unknown>;
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return jsonFiles(path);
    return e.name.endsWith(".json") ? [path] : [];
  });
}

export function recordings(subdir: string): { file: string; rec: Recording }[] {
  return jsonFiles(join(FIXTURES_ROOT, subdir)).map((path) => ({
    file: relative(FIXTURES_ROOT, path),
    rec: JSON.parse(readFileSync(path, "utf8")) as Recording,
  }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Captures nested in an order body: purchase_units[].payments.captures[]. */
function nestedCaptures(body: Record<string, unknown>): Record<string, unknown>[] {
  const units = Array.isArray(body.purchase_units) ? (body.purchase_units as unknown[]) : [];
  return units.flatMap((u) => {
    const payments = isRecord(u) ? u.payments : undefined;
    const captures =
      isRecord(payments) && Array.isArray(payments.captures) ? (payments.captures as unknown[]) : [];
    return captures.filter(isRecord);
  });
}

/** Every capture body in the given fixture dirs: direct GET/POST capture responses and captures inside orders. */
export function captureBodies(...subdirs: string[]): FoundBody[] {
  return subdirs.flatMap((dir) =>
    recordings(dir).flatMap(({ file, rec }) => {
      const body = rec.response?.body;
      if (!isRecord(body)) return [];
      const url = rec.request?.url ?? "";
      const direct = /\/v2\/payments\/captures\/[^/]+$/.test(url) && "status" in body && "amount" in body;
      const found: FoundBody[] = direct ? [{ file, where: "capture", body }] : [];
      return found.concat(
        nestedCaptures(body).map((c, i) => ({
          file,
          where: `purchase_units captures[${String(i)}]`,
          body: c,
        })),
      );
    }),
  );
}

/** Every dispute body (a response body carrying `dispute_id` and `status`). */
export function disputeBodies(...subdirs: string[]): FoundBody[] {
  return subdirs.flatMap((dir) =>
    recordings(dir).flatMap(({ file, rec }) => {
      const body = rec.response?.body;
      return isRecord(body) && "dispute_id" in body && "status" in body
        ? [{ file, where: "dispute", body }]
        : [];
    }),
  );
}
