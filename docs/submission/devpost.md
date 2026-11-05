# Cleared: Devpost submission text

One `##` section per Devpost field, ready to paste at M5-SUBMIT. The `###` sections under "About the project" are its headings on Devpost. Every claim here comes from the [README](../../README.md) and the reports in `docs/evidence/`; `pnpm devpost:check` keeps them identical.

> **Before pasting (owner, M5-SUBMIT):**
> 1. M5-02 replaces the video placeholder below with the YouTube link; then `pnpm devpost:check --final` must pass (it fails on any placeholder).
> 2. Bryntum's written OK for the public demo (P-38) is still pending: confirm it before claiming the Bryntum sponsor prize.
> 3. Make the repository public first: the repo and report links below point at `github.com/thopatevijay/cleared`.
> 4. Upload the eight images in `docs/submission/gallery/` in order, each with the caption listed under "Image gallery".

## Project name

Cleared

## Tagline

Your PayPal money, cleared: proof, holds and disputes

## About the project

### Inspiration

Freelancers and small sellers in India, Kenya, Nigeria and beyond get paid through PayPal by clients they have never met. When PayPal reviews a payment, opens a dispute or asks for documents, the seller's money is held, and the proof PayPal wants is scattered across chats, email, drives and courier slips.

In their words (public reviews and posts, quoted verbatim and dated):

- "My legitimate freelance earnings are now frozen under an unjustified 180-day hold." (Trustpilot, India, 2026-09-29)
- "My funds were locked for 180 days, severely disrupting my livelihood" (Trustpilot, Kenya, 2025-12-29)
- "told me that I needed to provide an invoice or a contract signed by both parties" (Trustpilot, 2026-09-22)
- "Next is a hold on your suspicious transaction, request additional documents for your own money" (Hacker News, 2026-10-12)
- "Don't make users think their account is okay, then limit or hold funds once received." (WeeTracker, Nigeria, 2026-02-24)
- "Merchants often don't realize they're carrying risk exposure until funds are frozen" (Hacker News, 2026-02-23)

Our reading (an inference, not a measurement): most of this pain falls on sellers who don't know PayPal's published release steps and gather proof only after PayPal asks. A dispute the seller doesn't answer by its due date closes in the buyer's favour.

### What it does

Cleared is an AI agent that keeps small cross-border sellers' PayPal money flowing. It works at three moments, each on real PayPal sandbox state.

1. **A payment arrives → a proof pack.** The webhook brings the capture; the seller adds the agreed scope and the delivery evidence (a pasted chat, files, a client acknowledgement link). The AI turns the scope into checkable lines and marks each one *met*, *partly met*, *missing* or *can't verify*. Every verdict cites a quote, and code checks that each quote appears **verbatim** in the stored evidence before it is shown. A quote that fails the check is dropped, and the line becomes *can't verify*.
2. **Money is held → an explanation and the next step.** A hold is a capture with status `PENDING` and PayPal's reason. Cleared explains it in the seller's language (English or Hindi), shows an **estimated** release date with the PayPal rule it comes from, and offers the step PayPal publishes: file tracking for goods, or record a service as Completed.
3. **A dispute arrives → a reply drafted from the pack.** The agent maps the reason code, picks the evidence, writes the notes (≤ 2,000 characters) and compiles one PDF. The seller reviews exactly what PayPal will receive, approves, and Cleared files it through the Disputes API. When PayPal decides, Cleared mirrors the outcome. In the sandbox that reads "resolved; the seller keeps the money (PayPal covered the case)", and the held payment returns to `COMPLETED`.

**The agent does the work; you hold the keys.** The agent can only *propose* an action. Nothing reaches PayPal until the seller approves, and the approval is bound to the sha256 of the exact payload, so a changed draft needs a new approval. Before sending, Cleared re-fetches the dispute, checks that PayPal still offers that action (its HATEOAS links), and refuses within 1 hour of the reply deadline. Accepting a claim needs typed confirmation and is never automatic. Every step lands in an append-only audit log the seller can read, and a kill switch stops all agent actions.

Also in the product: a cash calendar of estimated releases and reply deadlines, carrier route advice for goods sellers, an in-app notification centre and email deadline alerts.

**Try it:** open the hosted demo and press **Try as demo seller**. You get your own isolated workspace (sample data, no PayPal account and no keys). Every PayPal step is a real sandbox call, and every person, chat and file in it is synthetic. Each network (one public IP address) can create 3 demo workspaces in any rolling 24 hours, so please reuse yours; if the cap is reached, the page says when the next one frees up.

### How we built it

A modular monolith on Render: a Next.js web service (UI, REST API, webhook endpoint), a background worker (pg-boss queues on Postgres), and Postgres as the system of record. The webhook verifies the signature, stores the raw event and enqueues its job in one transaction, then acknowledges; the worker re-fetches the resource from PayPal and never trusts event order. Every outbound call goes through one HTTP client with timeouts and retries only on timeouts, 5xx and 429.

Stack: Node 24, TypeScript, Next.js 16 (App Router), Tailwind 4, next-intl (English and Hindi), zod, Drizzle and Postgres, pg-boss, the `openai` SDK, pino, Sentry, Resend, Bryntum Calendar; vitest, Playwright and msw for tests. Hosted on Render (web, worker and Postgres, Oregon).

**PayPal APIs actually used.** All calls go through Cleared's own typed client. Each endpoint below has a recorded sandbox exchange in the repo's `fixtures/paypal/`, which the tests replay.

| API | Endpoints | What Cleared does with it |
|---|---|---|
| OAuth 2.0 | `POST /v1/oauth2/token` | app access token |
| Orders v2 | `POST /v2/checkout/orders`, `GET /v2/checkout/orders/{id}`, `POST /v2/checkout/orders/{id}/capture` | the demo's test payments (each order's `custom_id` is the owning workspace) |
| Payments v2 (captures) | `GET /v2/payments/captures/{id}` | the source of truth for status and hold reason, re-fetched on every webhook |
| Disputes | `GET /v1/customer/disputes`, `GET /v1/customer/disputes/{id}`, `POST /v1/customer/disputes/{id}/provide-evidence`, `POST /v1/customer/disputes/{id}/accept-claim` | mirror disputes; file the approved reply and evidence; accept a claim (typed confirmation) |
| Disputes, sandbox only | `POST /v2/customer-support/process-chargeback`, `POST /v1/customer/disputes/{id}/require-evidence`, `POST /v1/customer/disputes/{id}/adjudicate` | create the demo chargeback; the labelled "Simulate PayPal's decision (sandbox only)" step |
| Order Tracking | `POST /v2/checkout/orders/{id}/track` | file a shipment's carrier and tracking number (approved action) |
| Tracking (legacy) | `POST /v1/shipping/trackers-batch`, `GET /v1/shipping/trackers/{id}` | record a service as Completed (status `COMPLETED`, no carrier, no tracking number: PayPal refuses a carrier without one); read a tracker back |
| Webhooks | `POST /v1/notifications/webhooks`, `GET /v1/notifications/webhooks`, `POST /v1/notifications/verify-webhook-signature` | register the app's webhook; verify each delivery (self-verified against PayPal's certificate, with PayPal's verify call as the fallback) |

Transaction Search is not used, so payments made outside Cleared's own app are not visible.

### AI tools used and how

**In the product: OpenAI**, through the `openai` SDK (Responses API, strict JSON-schema outputs re-validated with zod) behind an adapter. The model IDs are pinned: `gpt-6-luna` (small) and `gpt-6.1-terra` (large). There is no open agent loop: four fixed workflows.

| Workflow | Model | What it does |
|---|---|---|
| `extract` | `gpt-6-luna` | structured facts (amounts, dates, people, deliverables) from pasted text, images and PDFs |
| `check_scope` | `gpt-6.1-terra` | two passes: pass 1 turns the scope into claim lines, pass 2 matches each line to quoted spans in the evidence. Then code checks every quote verbatim; an uncited *met* or *partly met* line becomes *can't verify* |
| `explain_hold` | `gpt-6-luna` | a plain-language explanation of a hold in English or Hindi, grounded in a maintained table of PayPal's published rules, each with its source |
| `draft_dispute` | `gpt-6.1-terra` | the dispute reply: reason-code mapping, evidence selection, notes ≤ 2,000 characters |

**Guardrails:** evidence and tool output are data, never instructions (evidence goes in delimited blocks, an injection scan flags instruction-like lines, and model output is rendered as plain text); at most 6 model calls per run, with token and time caps; spend caps of $0.10 per demo workspace and $1 per day overall; an AI cache keyed on the input hash; and graceful degradation (no verdict, never a made-up one) when the model is unavailable. Prompt, model or schema changes merge only with the evals green.

**Evals:** measured on the `test` split of synthetic gold sets, labelled by Claude (independent of the OpenAI models under test) and cross-checked by a second model; explanations are judged by `gpt-6.1-terra` for "fact conveyed" only. The results are under "Accomplishments", misses included.

**To build it: Claude Code** (Anthropic) wrote most of the code, tests and documentation under the author's direction and review, and Claude labelled the synthetic gold sets that the OpenAI models are evaluated against (cross-checked by a second model). Claude is not part of the running product.

### Challenges we ran into

- **Webhooks are scoped to the app.** Only payments made through Cleared's own app arrive, and Transaction Search is not used, so the demo creates its own sandbox payments through Orders v2 rather than reading a seller's history.
- **No demo can wait for PayPal's own team to decide a case.** The sandbox has an `adjudicate` call for testing; Cleared exposes it as one clearly labelled "Simulate PayPal's decision (sandbox only)" control. It unlocks only after PayPal has processed the filed evidence (about 4 minutes in our production run), and RESOLVED arrived about 6 minutes after the decision.
- **Holds the sandbox can't produce.** New-seller holds, reserves and account limitations can't be created in the sandbox, so they appear only as badged sample scenarios.
- **Recording a service as Completed.** `trackers-batch` refuses a carrier without a tracking number, so Cleared sends status `COMPLETED` with neither, and says on screen that its effect on a release is not confirmed.
- **Hold explanations missed their eval target** in three runs. We report the miss instead of moving the threshold, the judge or the gold labels.
- **A saturated production database.** Production Postgres (0.1 CPU) sat at about 95–100 % CPU, idle or not; cutting the idle stack's queries brought it to about 12–22 %. Launch-load latency barely moved (p95 949.4 ms before, 912.3 ms after, still over the 800 ms target), so the database CPU was not the main cause of the tail ([load report](https://github.com/thopatevijay/cleared/blob/main/docs/evidence/load-report.md)).

### Accomplishments that we're proud of

- **A complete dispute lifecycle on real PayPal sandbox state.** The final production run on 2026-11-04 filed tracking on a review hold, filed a dispute reply, recorded a service as Completed through `trackers-batch` (PayPal answered 200), and took the labelled sandbox decision through to `RESOLVED` and a released hold. The whole judge path took about 15 minutes in our production dry run.
- **Measured AI quality, with *n*** ([eval report](https://github.com/thopatevijay/cleared/blob/main/docs/evidence/eval-report.md)): scope check 95.2% (118/124 line verdicts, 31 packs; macro-F1 0.945); citations verbatim 100.0% (349/349); fact extraction 95.8% (115/120 fields, 22 items); adversarial cases 100.0% (22/22). Hold explanations reached 62.5% (10/16) against a 95% target: a disclosed **MISS** (facts conveyed 58/64; right rule 16/16; right language 16/16). Disclosures: the eval judge was revised to `eval_judge@v2` after run 1's test-split results had been seen, and the holds prompt `explain_hold@v2` was tuned on the dev split only.
- **Cheap enough to run on every payment:** checking one proof pack against its scope costs $0.0070 in model spend ([eval report](https://github.com/thopatevijay/cleared/blob/main/docs/evidence/eval-report.md)).
- **Accessible (WCAG 2.2 AA)** ([report](https://github.com/thopatevijay/cleared/blob/main/docs/evidence/a11y-report.md)): axe reports no violation of any impact on every route × EN/HI × populated/empty/loading/error state; the judge path works keyboard-only at 1280 and 375 px; pages reflow without horizontal scroll at 320 px and at 200 % zoom; the VoiceOver pass (macOS and iOS Safari) passed.
- **Fast where it counts** ([perf report](https://github.com/thopatevijay/cleared/blob/main/docs/evidence/perf-report.md)): the dashboard's first-load JavaScript is 185.0 KB gzip, within its 200 KB budget; Lighthouse (mobile simulation, report-only) puts 6 of 8 audited routes within LCP ≤ 3.2 s / TBT ≤ 200 ms.
- **A webhook path that holds under load** ([load report](https://github.com/thopatevijay/cleared/blob/main/docs/evidence/load-report.md)): a 100× burst on a local production build, 2,100 events, ack p95 15.7 ms, 0 duplicates, 0 dead letters, queue drained in 35 s; production webhook ack p95 1 ms server-side.

### What we learned

- **Make the AI checkable, then check it.** Strict JSON schemas plus a verbatim quote check turned "the model says it was delivered" into a verdict a seller, and PayPal, can verify, and a small model was enough for most of the work.
- **Mirror PayPal; never invent a state.** Re-fetching every resource on each webhook, instead of trusting event order, kept Cleared's view equal to PayPal's through retries and redeliveries.
- **Words matter in money.** A sandbox dispute that PayPal covers is "resolved; the seller keeps the money (PayPal covered the case)", not a decision in the seller's favour, and a release date is an estimate with a source, never a promise.
- **Publish the misses.** Reporting the hold-explanation miss and the production latency miss next to the passes made the numbers we do claim credible.

### What's next for Cleared

- **v2: platform mode.** Through PayPal's partner model, marketplaces and freelance platforms run Cleared for all their sellers, with each seller's consent.
- **v3: the cash-flow layer.** True take-home after FX and fees, and when held money will really be available, using PayPal's currency exchange APIs.
- **v4: proof travels with every payment.** A proof pack readable by PayPal, by buyers and by buyers' AI agents, so a dispute starts from evidence rather than from a request for it.

### Limits, stated plainly

Cleared runs on the PayPal **sandbox only**: nothing touches live PayPal money, and the "Simulate PayPal's decision (sandbox only)" step stands in for PayPal's own review, labelled as such everywhere it appears. A sandbox dispute that PayPal covers reads "resolved; the seller keeps the money (PayPal covered the case)", which is not the same as a decision in the seller's favour. Only payments made through Cleared's app arrive (webhooks are app-scoped and Transaction Search is not used). Release dates are estimates from PayPal's published rules, each with its source; Cleared doesn't lift limitations, release money or promise a release date. **Visual citation is not built:** quotes are checked in text (pasted chat, PDF text layers), and support that exists only in a screenshot or photo is marked *can't verify* (`unverifiable`). New-seller holds, reserves and account limitations appear only as badged sample scenarios. Measured misses are reported, not hidden: hold explanations below their target; one Lighthouse LCP miss (`/hi/payments` 3.77 s) and one TBT miss (`/en/calendar` 252 ms); and production latency under launch load, where 20 concurrent sessions on Render's Starter plan gave an overall p95 of 912.3 ms against a target of 800 ms: **not met**. That is after the idle database load fix (the run before it measured 949.4 ms); 9 of 13 routes are still over 800 ms, and 0 requests failed ([load report](https://github.com/thopatevijay/cleared/blob/main/docs/evidence/load-report.md)).

## Built with

nextjs, react, typescript, node.js, tailwindcss, next-intl, zod, drizzle, postgresql, pg-boss, openai, paypal, paypal-orders, paypal-disputes, paypal-tracking, paypal-webhooks, bryntum, render, sentry, resend, pino, vitest, playwright, msw, pnpm

## Try it out

- Hosted demo: https://cleared-web-gd1b.onrender.com (press **Try as demo seller**; no PayPal account and no keys needed)
- Source code (MIT): https://github.com/thopatevijay/cleared

## Video demo link

https://youtu.be/H-v2TrXUdso

## Image gallery

Upload in this order; each line is the image's caption. Images 3, 5 and 6 are from the production run on the PayPal sandbox (2026-11-03); images 1, 2 and 4 are from a local build with seeded synthetic data, showing the same screens as the hosted demo. Every person and file is synthetic.

1. `01-dashboard.png`: Your PayPal money at a glance: what is held, what is in dispute and which payments are proof-ready, each a real PayPal sandbox capture.
2. `02-proof-pack.png`: The proof pack checks delivery against the agreed scope; every verdict cites a quote that code has checked appears verbatim in the evidence.
3. `03-hold-explained-hindi.png`: A PENDING_REVIEW hold explained in Hindi, with PayPal's published rule and an estimated release date with its source.
4. `04-dispute-approval.png`: The agent drafts the dispute reply from the proof pack; the seller sees exactly what PayPal will receive, and nothing is filed until they approve.
5. `05-sandbox-decision.jpg`: After the labelled "Simulate PayPal's decision (sandbox only)" step: resolved; the seller keeps the money (PayPal covered the case), and the hold is released.
6. `06-cash-calendar.png`: The cash calendar (Bryntum Calendar): estimated releases and reply deadlines, with an accessible list below it.
7. `07-architecture.png`: Architecture: Next.js web, a pg-boss worker and Postgres on Render; approved actions go to the PayPal sandbox, AI workflows to OpenAI.
8. `08-eval-results.png`: Eval results with n, on synthetic gold sets labelled by Claude and cross-checked by a second model; the hold-explanation miss is shown, not hidden.

## Sponsor prizes

- **Bryntum:** the cash calendar is built with Bryntum Calendar 7.3.8 (the trial build from public npm, watermark kept) behind a `CashCalendar` wrapper, with an accessible list of upcoming releases for screen readers and the no-JavaScript path. It shows estimated releases and dispute reply deadlines, in English and Hindi.
- **Render:** the hosted demo runs on Render from a `render.yaml` Blueprint: a web service, a background worker and Postgres 18, in Oregon, on starter plans. Every deploy runs the database migrations first, and the repository has a Deploy to Render button.
