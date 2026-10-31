// canonicalHash, prompts, limits and the action/output guardrails as pure functions.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalHash, sha256Hex } from "../../src/agent/canonical-hash.ts";
import { checkOutput, checkProposal, PROPOSAL_PAYLOAD_SCHEMAS } from "../../src/agent/guardrails.ts";
import { checkBudget, DEFAULT_RUN_LIMITS, parseAgentConfig, utcDayStart } from "../../src/agent/limits.ts";
import { createPromptRegistry, definePrompt, PROMPTS } from "../../src/agent/prompts.ts";

describe("canonicalHash", () => {
  it("is sha256 over sorted-key JSON in UTF-8, independent of key order", () => {
    const a = canonicalHash({ b: 1, a: ["é", null, { d: true, c: "x" }] });
    const b = canonicalHash({ a: ["é", null, { c: "x", d: true }], b: 1 });
    const expected = createHash("sha256")
      .update('{"a":["é",null,{"c":"x","d":true}],"b":1}', "utf8")
      .digest("hex");
    expect(a).toBe(expected);
    expect(b).toBe(expected);
  });

  it("hashes bytes and strings", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new Uint8Array([97, 98, 99]))).toBe(sha256Hex("abc"));
  });
});

describe("prompts", () => {
  it("parses <task>@v<n> and refuses anything else", () => {
    expect(definePrompt("check_scope@v2", "x")).toMatchObject({ task: "check_scope", version: 2 });
    expect(() => definePrompt("check_scope", "x")).toThrow(/not <task>@v<n>/);
    expect(() => definePrompt("Check@v1", "x")).toThrow();
    expect(() => definePrompt("a@v1", "  ")).toThrow(/empty/);
  });

  it("refuses the same id with different text (a change needs a new version)", () => {
    const reg = createPromptRegistry();
    reg.register(definePrompt("t@v1", "one"));
    reg.register(definePrompt("t@v1", "one"));
    expect(() => reg.register(definePrompt("t@v1", "two"))).toThrow(/bump the version/);
    expect(reg.get("t@v1").system).toBe("one");
    expect(reg.ids()).toEqual(["t@v1"]);
    expect(() => reg.get("t@v9")).toThrow(/unknown prompt/);
    expect(PROMPTS.ids()).toEqual([]);
  });
});

describe("limits", () => {
  it("defaults: 6 calls, 4,000 output tokens per step, 120 s; caps from the env", () => {
    const c = parseAgentConfig({
      LLM_WORKSPACE_CAP_USD: "0.10",
      LLM_DAILY_CAP_USD: "1",
      AGENT_KILL_SWITCH: "false",
    });
    expect(c.limits).toEqual(DEFAULT_RUN_LIMITS);
    expect(DEFAULT_RUN_LIMITS).toEqual({ maxCalls: 6, maxOutputTokensPerStep: 4000, wallClockMs: 120_000 });
    expect(c).toMatchObject({
      workspaceCapUsd: 0.1,
      dailyCapUsd: 1,
      killSwitchEnv: false,
      models: { small: "gpt-6-luna", large: "gpt-6.1-terra" },
    });
    expect(parseAgentConfig({ AGENT_KILL_SWITCH: "1" }).killSwitchEnv).toBe(true);
    expect(() => parseAgentConfig({ AGENT_KILL_SWITCH: "yes" })).toThrow();
    expect(() => parseAgentConfig({ LLM_DAILY_CAP_USD: "-1" })).toThrow();
  });

  it("the global window is the UTC day", () => {
    expect(utcDayStart(Date.parse("2026-10-31T23:59:59.999+05:30")).toISOString()).toBe(
      "2026-10-31T00:00:00.000Z",
    );
    expect(utcDayStart(Date.parse("2026-11-01T00:00:00.000Z")).toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });

  it("budget: demo workspaces use the config cap unless the row has its own; sellers only the daily cap", () => {
    const c = parseAgentConfig({});
    const snap = {
      workspaceKind: "demo" as const,
      workspaceCapUsd: null,
      workspaceUsd: 0.0999,
      globalTodayUsd: 0,
    };
    expect(checkBudget(snap, c)).toEqual({ ok: true });
    expect(checkBudget({ ...snap, workspaceUsd: 0.1 }, c)).toMatchObject({ ok: false, cap: "workspace" });
    expect(checkBudget({ ...snap, workspaceCapUsd: 0.5, workspaceUsd: 0.2 }, c)).toEqual({ ok: true });
    expect(checkBudget({ ...snap, workspaceKind: "seller", workspaceUsd: 50 }, c)).toEqual({ ok: true });
    expect(checkBudget({ ...snap, workspaceKind: "seller", globalTodayUsd: 1 }, c)).toMatchObject({
      ok: false,
      cap: "daily",
    });
  });
});

describe("action guardrail", () => {
  it("refuses accept_claim and unknown kinds in code", () => {
    expect(checkProposal("accept_claim", {})).toMatchObject({ ok: false, reason: "kind_not_allowed" });
    expect(checkProposal("refund", {})).toMatchObject({ ok: false, reason: "kind_not_allowed" });
  });

  it("validates the payload per kind (strict: no extra keys; notes ≤ 2000)", () => {
    const base = { dispute_id: "PP-R-UVC-10195076", notes: "n", evidence_item_ids: [] };
    expect(checkProposal("provide_evidence", base).ok).toBe(true);
    expect(checkProposal("provide_evidence", { ...base, extra: 1 })).toMatchObject({
      ok: false,
      reason: "invalid_payload",
    });
    expect(checkProposal("provide_supporting_info", { ...base, notes: "x".repeat(2001) })).toMatchObject({
      ok: false,
    });
    const tracking = {
      capture_id: "2KC08730ML031160C",
      carrier: "USPS",
      tracking_number: "9400111899223817460931",
      notify_payer: false,
    };
    expect(checkProposal("add_tracking", tracking)).toMatchObject({
      ok: true,
      proposal: { risk: "low", payloadSha256: canonicalHash(tracking) },
    });
    expect(checkProposal("add_tracking", { ...tracking, notify_payer: true }).ok).toBe(false);
    expect(Object.keys(PROPOSAL_PAYLOAD_SCHEMAS).sort()).toEqual([
      "add_tracking",
      "provide_evidence",
      "provide_supporting_info",
    ]);
  });
});

describe("output guardrail", () => {
  const S = z.object({ n: z.number() });
  it("parses, runs validators, and reports every problem", () => {
    expect(checkOutput(S, { n: 1 }, [])).toEqual({ ok: true, value: { n: 1 } });
    expect(checkOutput(S, { n: "1" }, [])).toMatchObject({ ok: false });
    expect(checkOutput(S, { n: 1 }, [() => ["a"], () => ["b"]])).toEqual({ ok: false, problems: ["a", "b"] });
  });
});
