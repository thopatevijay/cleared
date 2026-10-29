# 0005. Next.js App Router frontend, i18n and one Bryntum calendar

- Status: accepted
- Date: 2026-10-28

## Context

Design is 20% of the score; the users are global and mobile-first; Bryntum is a sponsor whose trial licence for public demos is pending confirmation.

## Decision

Next.js 16 App Router: server components for reads, client components for interactive panels. Tailwind 4 with design tokens; next-intl with EN + HI; WCAG 2.2 AA; empty, loading and error states on every screen. Performance budget: LCP < 2.5 s, INP < 200 ms, CLS < 0.1. The cash calendar is one Bryntum Calendar wrapped in a `CashCalendar` component. The FullCalendar fallback was dropped by the owner on 2026-10-29 (ADR 0016).

## Alternatives considered

A client-only SPA (worse first load on mobile); several Bryntum views (licence risk, no requirement).

## Consequences

One component boundary isolates the licence risk. Reversal cost: low.
