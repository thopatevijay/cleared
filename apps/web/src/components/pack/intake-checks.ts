// Evidence intake, client side (M2-05): the same type and size caps as the server (M2-01), checked before
// an upload so an 11 MB file never leaves the browser. The server stays authoritative: its typed codes
// (snake_case on the wire, BL-01 6536606275) map to the same localised messages.
// The dispute module's caps (EVIDENCE_MAX_BYTES / EVIDENCE_MIMES are aliases of these): proof/evidence.ts
// holds zod schemas, which would put zod in the pack page's first load (M4-08).
import {
  EVIDENCE_FILE_MAX_BYTES as EVIDENCE_MAX_BYTES,
  EVIDENCE_FILE_MIMES as EVIDENCE_MIMES,
} from "@cleared/core";

/** Codes the intake shows as messages (`pack.errors.<code>`). */
export const INTAKE_ERROR_CODES = [
  "evidence_type",
  "evidence_too_large",
  "evidence_too_many_pages",
  "evidence_encrypted",
  "evidence_too_many_pixels",
  "evidence_unreadable",
  "evidence_text_empty",
  "evidence_text_too_long",
  "evidence_pack_full",
  "evidence_workspace_full",
  "network",
  "generic",
] as const;
export type IntakeErrorCode = (typeof INTAKE_ERROR_CODES)[number];

const EXTENSION_MIME: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  pdf: "application/pdf",
};

/** What the server would say about this file's type and size, or null when it may go up. */
export function preCheck(file: { readonly name: string; readonly type: string; readonly size: number }) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = file.type !== "" ? file.type : (EXTENSION_MIME[ext] ?? "");
  if (!(EVIDENCE_MIMES as readonly string[]).includes(mime)) return "evidence_type" as const;
  if (file.size >= EVIDENCE_MAX_BYTES) return "evidence_too_large" as const;
  return null;
}

/** A server or network refusal as one of the intake's message codes. */
export function intakeError(status: number, code: string | null): IntakeErrorCode {
  if (status === 0) return "network";
  return (INTAKE_ERROR_CODES as readonly string[]).includes(code ?? "")
    ? (code as IntakeErrorCode)
    : "generic";
}

/** "11 MB", "240 KB": decimal units, as the 10 MB cap is stated. */
export function formatBytes(locale: string, bytes: number): string {
  const mb = bytes >= 1_000_000;
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    mb ? bytes / 1_000_000 : Math.max(1, Math.round(bytes / 1_000)),
  );
  return `${n} ${mb ? "MB" : "KB"}`;
}
