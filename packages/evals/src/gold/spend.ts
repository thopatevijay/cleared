// SPEND.md: one row per live run and model, appended at the end of the run from the API responses'
// usage (tokens × pricing.ts). Replay runs spend nothing and write nothing. `validate` checks every UTC
// day stays within the OpenAI daily budget (LLM_DAILY_CAP_USD, docs/budget.md).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { TokenUsage } from "@cleared/adapters/ai/pricing";
import { SPEND_FILE } from "./io.ts";

export const DAILY_BUDGET_USD = 1;

export const SPEND_HEADER = [
  "# Gold-set spend (M4-01)",
  "",
  "One row per live run and model, from the API responses' `usage` (tokens × `packages/adapters/src/ai/pricing.ts`).",
  `Replay runs spend nothing. Each UTC day must stay ≤ $${DAILY_BUDGET_USD.toFixed(2)} (\`LLM_DAILY_CAP_USD\`, docs/budget.md).`,
  "",
  "| date (UTC) | command | model | calls | input tokens | cached | output tokens | reasoning | USD |",
  "|---|---|---|---|---|---|---|---|---|",
].join("\n");

interface Tally {
  calls: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  usd: number;
}

export interface SpendLedger {
  add(model: string, usage: TokenUsage | null, usd: number): void;
  /** Appends one row per model to SPEND.md; no row when nothing was spent. */
  flush(command: string, now?: Date): void;
}

export function createSpendLedger(file = SPEND_FILE): SpendLedger {
  const byModel = new Map<string, Tally>();
  return {
    add(model, usage, usd) {
      const t = byModel.get(model) ?? { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, usd: 0 };
      t.calls += 1;
      t.input += usage?.inputTokens ?? 0;
      t.cached += usage?.cachedInputTokens ?? 0;
      t.output += usage?.outputTokens ?? 0;
      t.reasoning += usage?.reasoningTokens ?? 0;
      t.usd += usd;
      byModel.set(model, t);
    },
    flush(command, now = new Date()) {
      if (byModel.size === 0) return;
      const day = now.toISOString().slice(0, 10);
      const rows = [...byModel].map(
        ([m, t]) =>
          `| ${day} | ${command} | ${m} | ${String(t.calls)} | ${String(t.input)} | ${String(t.cached)} | ${String(t.output)} | ${String(t.reasoning)} | ${t.usd.toFixed(4)} |`,
      );
      const current = existsSync(file) ? readFileSync(file, "utf8").trimEnd() : SPEND_HEADER;
      writeFileSync(file, `${current}\n${rows.join("\n")}\n`);
      byModel.clear();
    },
  };
}

/** USD per UTC day from SPEND.md rows. */
export function spendByDay(markdown: string): Map<string, number> {
  const days = new Map<string, number>();
  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const day = cells[1] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const usd = Number(cells[9]);
    if (!Number.isFinite(usd)) throw new Error(`SPEND.md: bad USD cell in "${line}"`);
    days.set(day, (days.get(day) ?? 0) + usd);
  }
  return days;
}
