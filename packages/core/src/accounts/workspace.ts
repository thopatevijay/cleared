// Accounts: a workspace is a seller's, or an anonymous demo workspace for judges (ADR 0007).
import { domainError, type DomainError } from "../errors.ts";
import type { WorkspaceId } from "../ids.ts";
import type { CurrencyCode } from "../money.ts";
import { err, ok, type Result } from "../result.ts";
import { compareInstants, type Instant } from "../time.ts";

export const WORKSPACE_KINDS = ["seller", "demo"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const LOCALES = ["en", "hi"] as const;
export type Locale = (typeof LOCALES)[number];

/** Every demo workspace expires at this instant (ADR 0007; purged 2026-12-22). */
export const DEMO_WORKSPACE_EXPIRES_AT = "2026-12-16T00:00:00.000Z" as Instant;

export interface Workspace {
  readonly id: WorkspaceId;
  readonly kind: WorkspaceKind;
  readonly locale: Locale;
  /** IANA zone, e.g. `Asia/Kolkata` */
  readonly timezone: string;
  readonly baseCurrency: CurrencyCode;
  readonly createdAt: Instant;
  /** demo: DEMO_WORKSPACE_EXPIRES_AT; seller: null (never expires) */
  readonly expiresAt: Instant | null;
}

export type NewWorkspace = Omit<Workspace, "expiresAt">;

export function newWorkspace(input: NewWorkspace): Result<Workspace, DomainError> {
  const expiresAt = input.kind === "demo" ? DEMO_WORKSPACE_EXPIRES_AT : null;
  if (expiresAt !== null && compareInstants(input.createdAt, expiresAt) >= 0) {
    return err(
      domainError("invariant_violated", "demo workspaces can no longer be created", {
        createdAt: input.createdAt,
      }),
    );
  }
  return ok({ ...input, expiresAt });
}

export function isWorkspaceExpired(workspace: Workspace, now: Instant): boolean {
  return workspace.expiresAt !== null && compareInstants(now, workspace.expiresAt) >= 0;
}
