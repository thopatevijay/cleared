// runWorkflow: the one control plane every AI workflow runs through (ADR 0009/0010, architecture §10).
// I/O is injected (AiProvider, RunStore). Order of checks per run: kill switch → content-hash cache →
// run row → per call: call limit, wall clock, budget, input guardrail, provider, output guardrail
// (one repair) → kill switch again → proposals + run result written together (RunStore.finishRun).
// A run that does not succeed writes no proposal and no output: never a partial write.
import type { z } from "zod";
import type { JsonValue } from "../actions/canonical-json.ts";
import type { Sha256, WorkspaceId } from "../ids.ts";
import {
  DEGRADING_FAILURES,
  type AiFailureKind,
  type AiProvider,
  type CompletionResult,
  type ReasoningEffort,
} from "../ports/ai-provider.ts";
import { canonicalHash } from "./canonical-hash.ts";
import {
  assertNoEvidenceIn,
  checkOutput,
  checkProposal,
  guardInput,
  type CheckedProposal,
  type EvidenceInput,
  type OutputValidator,
  type ProposalCheck,
} from "./guardrails.ts";
import { checkBudget, utcDayStart, type AgentConfig, type SpendSnapshot } from "./limits.ts";
import { DATA_CHANNEL_RULES, type PromptDef } from "./prompts.ts";

export const RUN_STATUSES = [
  "running",
  "succeeded",
  "cache_hit",
  "failed_output",
  "limit_calls",
  "limit_time",
  "budget_exceeded",
  "kill_switch",
  "degraded",
  "failed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type HaltStatus = Exclude<RunStatus, "running" | "succeeded" | "cache_hit">;

export type StepKind = "call" | "guardrail";

export interface RunStart {
  readonly workspaceId: WorkspaceId;
  readonly task: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly inputHash: Sha256;
  readonly correlationId: string;
  readonly status: "running" | "cache_hit";
}

export interface StepRecord {
  readonly workspaceId: WorkspaceId;
  readonly runId: string;
  readonly stepIndex: number;
  readonly kind: StepKind;
  /** the workflow's step name (`extract`, `pass1`) or the guardrail (`limit_calls`, `proposal`) */
  readonly name: string;
  readonly model: string | null;
  readonly inputHash: Sha256 | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly latencyMs: number | null;
  readonly status: string;
  readonly detail: JsonValue;
  readonly correlationId: string;
}

export interface RunFinish {
  readonly workspaceId: WorkspaceId;
  readonly runId: string;
  readonly task: string;
  readonly status: Exclude<RunStatus, "running">;
  readonly output: JsonValue | null;
  readonly error: string | null;
  readonly latencyMs: number;
  readonly correlationId: string;
  /** written in the same transaction as the run result, each with its outbox row */
  readonly proposals: readonly CheckedProposal[];
}

/** Persistence port; `packages/db` implements it over agent_runs / agent_steps / proposed_actions. */
export interface RunStore {
  /** the DB flag `platform_flags.agent_kill_switch` */
  killSwitch(): Promise<boolean>;
  spend(workspaceId: WorkspaceId, dayStart: Date): Promise<SpendSnapshot>;
  /** the newest `succeeded` run with this hash, in this workspace */
  findCachedOutput(
    workspaceId: WorkspaceId,
    task: string,
    inputHash: Sha256,
  ): Promise<{ runId: string; output: JsonValue } | null>;
  startRun(run: RunStart): Promise<string>;
  /** also adds the step's tokens and cost to its run, so mid-run spend is visible to the budget check */
  recordStep(step: StepRecord): Promise<void>;
  /** one transaction: run result, proposals + outbox rows, audit entry (actor `agent`) */
  finishRun(finish: RunFinish): Promise<{ proposedActionIds: string[] }>;
}

export interface CallSpec<S extends z.ZodType> {
  readonly name: string;
  readonly task: string;
  readonly evidence: readonly EvidenceInput[];
  readonly schemaName: string;
  readonly schema: S;
  readonly maxOutputTokens: number;
  readonly validators?: readonly OutputValidator<z.infer<S>>[];
  /** defaults to the workflow's model */
  readonly model?: "small" | "large";
  readonly reasoningEffort?: ReasoningEffort;
}

export interface WorkflowContext {
  readonly runId: string;
  call<S extends z.ZodType>(spec: CallSpec<S>): Promise<z.infer<S>>;
  /** validated now, written only when the run succeeds (with its outbox row, one transaction) */
  proposeAction(kind: string, payload: unknown): Promise<ProposalCheck>;
}

export interface WorkflowDef<I extends JsonValue, O> {
  readonly prompt: PromptDef;
  /** bump when the output schema changes; part of the cache key */
  readonly schemaVersion: string;
  readonly model: "small" | "large";
  readonly outputSchema: z.ZodType<O>;
  run(ctx: WorkflowContext, input: I): Promise<O>;
}

export interface RunDeps {
  readonly provider: AiProvider;
  readonly store: RunStore;
  readonly config: AgentConfig;
  readonly workspaceId: WorkspaceId;
  readonly correlationId: string;
  readonly now?: () => number;
}

export interface RunTotals {
  readonly calls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export type RunOutcome<O> =
  | ({
      readonly status: "succeeded" | "cache_hit";
      readonly runId: string;
      readonly output: O;
      readonly proposedActionIds: readonly string[];
    } & RunTotals)
  | ({ readonly status: HaltStatus; readonly runId: string | null; readonly reason: string } & RunTotals);

/** Thrown inside a run to stop it; the harness turns it into the run's status. */
export class RunHalt extends Error {
  readonly status: HaltStatus;
  constructor(status: HaltStatus, reason: string) {
    super(reason);
    this.name = "RunHalt";
    this.status = status;
  }
}

const WORKFLOW_GRACE_MS = 1_000;

const ZERO: RunTotals = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };

/** input_hash = canonicalHash({task, promptVersion, model, schemaVersion, input}) */
export function cacheKey(prompt: PromptDef, schemaVersion: string, model: string, input: JsonValue): Sha256 {
  return canonicalHash({ task: prompt.task, promptVersion: prompt.id, model, schemaVersion, input });
}

export async function runWorkflow<I extends JsonValue, O>(
  def: WorkflowDef<I, O>,
  input: I,
  deps: RunDeps,
): Promise<RunOutcome<O>> {
  if (deps.config.killSwitchEnv || (await deps.store.killSwitch()))
    return { status: "kill_switch", runId: null, reason: "agent kill switch is on", ...ZERO };
  const model = deps.config.models[def.model];
  const inputHash = cacheKey(def.prompt, def.schemaVersion, model, input);
  const cached = await fromCache(def, model, inputHash, deps);
  if (cached) return cached;
  const runId = await deps.store.startRun({
    workspaceId: deps.workspaceId,
    task: def.prompt.task,
    promptVersion: def.prompt.id,
    model,
    inputHash,
    correlationId: deps.correlationId,
    status: "running",
  });
  return new Run(def, deps, runId).execute(input);
}

async function fromCache<I extends JsonValue, O>(
  def: WorkflowDef<I, O>,
  model: string,
  inputHash: Sha256,
  deps: RunDeps,
): Promise<RunOutcome<O> | null> {
  const hit = await deps.store.findCachedOutput(deps.workspaceId, def.prompt.task, inputHash);
  if (!hit) return null;
  const parsed = def.outputSchema.safeParse(hit.output);
  if (!parsed.success) return null; // an unreadable cached output is a miss, never an error
  const base = { workspaceId: deps.workspaceId, task: def.prompt.task, correlationId: deps.correlationId };
  const runId = await deps.store.startRun({
    ...base,
    promptVersion: def.prompt.id,
    model,
    inputHash,
    status: "cache_hit",
  });
  await deps.store.finishRun({
    ...base,
    runId,
    status: "cache_hit",
    output: hit.output,
    error: null,
    latencyMs: 0,
    proposals: [],
  });
  return { status: "cache_hit", runId, output: parsed.data, proposedActionIds: [], ...ZERO };
}

/** One run's mutable state: step counter, totals, the deadline and the buffered proposals. */
class Run<I extends JsonValue, O> {
  private readonly def: WorkflowDef<I, O>;
  private readonly deps: RunDeps;
  private readonly runId: string;
  private readonly now: () => number;
  private readonly started: number;
  private readonly proposals: CheckedProposal[] = [];
  private steps = 0;
  private totals: RunTotals = ZERO;
  private halted: RunHalt | null = null;

  constructor(def: WorkflowDef<I, O>, deps: RunDeps, runId: string) {
    this.def = def;
    this.deps = deps;
    this.runId = runId;
    this.now = deps.now ?? Date.now;
    this.started = this.now();
  }

  async execute(input: I): Promise<RunOutcome<O>> {
    const ctx: WorkflowContext = {
      runId: this.runId,
      call: (spec) => this.call(spec),
      proposeAction: (kind, payload) => this.propose(kind, payload),
    };
    try {
      // a grace second so a call in flight hits its own deadline first and records its step
      const output = await withDeadline(
        this.def.run(ctx, input),
        this.remainingMs() + WORKFLOW_GRACE_MS,
        "workflow",
      );
      if (this.halted) throw this.halted; // the workflow swallowed a halt: the halt still wins
      return await this.succeed(output);
    } catch (e) {
      const halt = e instanceof RunHalt ? e : (this.halted ?? asHalt(e));
      return this.fail(halt);
    }
  }

  private remainingMs(): number {
    return this.started + this.deps.config.limits.wallClockMs - this.now();
  }

  private async succeed(output: O): Promise<RunOutcome<O>> {
    const checked = this.def.outputSchema.safeParse(output);
    if (!checked.success) throw new RunHalt("failed_output", "workflow output failed its schema");
    if (this.proposals.length > 0 && (await this.killSwitchOn()))
      throw new RunHalt("kill_switch", "kill switch turned on during the run; proposals not written");
    const { proposedActionIds } = await this.deps.store.finishRun({
      ...this.finishBase(),
      status: "succeeded",
      output: toJson(checked.data),
      error: null,
      proposals: this.proposals,
    });
    return {
      status: "succeeded",
      runId: this.runId,
      output: checked.data,
      proposedActionIds,
      ...this.totals,
    };
  }

  private async fail(halt: RunHalt): Promise<RunOutcome<O>> {
    await this.deps.store.finishRun({
      ...this.finishBase(),
      status: halt.status,
      output: null,
      error: halt.message,
      proposals: [],
    });
    return { status: halt.status, runId: this.runId, reason: halt.message, ...this.totals };
  }

  private finishBase() {
    return {
      workspaceId: this.deps.workspaceId,
      runId: this.runId,
      task: this.def.prompt.task,
      correlationId: this.deps.correlationId,
      latencyMs: Math.max(0, Math.round(this.now() - this.started)),
    };
  }

  private async killSwitchOn(): Promise<boolean> {
    return this.deps.config.killSwitchEnv || (await this.deps.store.killSwitch());
  }

  private halt(status: HaltStatus, reason: string): RunHalt {
    this.halted ??= new RunHalt(status, reason);
    return this.halted;
  }

  private async guardStep(name: string, status: string, detail: JsonValue): Promise<void> {
    await this.deps.store.recordStep({
      workspaceId: this.deps.workspaceId,
      runId: this.runId,
      stepIndex: this.steps++,
      kind: "guardrail",
      name,
      model: null,
      inputHash: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: null,
      status,
      detail,
      correlationId: this.deps.correlationId,
    });
  }

  /** Call limit, wall clock and both budgets, before any request leaves. */
  private async preflight(name: string): Promise<void> {
    const { limits } = this.deps.config;
    if (this.halted) throw this.halted;
    if (this.totals.calls >= limits.maxCalls) {
      await this.guardStep(name, "limit_calls", { calls: this.totals.calls, max: limits.maxCalls });
      throw this.halt(
        "limit_calls",
        `model call ${String(this.totals.calls + 1)} refused: limit is ${String(limits.maxCalls)} per run`,
      );
    }
    if (this.remainingMs() <= 0) {
      await this.guardStep(name, "limit_time", { wallClockMs: limits.wallClockMs });
      throw this.halt("limit_time", `run exceeded ${String(limits.wallClockMs)} ms`);
    }
    const spend = await this.deps.store.spend(this.deps.workspaceId, utcDayStart(this.now()));
    const budget = checkBudget(spend, this.deps.config);
    if (!budget.ok) {
      await this.guardStep(name, "budget_exceeded", { ...budget });
      throw this.halt(
        "budget_exceeded",
        `${budget.cap} cap $${String(budget.capUsd)} reached ($${budget.spentUsd.toFixed(6)} spent)`,
      );
    }
  }

  private async call<S extends z.ZodType>(spec: CallSpec<S>): Promise<z.infer<S>> {
    const system = `${this.def.prompt.system}\n\n${DATA_CHANNEL_RULES}`;
    assertNoEvidenceIn(system, spec.evidence);
    assertNoEvidenceIn(spec.task, spec.evidence);
    const guarded = guardInput(spec.evidence);
    let task = spec.task;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.callOnce(spec, system, task, guarded, attempt);
      if (res.ok) return res.value;
      if (attempt === 0) task = repairTask(spec.task, res.problems);
      else
        throw this.halt(
          "failed_output",
          `${spec.name}: output still invalid after one repair: ${res.problems.join("; ").slice(0, 500)}`,
        );
    }
    throw this.halt("failed_output", `${spec.name}: unreachable`);
  }

  private async callOnce<S extends z.ZodType>(
    spec: CallSpec<S>,
    system: string,
    task: string,
    guarded: ReturnType<typeof guardInput>,
    attempt: number,
  ): Promise<{ ok: true; value: z.infer<S> } | { ok: false; problems: string[] }> {
    const name = attempt === 0 ? spec.name : `${spec.name}:repair`;
    await this.preflight(name);
    const model = this.deps.config.models[spec.model ?? this.def.model];
    const maxOutputTokens = Math.min(spec.maxOutputTokens, this.deps.config.limits.maxOutputTokensPerStep);
    const started = this.now();
    const request = {
      model,
      system,
      task,
      dataBlocks: guarded.blocks,
      schemaName: spec.schemaName,
      schema: spec.schema,
      maxOutputTokens,
      ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
    };
    this.totals = { ...this.totals, calls: this.totals.calls + 1 };
    const pending = this.deps.provider.complete(request);
    const res = await withDeadline(pending, this.remainingMs(), name).catch(async (e: unknown) => {
      if (e instanceof RunHalt) {
        await this.guardStep(name, "limit_time", { wallClockMs: this.deps.config.limits.wallClockMs });
        this.recordLate(`${name}:late`, request, pending, guarded.flags, started);
      }
      throw e instanceof RunHalt ? this.halt(e.status, e.message) : e;
    });
    const outcome = res.ok ? checkOutput(spec.schema, res.output, spec.validators ?? []) : null;
    await this.recordCall(name, request, res, guarded.flags, outcome, Math.round(this.now() - started));
    if (!res.ok) return this.onFailure(name, res.error);
    return outcome?.ok
      ? { ok: true, value: outcome.value }
      : { ok: false, problems: outcome?.problems ?? [] };
  }

  /** BL-01: a call abandoned at the wall clock may still be billed; its usage is recorded when it lands. */
  private recordLate(
    name: string,
    request: Parameters<Run<I, O>["recordCall"]>[1],
    pending: Promise<CompletionResult<unknown>>,
    flags: Parameters<Run<I, O>["recordCall"]>[3],
    started: number,
  ): void {
    void pending
      .then((late) => this.recordCall(name, request, late, flags, "late", Math.round(this.now() - started)))
      .catch(() => undefined);
  }

  private onFailure(
    name: string,
    error: { kind: AiFailureKind; detail: string },
  ): { ok: false; problems: string[] } {
    const { kind } = error;
    if (DEGRADING_FAILURES.has(kind))
      throw this.halt("degraded", `${name}: provider ${error.kind}: ${error.detail}`);
    if (kind === "rejected" || kind === "refusal")
      throw this.halt("failed", `${name}: ${error.kind}: ${error.detail}`);
    return { ok: false, problems: [`${error.kind}: ${error.detail}`] }; // incomplete / invalid_output → repair
  }

  private async recordCall(
    name: string,
    req: {
      model: string;
      system: string;
      task: string;
      dataBlocks: readonly { id: string; sha256: Sha256; flagged: boolean }[];
      maxOutputTokens: number;
    },
    res: CompletionResult<unknown>,
    flags: readonly { evidenceId: string; pattern: string; match: string }[],
    outcome: { ok: boolean } | "late" | null,
    latencyMs: number,
  ): Promise<void> {
    const tokensIn = res.usage?.inputTokens ?? 0;
    const tokensOut = res.usage?.outputTokens ?? 0;
    this.totals = {
      ...this.totals,
      tokensIn: this.totals.tokensIn + tokensIn,
      tokensOut: this.totals.tokensOut + tokensOut,
      costUsd: this.totals.costUsd + res.costUsd,
    };
    const status =
      outcome === "late" ? "late" : !res.ok ? res.error.kind : outcome?.ok ? "ok" : "invalid_output";
    await this.deps.store.recordStep({
      workspaceId: this.deps.workspaceId,
      runId: this.runId,
      stepIndex: this.steps++,
      kind: "call",
      name,
      model: res.model,
      inputHash: canonicalHash({
        model: req.model,
        system: req.system,
        task: req.task,
        blocks: req.dataBlocks.map((b) => b.sha256),
      }),
      tokensIn,
      tokensOut,
      costUsd: res.costUsd,
      latencyMs,
      status,
      detail: {
        injectionFlags: flags.map((f) => ({ ...f })),
        blocks: req.dataBlocks.map((b) => ({ id: b.id, sha256: b.sha256, flagged: b.flagged })),
        maxOutputTokens: req.maxOutputTokens,
        error: res.ok ? null : res.error.detail.slice(0, 500),
      },
      correlationId: this.deps.correlationId,
    });
  }

  private async propose(kind: string, payload: unknown): Promise<ProposalCheck> {
    const check: ProposalCheck = (await this.killSwitchOn())
      ? { ok: false, reason: "kill_switch_on", detail: "agent kill switch is on" }
      : checkProposal(kind, payload);
    if (check.ok) this.proposals.push(check.proposal);
    await this.guardStep("proposal", check.ok ? "accepted" : check.reason, {
      kind,
      payloadSha256: check.ok ? check.proposal.payloadSha256 : null,
      detail: check.ok ? null : check.detail.slice(0, 500),
    });
    return check;
  }
}

/** Our own text: the first task plus the validator's complaint. Never the model's output verbatim. */
function repairTask(task: string, problems: readonly string[]): string {
  return `${task}\n\nYour previous answer was rejected by validation. Return output that satisfies the schema and these checks:\n- ${problems.join("\n- ").slice(0, 1500)}`;
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function asHalt(e: unknown): RunHalt {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : "unknown error";
  return new RunHalt("failed", msg.slice(0, 500));
}

/** Rejects with RunHalt(limit_time) when `promise` outlives `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  if (ms <= 0) return Promise.reject(new RunHalt("limit_time", `${what}: wall clock exhausted`));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RunHalt("limit_time", `${what}: run exceeded its wall clock`));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    clearTimeout(timer);
  });
}
