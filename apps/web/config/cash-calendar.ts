// M3-05 (ADR 0016): where the cash calendar's engine comes from, and the permission to show it publicly.
// Bryntum Calendar is the only engine (no fallback); `CashCalendar` keeps the props engine-neutral.
// No licence key lives in this repo: the trial build needs none. A licensed build (P-39) would change
// `install` to the npm.bryntum.com route and add BRYNTUM_NPM_TOKEN to the Render and CI builds only.

export interface EngineInstall {
  /** the package.json specifiers in apps/web */
  readonly packages: Readonly<Record<string, string>>;
  readonly route: "public-npm-trial" | "bryntum-registry";
  /** YYYY-MM-DD the route was decided and verified */
  readonly decidedOn: string;
  /** where the decision is recorded */
  readonly source: string;
}

export interface EnginePermission {
  /** a link to (or the location of) Bryntum's written answer */
  readonly url: string;
  /** YYYY-MM-DD of the answer */
  readonly receivedOn: string;
  /** what it covers, in Bryntum's words */
  readonly scope: string;
}

export const CASH_CALENDAR_ENGINE = {
  name: "Bryntum Calendar",
  version: "7.3.8",
  install: {
    packages: {
      "@bryntum/calendar": "npm:@bryntum/calendar-trial@7.3.8",
      "@bryntum/calendar-react": "7.3.8",
    },
    route: "public-npm-trial",
    decidedOn: "2026-10-29",
    source:
      "Owner decision on M0-09 (issue #11, PR #77): the trial from public npm, no registry login; ticket M3-05 (issue #37)",
  } satisfies EngineInstall,
  /**
   * Bryntum's written permission to show the trial on the public demo until 2026-12-15 (P-38).
   * The trial licence (v39 §4.2) covers internal evaluation only, so this must be set before the PR merges.
   */
  permission: null as EnginePermission | null, // P-38 deferred to M5-SUBMIT by owner decision 2026-11-03
  /** the trial build shows a watermark; the licence requires it to stay */
  watermark: true,
} as const;
