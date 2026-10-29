# 0016. Cash calendar: Bryntum Calendar only

- Status: accepted
- Date: 2026-10-29
- Supersedes: the FullCalendar fallback in ADR 0005

## Context

The cash calendar (storyboard 1:50–2:15, pillar P2) was planned as Bryntum Calendar with a FullCalendar (MIT) fallback behind `CashCalendar`, chosen on 2026-11-04 depending on Bryntum's licence answer (M0-01). The M0-09 spike ran both in Next 16 / React 19 and recommended FullCalendar on size, render time and a11y. It also found that the Bryntum trial licence (clause 4.2) allows internal evaluation only, for 30 + 30 days, and that the trial build may stop working after that.

## Decision

The owner decided on 2026-10-29: **Bryntum Calendar only**, no FullCalendar fallback. The owner obtains Bryntum's written permission to show the trial on the public demo until 2026-12-15 (and the trial extension) before the calendar ships. This is enforced as prerequisite **P-38, required by M3-05**: because every merge to `main` auto-deploys to the public URL, M3-05 does not start until the written OK is recorded. `CashCalendar` stays as the wrapper (typed props, client-only `next/dynamic`), together with the accessible list-of-upcoming-releases table, which serves screen readers and the no-JS path.

## Alternatives considered

FullCalendar fallback (rejected by the owner: the project targets the Bryntum sponsor prize); shipping the trial without permission (rejected: it breaks the trial licence).

## Consequences

- The cash calendar depends on Bryntum's answer. If none arrives by 2026-11-04, the owner decides the next step (accepted risk, owner 2026-10-29).
- From M0-09: +1.5 MiB gzip JS behind a lazy load; the trial watermark; a known `timeZone` all-day shift, so don't pass `timeZone`; an obfuscated postinstall (`allowBuilds`); axe findings to fix in M3-05; a built-in Hindi locale.
- Reversal cost: low. `CashCalendar` keeps the engine behind one interface.
