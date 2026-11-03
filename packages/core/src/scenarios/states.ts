// The judge scenario's states, without zod (M4-08): the dashboard's scenario entry reads them in the
// browser. judge-dispute.ts re-exports them.

export const SCENARIO_STATES = [
  "capturing",
  "seeding",
  "charging_back",
  "polling",
  "resolved",
  "timed_out",
  "failed",
] as const;
export type ScenarioState = (typeof SCENARIO_STATES)[number];

/** At most one run per workspace is in one of these (unique partial index on `scenario_runs`). */
export const SCENARIO_ACTIVE_STATES = [
  "capturing",
  "seeding",
  "charging_back",
  "polling",
] as const satisfies readonly ScenarioState[];
