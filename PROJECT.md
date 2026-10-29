# Cleared: project spec

> The single spec for the build. The architecture lives in [docs/architecture.md](docs/architecture.md) and the decisions in [docs/adr/](docs/adr/). The research behind it is in `docs/research/RESEARCH.md` (private, gitignored).

## 1. Hard facts

All re-verified 2026-10-28 from paypalaihackathon.devpost.com/rules.

| Item | Fact |
|---|---|
| Event | PayPal AI Hackathon, "Build what's next with PayPal and AI" (Devpost; sponsor PayPal Inc., administrator Devpost) |
| Theme | Open innovation; "must meaningfully use both PayPal and AI"; the PayPal developer platform in the **sandbox** |
| **Submission deadline** | **Thu 2026-11-12 12:00 PT (PST) = 20:00 UTC = Fri 2026-11-13 01:30 IST.** Internal submit target: **2026-11-12 18:00 IST** |
| Judging | 2026-12-01 14:00 PT → 2026-12-15 08:00 PT; winners ~2026-12-21. **The project must stay testable until 2026-12-15** |
| Rubric | Stage One pass/fail ("reasonably applies the required APIs/SDKs"). Stage Two: five **equally weighted** criteria — Technological Implementation · Design · Potential Impact · Innovation/Idea · Presentation. Tie-break in that order |
| Artefacts | Text description; functional demo (hosted URL or complete run instructions); the AI tools named and how they're used; **public** GitHub repo with an **OSS licence visible in About**; YouTube video **< 3 min** showing it working, with no unlicensed music or trademarks |
| Prizes | Grand $12k / $8k / $5k; honourable mentions $5k each (Most Creative, Most Impactful, Best Demo Delivery, Best Use of PayPal + AI, Best Use of Agentic Commerce); sponsors: AG Grid, APIMatic, **Bryntum 3 × $1k**, Channel3, Render credits. **Max one Grand OR one HM, plus one Sponsor** |
| Targets | Most Impactful, Best Use of PayPal + AI, Grand; sponsor: Bryntum (licence pending); Render used for hosting |
| Disqualifiers | Repo not public or no licence; non-functional demo; committed live keys; prior work not "significantly updated"; employees of PayPal, Devpost or any judge's employer; residents of excluded jurisdictions |
| Judges' keys | Devpost manager: "Judges won't have their own Anthropic key… The easiest option is a hosted demo URL… Please don't commit a live key" (forum 45465) |
| AI judging | Judging "may utilize… automated AI-driven analysis", and judges may judge from the text, images and video alone, so the README must stand on its own |
| Helpdesk | PayPal Discord https://discord.gg/sJ2G6DyvSK (organiser routes technical questions there) |
| Team | Solo (Vijay Thopate, India: eligible) |

**Open questions** (M0-01):
- [ ] Bryntum: written OK for a public, judge-facing demo on the trial until 2026-12-15 (decision date 2026-11-04)
- [ ] PayPal: a Transaction Search scope for the sandbox app (missing from the old app's token; the fresh M0-00 app's token carries it, verified 2026-10-29 via P-22; a 200 from the Search/balances endpoints is not yet measured, M0-04)
- [ ] Organisers: confirm that a sandbox-only build with a labelled sandbox decision step is acceptable

## 2. Product

**One line:** an AI agent that keeps a small cross-border seller's PayPal money flowing. It builds proof for every payment as it arrives, explains and works through holds, and answers disputes and PayPal's document requests from that same proof. **The agent does the work; the seller holds the keys.**

**Pain:**

| Pain | Evidence | Who suffers |
|---|---|---|
| Earnings frozen with little explanation | "My legitimate freelance earnings are now frozen under an unjustified 180-day hold." (Trustpilot, IN, 2026-09-29); "tens of thousands of dollars held indefinitely with very little transparency" (HN 47122932, 2026-02-23) | freelancers, small sellers |
| Proof demanded after the fact | "Next is a hold on your suspicious transaction, request additional documents for your own money" (HN 50057108, 2026-10-12); "provide an invoice or a contract signed by both parties" (Trustpilot, SV, 2026-09-22) | service sellers |
| Disputes lost for lack of organised evidence | PayPal intangible coverage needs "compelling evidence" from a "system of record" (PayPal Seller Protection policy); dispute deadlines auto-close for the buyer | service and digital sellers |
| No warning before it happens | "Merchants often don't realize they're carrying risk exposure until funds are frozen" (HN 47124945, 2026-02-23) | all sellers |

(Inference, labelled: most of this pain falls on sellers who don't know PayPal's published release steps and gather proof only after PayPal asks.)

**Users:** freelance and service sellers (primary); small cross-border goods sellers; social-commerce sellers; small nonprofits. India, Kenya, Nigeria, Indonesia, the Philippines and beyond.

**Core journey:**
1. A payment arrives (webhook).
2. The seller adds the agreed scope and the delivery evidence (pasted chat, uploads). The client can acknowledge the scope through a link.
3. The AI builds the proof pack and checks delivery against scope, citing quotes that appear verbatim in the evidence.
4. A hold appears (capture `PENDING` + reason). Cleared explains it in the seller's language and shows an *estimated* release date with its source.
5. A dispute arrives. The agent drafts the response from the pack (reason-code mapped; one compiled PDF); the seller approves; it's filed through the Disputes API.
6. The case resolves, and the held money returns to `COMPLETED`.
7. Cash calendar, prevention and route advice, email deadline alerts.

**Judge path:** "Try as demo seller" opens an isolated workspace; every step makes real sandbox calls. A card payment is captured; a sandbox chargeback creates a real `PENDING / BUYER_COMPLAINT` hold within about a minute; the pack and evidence are built; a clearly labelled **"Simulate PayPal's decision (sandbox only)"** control resolves the case, and the money is released.

**Demo storyboard (< 3:00):**

| Time | Scene |
|---|---|
| 0:00–0:20 | Pain: three seller quotes (India, Kenya, Nigeria). "Your money is earned, and PayPal is holding it." |
| 0:20–0:45 | A Bengaluru designer gets paid, forwards the client chat and the files. The AI checks scope against delivery, with sources |
| 0:45–1:05 | The dashboard shows a real sandbox payment under review, explained in Hindi, with an estimated release date. Route advice on a goods order |
| 1:05–1:50 | A dispute lands (pre-staged chargeback). The payment flips to held. The agent drafts from the pack; she approves; evidence is filed. "Resolved: she keeps the $120 (PayPal covered the case)" and the hold is released. Real PayPal state changes |
| 1:50–2:15 | Cash calendar. "The agent does the work; you hold the keys" (audit log) |
| 2:15–2:40 | Architecture in one slide; the measured eval numbers |
| 2:40–2:58 | What comes next: "Every payment will carry its proof." |

Staging: create the review-hold payment 24 h ahead and the chargeback ~20 min ahead.

**Success metric:** measured on three gold sets (extraction 30, scope 40, hold explanations 20). Targets: scope-check accuracy ≥ 90%; extraction ≥ 90%; explanations ≥ 95%. Operationally: approved actions accepted by PayPal 100%; dispute → drafted reply < 60 s; zero missed deadlines. Published as measured numbers with *n*.

**Rubric → requirements:**

| Criterion | The product must… |
|---|---|
| Technological Implementation | use Orders, Captures, Disputes, Order Tracking, legacy Tracking and Webhooks for real; run an AI workflow with guardrails, evals and an approval gate |
| Design | deliver one coherent journey: mobile-first, multilingual, accessible, honest limits |
| Potential Impact | serve a named global audience with measurable cash freed and disputes resolved |
| Innovation | build proof at payment time and reuse it for holds, disputes and document requests (0 public repos on holds) |
| Presentation | show real sandbox state changes on camera (held → resolved → released) |

**Pillars:**

| Pillar | Pain it answers | Criterion |
|---|---|---|
| P1 Proof pack (AI scope ↔ delivery check) | proof scattered and gathered too late | Innovation, Tech |
| P2 Held-money inbox, explanations, cash calendar | opacity | Impact, Design |
| P3 Approved actions (tracking, guided Completed, dispute filing) | not knowing the levers | Tech, Presentation |
| P4 Trust layer (approval gate, audit log, cited claims, evals) | "who tests the AI" | Tech |
| P5 Prevention and route advice | "don't realize… until funds are frozen" | Impact |

**Future vision:**
- v2 platform mode (PayPal partner model; marketplaces run it for their sellers)
- v3 cash-flow layer (true take-home after FX and fees; PayPal Currency Exchange APIs)
- v4 proof travels with every payment, readable by PayPal, buyers and buyers' AI agents

## 3. Architecture

See [docs/architecture.md](docs/architecture.md).

## 4. Tech stack

Versions verified on npm 2026-10-28; re-verified in M0-02 on 2026-10-28 (change: `@sentry/*` 11.9.0 → 11.10.0; Bryntum is on its private registry and is checked in M0-09).

| Component | Version | Why |
|---|---|---|
| Node.js | 24.x LTS (`engines >=24`) | Active/Maintenance LTS; 26 entered LTS on 2026-10-28 (accepted, not required) |
| pnpm | 12.15.0 | workspaces, lockfile, CI cache |
| TypeScript | **6.0.3** | typescript-eslint 8.72.1 supports `<6.1.0` (TS 7.0.2 is newer but unsupported by the lint tooling) |
| next / react / react-dom | 16.4.3 / 19.3.1 / 19.3.1 | App Router UI + API |
| tailwindcss | 4.3.3 | design tokens |
| next-intl | 4.14.9 | i18n EN/HI |
| zod | 4.6.7 | shared contracts; `z.toJSONSchema` for structured outputs |
| drizzle-orm / drizzle-kit | 0.45.4 / 0.31.11 | SQL-first schema and migrations |
| pg | 8.23.1 | Postgres driver |
| pg-boss | 12.38.0 | Postgres queue, transactional enqueue, DLQ |
| openai | 7.45.1 | AI provider (owner choice); models verified in M0-07 |
| @paypal/paypal-server-sdk | 2.5.0 | Orders, Payments, Order Tracking (timeouts set explicitly) |
| own typed client | — | Disputes, webhooks, legacy Tracking (not in the SDK) |
| @bryntum/calendar (trial) + @bryntum/calendar-react | 7.3.8 | cash calendar (licence pending; FullCalendar fallback) |
| @cantoo/pdf-lib / @react-pdf/renderer | 2.11.1 / 4.9.0 | compiled evidence PDF, scope snapshot (upstream pdf-lib is unmaintained since 2021) |
| sharp / file-type / unpdf | 0.35.5 / 22.2.0 / 1.9.1 | image re-encoding (EXIF strip), magic-byte sniffing, PDF text layer for citations |
| swr | 2.5.1 | UI polling |
| tsx | 4.23.15 | TS scripts (spikes, setup) |
| typescript-eslint | 8.72.1 | lint (requires TS < 6.1) |
| @axe-core/playwright / @lhci/cli | 4.14.0 / 0.15.1 | a11y and performance checks |
| @fullcalendar/react + core | 7.1.3 | MIT fallback behind `CashCalendar` (plugin majors verified in M0-09) |
| Noto Sans / Noto Sans Devanagari | OFL font assets | EN/HI in PDFs |
| pino | 10.4.0 | JSON logs |
| @sentry/nextjs / @sentry/node | 11.10.0 | error tracking (web / worker) |
| resend | 6.35.0 | email (magic links, alerts) |
| vitest / @playwright/test / msw | 5.0.5 / 1.64.1 / 3.0.3 | unit + integration (fixture replay) + e2e |
| eslint / prettier | 10.13.0 / 3.9.10 | lint, format |
| @eslint/js / @types/node / @types/react / @types/react-dom | 10.0.1 / 24.19.2 / 19.3.0 / 19.3.0 | lint base config; Node 24 and React 19 types (pinned in M0-02) |
| gitleaks | 8.30.1 (local) | secret scan |

## 5. Services and spend

| Service | Plan | Cost | Buy? |
|---|---|---|---|
| Render web | starter, Oregon | $7/mo | yes (free tier spins down) |
| Render worker | starter | $7/mo | yes |
| Render Postgres | starter | $6/mo | yes (free tier expires after 30 days) |
| OpenAI | pay-as-you-go | hard cap $1/day; expected < $5/mo with caching | yes, owner key |
| Resend | free | $0 (domain verification optional) | no purchase |
| Sentry | free | $0 | no purchase |
| Bryntum | trial | $0 (permission pending) | no purchase |
| **Total** | | **≈ $20/mo + LLM (≤ $50/mo ceiling)** through 2026-12-15 | M0-00 makes the full budget |

## 6. Data model

See [docs/architecture.md §5](docs/architecture.md#5-data-model).

## 7. Deliverables mapped to the rubric

| Deliverable | Criterion | Ticket |
|---|---|---|
| Hosted demo + "Try as demo seller" | Stage One, Tech, Presentation | M1-07, M2-10, M3-11 |
| README for judges (problem → vision, how to run, Deploy to Render) | Presentation, Impact | M5-01 |
| Demo video < 3 min | Presentation | M5-02 |
| Devpost text + AI-tools section | Stage One | M5-03 |
| docs/architecture.md + ADRs | Tech | kickoff, kept current |
| Eval report (measured numbers) | Tech, Impact | M4-02 |
| UX: design system and hero-screen specs (`ux-designer`), independent `ui-reviewer` on every frontend ticket | Design | M1-06 onwards |

## 8. Milestone plan

| Milestone | Due (IST) | Gate |
|---|---|---|
| M0 · Recon & Bootstrap | 2026-10-30 | M0-GATE: `python3 scripts/check-prereqs.py`, CI green, fixtures recorded, Render deploy live |
| M1 · Walking Skeleton | 2026-11-01 | M1-GATE: a webhook-driven payment visible on the deployed dashboard from a clean stack |
| M2 · Dispute Loop | 2026-11-05 | M2-GATE: judge scenario end to end (chargeback → evidence → resolved → released) |
| M3 · Holds & Cash | 2026-11-08 | M3-GATE: the full storyboard runs for real on production |
| M4 · Trust & Global | 2026-11-10 | M4-GATE: evals published; HI; a11y/perf budgets; security tests; load test |
| M5 · Submission | 2026-11-12 18:00 | M5-GATE from a clean clone after M5-CLEANUP; then submit |

## 9. What this does not do

- It does not lift account limitations or promise any release; PayPal decides.
- It does not fight or appeal PayPal decisions, and never acts without seller approval.
- It does not automate goods tracking as a feature (PayPal's Package Tracking Solution exists); it files tracking as one approved action.
- No bookkeeping (PayPal Accounting Sync exists), no own fraud model, no agentic checkout, no escrow.
- At launch it can't see payments made outside Cleared's own sandbox app (webhooks are app-scoped; needs Transaction Search or the partner model).
- Sandbox only. The "Simulate PayPal's decision" step is a labelled sandbox control.
- Release dates are *estimates* from cited PayPal rules. New-seller holds, reserves and limitations appear only as badged sample scenarios (sandbox can't produce them).

### 9.1 Data policy

- **Real:** PayPal sandbox services and API responses; PayPal's published rules (cited); real carrier codes.
- **Synthetic:** all personal data (sellers, buyers, chats, briefs, deliverables) in the demo and the gold sets, to respect privacy law (DPDP, GDPR) and IP rules.
- **Upgrade path:** real sellers connect through PayPal's partner model with explicit consent; evidence is retained only as long as the seller keeps it, with delete-on-request.
- **No mocks or "demo mode" in the product path.** Tests replay recorded real responses (fixtures from the M0 spikes).

## 10. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Bryntum trial terms don't allow a public demo | lose the Bryntum prize | ask today; decide by 2026-11-04; FullCalendar fallback behind `CashCalendar` |
| Judge abuse of demo workspaces | demo down for everyone | caps per IP and global; per-workspace LLM budget; AI cache |
| Sandbox quirks (country restrictions, compliance errors, scope delays) | blocked flows | fixtures recorded in M0; US sandbox accounts; documented runbook |
| OpenAI outage or model change | no verdicts | graceful degradation; adapter; pinned model IDs; evals before switching |
| Transaction Search scope never arrives | no back-fill of outside payments | documented limit; Cleared-created payments are polled by ID |
| "PayPal covered the case" outcome read as "seller won" | credibility | exact wording in the video and README |
| Webhook delivery gaps | stale state | reconcile poll every 15 min; re-fetch on every event |
| Render plan or free-tier expiry during judging | demo down | paid starter plans through 2026-12-15; daily synthetic check |
| PayPal platform support (partner approval) | can't onboard real sellers | the production story is documented; `SellerConnection` interface |

## 11. Future vision

See §2. After the hackathon: partner onboarding with PayPal, then marketplace/platform mode, then the cash-flow layer, then a provider-agnostic proof layer.

## 12. Conventions

- **Branches:** `<type>/<scope>-<description>-<DD-MM-YYYY>` (e.g. `feat/disputes-draft-05-11-2026`); one ticket per branch and PR; the PR title starts with the ticket ID.
- **Commits:** Conventional Commits, small and frequent. **No Claude co-author line** (owner convention).
- **Git identity:** `thopatevijay <thopatevijay@gmail.com>` (set locally).
