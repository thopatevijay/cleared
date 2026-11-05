// Per-run limits and spend budgets (ADR 0010). Every AI run has step, token, time and
// spend limits: ≤ 6 model calls, a per-step output-token cap, a 120 s wall clock, a per-workspace cap
// (demo: LLM_WORKSPACE_CAP_USD, or the workspace's own llm_budget_usd) and a global UTC-day cap
// (LLM_DAILY_CAP_USD). Budgets are checked before every call from recorded spend.
import { z } from "zod";
import type { WorkspaceKind } from "../accounts/workspace.ts";

export interface RunLimits {
  readonly maxCalls: number;
  /** a step asking for more output tokens is clamped to this */
  readonly maxOutputTokensPerStep: number;
  readonly wallClockMs: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxCalls: 6,
  // M0-07: pass 2 measured max 877 output tokens; 4,000 is its suggested cap and the largest any step needs
  maxOutputTokensPerStep: 4_000,
  wallClockMs: 120_000,
};

const flag = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");
/**
 * A key that is present but blank (`OPENAI_MODEL_SMALL=` in a `.env`) means unset, so the pinned default
 * applies; zod's `.default()` alone only covers an absent key (BL-01 6537625497).
 */
const blankAsUnset = (v: unknown): unknown => (typeof v === "string" && v.trim() === "" ? undefined : v);
const usd = (fallback: number) =>
  z.preprocess(blankAsUnset, z.coerce.number().nonnegative().optional().default(fallback));
const modelId = (pinned: string) => z.preprocess(blankAsUnset, z.string().min(1).optional().default(pinned));

/** The environment the harness reads. Callers pass `process.env`; the core never reads it itself. */
export const AgentEnvSchema = z.object({
  AGENT_KILL_SWITCH: flag,
  OPENAI_MODEL_SMALL: modelId("gpt-6-luna"),
  OPENAI_MODEL_LARGE: modelId("gpt-6.1-terra"),
  LLM_WORKSPACE_CAP_USD: usd(0.1),
  LLM_DAILY_CAP_USD: usd(1),
});

export interface AgentConfig {
  readonly killSwitchEnv: boolean;
  readonly models: { readonly small: string; readonly large: string };
  readonly workspaceCapUsd: number;
  readonly dailyCapUsd: number;
  readonly limits: RunLimits;
}

export function parseAgentConfig(
  env: Readonly<Record<string, string | undefined>>,
  limits: Partial<RunLimits> = {},
): AgentConfig {
  const e = AgentEnvSchema.parse(env);
  return {
    killSwitchEnv: e.AGENT_KILL_SWITCH,
    models: { small: e.OPENAI_MODEL_SMALL, large: e.OPENAI_MODEL_LARGE },
    workspaceCapUsd: e.LLM_WORKSPACE_CAP_USD,
    dailyCapUsd: e.LLM_DAILY_CAP_USD,
    limits: { ...DEFAULT_RUN_LIMITS, ...limits },
  };
}

/** Start of the UTC day containing `nowMs` (the global cap's window). */
export function utcDayStart(nowMs: number): Date {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export interface SpendSnapshot {
  readonly workspaceKind: WorkspaceKind;
  /** the workspace's own `llm_budget_usd`; null = use the config default for demo workspaces */
  readonly workspaceCapUsd: number | null;
  /** all-time spend of this workspace */
  readonly workspaceUsd: number;
  /** spend of every workspace since the UTC day start */
  readonly globalTodayUsd: number;
}

export type BudgetDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly cap: "workspace" | "daily";
      readonly spentUsd: number;
      readonly capUsd: number;
    };

/** Applies to demo workspaces (ADR 0007) unless the workspace row carries its own cap. */
export function workspaceCap(s: SpendSnapshot, config: AgentConfig): number | null {
  if (s.workspaceCapUsd !== null) return s.workspaceCapUsd;
  return s.workspaceKind === "demo" ? config.workspaceCapUsd : null;
}

/**
 * USD as integer micro-dollars, so float summation order cannot move a sum across a cap. A difference under
 * half a micro-dollar is float noise, not spend (a whole call costs far more).
 */
export function toMicroUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/** Spend at or over the cap, compared exactly in micro-dollars (BL-01, found by M2-04's replays in CI). */
export function atOrOverCap(spentUsd: number, capUsd: number): boolean {
  return toMicroUsd(spentUsd) >= toMicroUsd(capUsd);
}

/** `spent + reserve` would end above the cap (micro-dollars, like `atOrOverCap`). */
function wouldCross(spentUsd: number, reserveUsd: number, capUsd: number): boolean {
  return toMicroUsd(spentUsd) + toMicroUsd(reserveUsd) > toMicroUsd(capUsd);
}

/**
 * At or over a cap → no call. With `reserveUsd` (the next call's worst-case cost, M4-05, owner decision on
 * #49) also no call when spent + reserved would end above a cap, so no single call can cross one.
 */
export function checkBudget(s: SpendSnapshot, config: AgentConfig, reserveUsd = 0): BudgetDecision {
  const wsCap = workspaceCap(s, config);
  if (wsCap !== null && (atOrOverCap(s.workspaceUsd, wsCap) || wouldCross(s.workspaceUsd, reserveUsd, wsCap)))
    return { ok: false, cap: "workspace", spentUsd: s.workspaceUsd, capUsd: wsCap };
  const daily = config.dailyCapUsd;
  if (atOrOverCap(s.globalTodayUsd, daily) || wouldCross(s.globalTodayUsd, reserveUsd, daily))
    return { ok: false, cap: "daily", spentUsd: s.globalTodayUsd, capUsd: daily };
  return { ok: true };
}
