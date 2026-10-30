---
title: "M2-05 · Proof-pack UI (evidence, verdicts with citations)"
milestone: "M2 · Dispute Loop"
labels: [frontend]
blocked_by: [M2-04]
estimate: "5h"
resources: []
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-12, P-14]
---

## Context
The proof pack is the hero screen for pillar P1 and the 0:20–0:45 storyboard scene: the seller adds scope and delivery evidence and sees the AI's verdicts with sources. Judges score Design and Presentation here, and "cited claims" is the trust story. Built to `docs/design/` (M1-06).

## Scope
- Route `apps/web/app/[locale]/payments/[paymentId]/pack/page.tsx` (server component for reads; client components for intake and polling)
- **Evidence intake panel**: upload (jpg/png/gif/pdf, client-side pre-check of type/size with the same caps, server is authoritative) and paste-chat textarea with kind selector; shows the server's typed error codes as human messages
- **Evidence list**: kind, filename or first line, added time (seller tz), sha256 short form, injection-flag badge ("contains text that looks like instructions; treated as data"), download link
- **Facts** (from M2-03) grouped by type; separate rows for sent / opened / accepted
- **Verdicts**: one row per scope line with `met | partial | missing | unverifiable` (text + icon, never colour alone); each citation shows the quoted span highlighted in context (offsets from M2-04) and links to its evidence item; `unverifiable` shows its reason (`no citation`, `image_only_support`)
- Pack state banner: collecting / checking (spinner) / checked / stale ("new evidence: re-checking") / `check_unavailable` ("AI is unavailable: facts shown without a verdict") / `budget_exceeded`
- SWR polling every 5 s while state is collecting or checking; stops when settled
- All model output rendered as **plain text** (no markdown/HTML rendering; test asserts `<script>` in a fact renders literally)
- EN + HI strings in `apps/web/messages/` (hot file); empty, loading and error states; mobile-first; WCAG 2.2 AA (labels, focus order, live region for state changes, 4.5:1 contrast)
- **Dashboard elements** (`docs/design/screens/dashboard.md`, elements 3c, 6, 16): the `SummaryBar` "{count} payments proof-ready" fact (packs in state `checked` with no `missing` verdict; replaces the M1 "—"; `file-check` icon), the row sub-line "Proof pack: scope {s} · delivery {d} · client sign-off {c} · {n} sources" (verdict word + icon, never a bare tick; sign-off shows its pending state until M3-06), and for a new payment with an empty pack the row "New payment from {buyer}. Add proof so it's ready if PayPal asks." with the secondary button "Add proof" opening this page's intake panel
- Read API used by the page: `GET /api/packs/:packId` (pack state, facts, verdicts with citations), workspace-scoped

## Out of scope
- Intake routes (M2-01); verdict logic (M2-04); dispute screens (M2-09)
- Client acknowledgement link and scope snapshot (M3-06, M3-07); full Hindi review (M4-03); the global a11y/perf pass (M4-04)

## Acceptance Criteria
- [ ] Playwright (fixture-backed seed, no live calls): add a pasted chat and a PDF → states go collecting → checking → checked, and verdict rows appear with highlighted quotes
- [ ] Every highlighted quote equals the evidence text slice at its offsets (e2e asserts on DOM text)
- [ ] `unverifiable` rows show the reason; `check_unavailable` state shows facts and no verdicts
- [ ] A rejected 11 MB upload shows the localised `EVIDENCE_TOO_LARGE` message; nothing is added
- [ ] Model text containing `<img src=x onerror=alert(1)>` renders as literal text (e2e)
- [ ] Another workspace's pack URL returns the not-found page
- [ ] axe-core finds no serious/critical violations on all states; keyboard-only flow works; page works at 360 px width
- [ ] `/hi/...` renders every string from `messages/hi.json` (no missing-key warnings)
- [ ] Playwright `dashboard-proof.spec.ts`: after a pack reaches `checked`, the dashboard summary shows "1 payment proof-ready" (count excludes any pack with a `missing` verdict) and clicking it applies `?filter=proof-ready`
- [ ] The payment row sub-line reads "Proof pack: scope met · delivery met · client sign-off … · 3 sources" from the pack's verdicts, each verdict as word + icon (component test; no bare tick glyph in the DOM)
- [ ] A new payment with an empty pack shows "Add proof"; activating it opens the pack page with focus in the intake panel (e2e); the button is absent once the pack has evidence
- [ ] `ui-reviewer` passes against `docs/design/`

## Deliverables
- `apps/web/app/[locale]/payments/[paymentId]/pack/page.tsx` and `components/pack/{EvidenceIntake,EvidenceList,FactsList,VerdictRow,Citation,PackStateBanner}.tsx`
- `apps/web/app/api/packs/[packId]/route.ts`
- `apps/web/messages/en.json`, `hi.json` (pack keys)
- `apps/web/e2e/proof-pack.spec.ts`, `apps/web/e2e/dashboard-proof.spec.ts`; dashboard additions in `apps/web/components/payments/` (`SummaryBar` proof-ready fact, pack sub-line, "Add proof" action) and message keys `summary.proofReady`, `row.pack`, `row.addProof`, `row.newPayment`

## Validation Gate
```bash
pnpm --filter ./apps/web exec vitest run components/pack
pnpm --filter ./apps/web exec playwright test e2e/proof-pack.spec.ts e2e/dashboard-proof.spec.ts
pnpm --filter ./apps/web run typecheck && pnpm --filter ./apps/web run lint
./scripts/landing-checks.sh --fast
```

## Handoff
- M2-09 links from a dispute to its pack and reuses `Citation` and `PackStateBanner`
- M2-10's judge scenario lands the judge on this page after seeding evidence
- M4-03/M4-04 run their Hindi and a11y/performance passes over this screen
