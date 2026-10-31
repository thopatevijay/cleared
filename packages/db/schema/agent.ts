// AI runs (ADR 0009/0010): every run and step records tokens, time and spend; the content-hash cache
// keys on (workspace_id, task, input_hash). M2-02 adds the prompt version, correlation id, the run's
// output (served on a cache hit) and error, and per step its kind and guardrail detail.
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { scoped } from "./accounts.ts";
import { money, sha256 } from "./columns.ts";

export const agentRuns = pgTable(
  "agent_runs",
  {
    ...scoped(),
    task: text("task").notNull(),
    inputHash: sha256("input_hash").notNull(),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: money("cost_usd").notNull().default("0"),
    latencyMs: integer("latency_ms"),
    status: text("status").notNull(),
    /** M2-02: `<task>@v<n>`, part of input_hash */
    promptVersion: text("prompt_version"),
    correlationId: text("correlation_id"),
    /** M2-02: the validated output of a `succeeded` run (the cache serves it); null otherwise */
    output: jsonb("output"),
    error: text("error"),
  },
  (t) => [
    index("agent_runs_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("agent_runs_cache_idx").on(t.workspaceId, t.task, t.inputHash),
  ],
);

export const agentSteps = pgTable(
  "agent_steps",
  {
    ...scoped(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id),
    stepIndex: integer("step_index").notNull(),
    task: text("task").notNull(),
    inputHash: sha256("input_hash"),
    model: text("model"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: money("cost_usd").notNull().default("0"),
    latencyMs: integer("latency_ms"),
    status: text("status").notNull(),
    /** M2-02: `call` (a model call) or `guardrail` (a limit, budget, proposal or kill-switch decision) */
    kind: text("kind").notNull().default("call"),
    /** M2-02: injection flags, block hashes, refusal detail; never evidence text */
    detail: jsonb("detail").notNull().default({}),
    correlationId: text("correlation_id"),
  },
  (t) => [
    uniqueIndex("agent_steps_run_step_key").on(t.runId, t.stepIndex),
    index("agent_steps_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);
