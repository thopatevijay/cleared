import { describe, expect, it } from "vitest";
import {
  DEMO_WORKSPACE_EXPIRES_AT,
  isWorkspaceExpired,
  newWorkspace,
  parseInstant,
  resolveOwner,
  type Instant,
  type NewWorkspace,
  type WorkspaceId,
} from "../src/index.ts";

const WS = "0b8f3c1e-5d2a-4e6f-8a9b-0c1d2e3f4a5b" as WorkspaceId;
const OTHER = "1c9a4d2f-6e3b-4f70-9b8c-1d2e3f4a5b6c" as WorkspaceId;

function instant(raw: string): Instant {
  const r = parseInstant(raw);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const input: NewWorkspace = {
  id: WS,
  kind: "demo",
  locale: "en",
  timezone: "Asia/Kolkata",
  baseCurrency: "INR",
  createdAt: instant("2026-11-12T10:00:00Z"),
};

describe("Workspace", () => {
  it("a demo workspace expires at 2026-12-16T00:00Z", () => {
    const r = newWorkspace(input);
    expect(r.ok && r.value.expiresAt).toBe("2026-12-16T00:00:00.000Z");
    expect(DEMO_WORKSPACE_EXPIRES_AT).toBe("2026-12-16T00:00:00.000Z");
  });

  it("a seller workspace never expires", () => {
    const r = newWorkspace({ ...input, kind: "seller" });
    expect(r.ok && r.value.expiresAt).toBeNull();
    if (r.ok) expect(isWorkspaceExpired(r.value, instant("2030-01-01T00:00:00Z"))).toBe(false);
  });

  it("is expired at and after the expiry instant, not before", () => {
    const r = newWorkspace(input);
    if (!r.ok) throw new Error("expected ok");
    expect(isWorkspaceExpired(r.value, instant("2026-12-15T23:59:59.999Z"))).toBe(false);
    expect(isWorkspaceExpired(r.value, instant("2026-12-16T00:00:00Z"))).toBe(true);
  });

  it("refuses to create a demo workspace at or after the expiry", () => {
    const r = newWorkspace({ ...input, createdAt: DEMO_WORKSPACE_EXPIRES_AT });
    expect(r.ok ? null : r.error.code).toBe("invariant_violated");
  });
});

describe("resolveOwner (ADR 0008)", () => {
  it("owned: owner row and matching custom_id", () => {
    expect(resolveOwner({ customId: WS, ownerRow: { workspaceId: WS } })).toEqual({
      kind: "owned",
      workspaceId: WS,
    });
  });
  it("owned: child resource (dispute) with no custom_id inherits the owner row", () => {
    expect(resolveOwner({ customId: null, ownerRow: { workspaceId: WS } })).toEqual({
      kind: "owned",
      workspaceId: WS,
    });
  });
  it("mismatch: custom_id names another workspace", () => {
    expect(resolveOwner({ customId: OTHER, ownerRow: { workspaceId: WS } })).toEqual({
      kind: "mismatch",
      workspaceId: WS,
      customId: OTHER,
    });
  });
  it("unowned: no owner row, even when custom_id looks like a workspace (never trusted alone)", () => {
    expect(resolveOwner({ customId: WS, ownerRow: null })).toEqual({ kind: "unowned", customId: WS });
    expect(resolveOwner({ customId: null, ownerRow: null })).toEqual({ kind: "unowned", customId: null });
  });
});
