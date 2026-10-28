---
title: "M4-03 · Hindi i18n + currency/time-zone formatting"
milestone: "M4 · Trust & Global"
labels: ["frontend"]
blocked_by: ["M3-GATE"]
estimate: "4h"
resources: []
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-12, P-14]
---

## Context

Cleared serves sellers in India, Kenya, Nigeria, Indonesia, the Philippines and beyond (architecture §1 "Global": EN + HI at launch; currencies as PayPal returns them; UTC stored, seller time zone shown). The video's 0:45 scene shows a hold explained in Hindi. Rubric: Design (one coherent multilingual journey) and Potential Impact (a global audience). Earlier tickets used next-intl keys; this ticket completes Hindi coverage and makes money and time formatting correct everywhere.

## Scope

- **Hindi coverage:**
  - `apps/web/messages/hi.json` reaches full key parity with `en.json`: every screen, empty, loading and error state, toast, form error, email template (M3-08) and PDF label (M3-07)
  - translations follow a short glossary (`docs/design/i18n-glossary.md`) that keeps PayPal terms recognisable ("hold", "dispute" → Hindi with the English term in brackets on first use)
- **No hard-coded UI strings:** a lint check fails on JSX text literals outside message files. Use core ESLint `no-restricted-syntax` with the selector `JSXText[value=/\\S/]`: `eslint-plugin-react` 7.37.5 doesn't support ESLint 10 (peer `^9.7`, checked 2026-10-28)
- **Locale handling:**
  - the locale switcher (EN/HI) is persisted to `workspaces.locale` and sets `<html lang>`
  - a Devanagari font is loaded with `next/font` (subset, `display: swap`)
  - layouts hold at 320 CSS px with longer Hindi strings
- **Formatting helpers** in `packages/core/src/format/` (pure; `Intl` only):
  - `formatMoney(decimalString, currency, locale)`: PayPal decimal strings are never converted to float. Currency minor units are respected (JPY, HUF, TWD have none). Indian grouping applies for `hi-IN` / `en-IN`
  - original and receivable amounts are shown side by side, with PayPal's exchange rate when present
  - `formatDateTime(utcIso, tz, locale)` and `formatRelative`: deadlines appear in the workspace IANA time zone with UTC in a tooltip. The time zone is detected on workspace creation and editable
  - every screen, email and PDF uses these helpers; a lint rule bans direct `toLocaleString` and `toFixed` on money
- **AI output language:** hold explanations follow the workspace locale (M3-02). Dispute notes filed to PayPal stay **English** whatever the UI locale; the UI labels this ("sent to PayPal in English")
- Build to `docs/design/`; WCAG 2.2 AA; pass `ui-reviewer`

## Out of scope

- The full accessibility and performance pass (M4-04)
- Languages beyond EN/HI (backlog)
- Model prompt changes for explanations (M3-02; any change goes through the M4-02 eval)

## Acceptance Criteria

- [ ] `pnpm i18n:check` exits 0: identical key sets in `en.json` and `hi.json`, no empty values, ICU placeholders matching per key
- [ ] Lint fails on a planted JSX string literal and passes on the tree
- [ ] Unit tests for `formatMoney` cover USD, EUR, INR (lakh grouping), JPY (0 decimals) and a negative refund amount, in `en-US`, `en-IN` and `hi-IN`. `"0.10" + "0.20"`-style inputs never pass through a float (tested)
- [ ] Unit tests for `formatDateTime` cover Asia/Kolkata, Africa/Lagos, Africa/Nairobi and Asia/Jakarta, plus a DST zone (America/Los_Angeles on 2026-11-01). Deadlines render T-72 h / T-24 h correctly in each zone
- [ ] Playwright runs the judge path with `locale=hi` on fixture replay: no missing-key warnings in the console, `<html lang="hi">`, and no horizontal scroll at 320 px. Screenshots are saved
- [ ] The email and PDF snapshot tests pass in both locales
- [ ] `ui-reviewer` passes, in both locales

## Deliverables

- `apps/web/messages/hi.json` (hot file: one ticket at a time), `apps/web/messages/en.json` fixes
- `packages/core/src/format/{money,datetime}.ts` + tests; the export added to `packages/core/src/index.ts` (hot file)
- `scripts/check-i18n.ts`, the lint rule config, `docs/design/i18n-glossary.md`
- `apps/web/e2e/i18n-hi.spec.ts`

## Validation Gate

```bash
set -euo pipefail
pnpm install --frozen-lockfile
pnpm i18n:check
pnpm lint
pnpm --filter @cleared/core test -- format
pnpm --filter @cleared/web test
pnpm --filter @cleared/web exec playwright test e2e/i18n-hi.spec.ts --output "$TMPDIR/pw-hi"
```

## Handoff

- **M4-04** audits both locales (axe, keyboard, contrast, Devanagari font weight in the performance budget)
- **M5-02** records the 0:45 scene in Hindi
- **M5-01** states "EN + HI; amounts in original and receivable currency; deadlines in your time zone"
