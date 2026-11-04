# M5-02 · Demo video: script and shot list

**Video:** _YouTube link added by the owner after upload (P-55)_ · **Length target:** 2:58 (hard limit < 3:00)
· **Capture:** production, 1920×1080, clean browser profile · **Voice-over:** the owner, English (one optional
Hindi line in scene 3) · **Captions:** `captions.en.srt` · **Credits:** [credits.md](credits.md) · **Staging
ids:** [staging.md](staging.md)

The storyboard is PROJECT.md §2. Every on-screen number below is copied from the README or `docs/evidence/*`
(the README's numbers are checked by `pnpm readme:check`); the source is named next to each one. Any number
not in this file stays off screen.

## Claims rules for the whole video

- **Outcome wording, exactly.** The UI shows "Resolved; you keep the money (PayPal covered the case)". The
  voice-over and the lower third say "Resolved: she keeps the $120 (PayPal covered the case)". Never "won".
- **The decision control is labelled** "Simulate PayPal's decision (sandbox only)", and its label is in frame
  when it is pressed (AC 3: grab that frame as a screenshot for #54).
- **Release dates are estimates.** Say "estimated", and show the rule source next to the date.
- **Evals:** the gold sets were labelled by Claude and cross-checked by a second model. Never "human-labelled"
  or "owner-labelled". Hold explanations are shown as a **miss**.
- **Load:** the production launch p95 (912.3 ms against an 800 ms target) is **not met**. It is not shown as a
  pass; the video leaves load numbers out.
- **Not built:** visual citation (quotes are checked in text only). Don't imply screenshots are read.
- **Time cuts are disclosed:** each cut over a real wait carries a small lower third "Time cut: ~N min (real
  sandbox wait)".
- Synthetic personas only; sandbox ids only; no third-party logos; PayPal named only as the platform.

## Shot list

Voice-over (VO) is paced at about 2.5 words per second. Word counts are budgets, not targets.

### Scene 1 · 0:00–0:20 · Pain (20 s, VO ≤ 48 words)

| Shot | On screen | Source |
|---|---|---|
| 1a | Black card, three quotes fade in one at a time, white text, credited as text (no logos): "My legitimate freelance earnings are now frozen under an unjustified 180-day hold." (Trustpilot, India, 2026-09-29) · "told me that I needed to provide an invoice or a contract signed by both parties" (Trustpilot, 2026-09-22) · "Merchants often don't realize they're carrying risk exposure until funds are frozen" (Hacker News, 2026-02-23) | README, Problem |

**VO:** "Small cross-border sellers get paid through PayPal by clients they've never met. When PayPal holds a
payment or a buyer disputes it, the money freezes, and the proof PayPal wants is scattered across chats, email
and drives. Cleared is an AI agent that keeps that money moving."

### Scene 2 · 0:20–0:45 · The designer, her evidence, the AI scope check (25 s, VO ≤ 60 words)

| Shot | On screen | Source |
|---|---|---|
| 2a | Landing → "Try as demo seller" (Sandbox badge visible) → dashboard | production |
| 2b | The $120.00 USD payment from Northwind Tea Co. arrives (sandbox card payment, Orders v2) | staging.md scene 4 ids |
| 2c | Paste the scope chat, attach the delivery PDF and the client acknowledgement. **Cut** over the ~30–45 s AI check (lower third "Time cut: ~40 s") | M3-11 timings |
| 2d | Proof pack: "1 met, 1 partly met, 1 missing"; zoom on the first line, "Met", with its two verbatim quotes | README proof-pack screenshot |

**VO:** "Meet Meera, a logo designer in Bengaluru. A client pays her one hundred and twenty dollars. She pastes
the chat where they agreed the scope and adds her delivery files. The AI checks each scope line against her
evidence, and every verdict quotes the evidence word for word. Code checks each quote; one that isn't there is
dropped."

### Scene 3 · 0:45–1:05 · A real review hold, in Hindi; route advice (20 s, VO ≤ 48 words)

| Shot | On screen | Source |
|---|---|---|
| 3a | Dashboard: the $64.00 USD payment, held, `PENDING / PENDING_REVIEW` (the pool capture from staging.md, assigned to the recording workspace) | staging.md §1 |
| 3b | Switch to हिन्दी. Hold detail: "रोका गया (hold): $64.00 USD", the "AI व्याख्या" badge, the Hindi explanation, the **estimated** release date and its rule source (`payment_review`: "PayPal reviews the transaction for up to 24 hours") | README, runbook |
| 3c | Back to English: route advice for goods, "File tracking" → approve → filed | M3-11 scene 2b |

**VO:** "This is a real sandbox payment under PayPal review. Cleared explains it in Meera's language. Here, in
Hindi. It shows an estimated release date, and the PayPal rule it comes from. Then the next step PayPal
publishes: for goods, file tracking, which she approves."
*(Optional Hindi line by the owner over 3b; caption it in English.)*

### Scene 4 · 1:05–1:50 · Chargeback → held → draft → approve → filed → decision → released (45 s, VO ≤ 108 words)

Stage the chargeback ~20 min before recording (staging.md §2). Real waits: dispute ~3 min, draft ~1 min,
decision control unlocks ~4 min after filing, resolution ~6 min after the decision (M3-11).

| Shot | On screen | Source |
|---|---|---|
| 4a | The bell: a dispute on the $120.00 payment; the payment now `PENDING / BUYER_COMPLAINT` (held) | staging.md §2 |
| 4b | Dispute review: PayPal facts (status, reason, the actions PayPal currently allows), the drafted notes and the one compiled PDF: "Nothing goes to PayPal until you approve." | README dispute screenshot |
| 4c | The owner presses **Approve** on camera → "filed" (lower third: the evidence `debug_id` from staging.md) | staging.md §2 |
| 4d | Lower third "Time cut: ~4 min (PayPal processes the evidence)". The control **"Simulate PayPal's decision (sandbox only)"** fully in frame, then pressed. **Grab this frame for AC 3.** | UI string `decide` |
| 4e | Lower third "Time cut: ~6 min". Dispute `RESOLVED`; the UI line "Resolved; you keep the money (PayPal covered the case)"; the $120.00 payment back to `COMPLETED` (released). Lower third: "Resolved: she keeps the $120 (PayPal covered the case)" | UI string `payout` |
| 4f | (Optional, 3 s) the same dispute on the sandbox's own pages | PayPal sandbox |

**VO:** "Weeks later the buyer files a chargeback. PayPal holds the hundred and twenty dollars and opens a case.
The agent has already drafted the reply from Meera's proof pack: notes, and one PDF of her evidence. She sees
exactly what PayPal will receive. Nothing is sent until she approves. She approves, and Cleared files it
through PayPal's Disputes API. In real life PayPal's team decides. In the sandbox, this clearly labelled
button simulates that decision. Resolved: she keeps the $120. PayPal covered the case, and the held money is
released."

### Scene 5 · 1:50–2:15 · Cash calendar and audit log (25 s, VO ≤ 60 words)

Show the calendar while the dispute is still open, or use the event list (M3-11 delta). Crop or mask the
Bryntum trial watermark while P-38 is open (credits.md).

| Shot | On screen | Source |
|---|---|---|
| 5a | Cash calendar: held money and its estimated release | production |
| 5b | Audit log: "Every action on your workspace … Nothing here can be edited or deleted"; "Agent · Proposed reply with evidence" next to the seller's approval and its payload fingerprint | README audit screenshot |
| 5c | Title text: "The agent does the work; you hold the keys." | README |

**VO:** "The cash calendar shows what's held and when it's estimated to free up. And every step lands in an
audit log she can read and nobody can edit. The agent only proposes. Her approval is bound to the exact
payload, and a kill switch stops the agent. The agent does the work; you hold the keys."

### Scene 6 · 2:15–2:40 · Architecture and measured evals (25 s, VO ≤ 60 words)

| Shot | On screen | Source |
|---|---|---|
| 6a | Architecture slide (from the README diagram): Next.js web + webhook, pg-boss worker, Postgres on Render; PayPal sandbox (Orders, Captures, Disputes, Tracking, Webhooks); OpenAI behind an adapter, evidence = untrusted data | README, Architecture |
| 6b | Eval card, title "Measured on the synthetic test split · labelled by Claude, cross-checked by a second model": Scope check 95.2% (118/124 lines, 31 packs) · Citations verbatim 100.0% (349/349) · Fact extraction 95.8% (115/120 fields, 22 items) · Adversarial cases 100.0% (22/22) · **Hold explanations 62.5% (10/16), target 95%: MISS** | `docs/evidence/eval-report.md` (README eval block) |
| 6c | Small line: "$0.0070 model spend to check one proof pack" | README, Why now (eval report) |

**VO:** "Under the hood: a Next.js app and a background worker on Render, with Postgres. Every webhook is
verified and every payment re-fetched from PayPal. On our synthetic test sets, the scope check is right
ninety-five percent of the time, and every citation is verbatim. Hold explanations miss our bar, and we say
so."

### Scene 7 · 2:40–2:58 · Close (18 s, VO ≤ 40 words)

| Shot | On screen | Source |
|---|---|---|
| 7a | Dashboard, all clear; then the end card: "Every payment will carry its proof." · `cleared-web-gd1b.onrender.com` · the repo URL · "PayPal sandbox; the decision step is labelled" | README |

**VO:** "Cleared builds the proof as the payment arrives, so when PayPal asks, the answer is ready. Every payment
will carry its proof."

## Timing budget

| Scene | Window | Length |
|---|---|---|
| 1 Pain | 0:00–0:20 | 20 s |
| 2 Designer + scope check | 0:20–0:45 | 25 s |
| 3 Hold in Hindi + route advice | 0:45–1:05 | 20 s |
| 4 Chargeback → released | 1:05–1:50 | 45 s |
| 5 Calendar + audit log | 1:50–2:15 | 25 s |
| 6 Architecture + evals | 2:15–2:40 | 25 s |
| 7 Close | 2:40–2:58 | 18 s |
| **Total** | | **2:58** |

If the render runs long, trim scene 3c (route advice) first, then 4f.

## Captions plan (`captions.en.srt`)

Made **after** the owner's voice-over, so the cue times match the real audio:

1. The owner records the VO to this script (P-55); the next session places it on the edit.
2. Cue boundaries: `ffmpeg -i vo.wav -af silencedetect=noise=-35dB:d=0.35 -f null -` gives the pauses; each
   cue is one VO sentence (split longer ones), text copied from the VO lines above as actually spoken.
3. Style: ≤ 42 characters per line, ≤ 2 lines, 1–6 s per cue, no cue overlaps a scene cut by more than 0.5 s.
4. The optional Hindi line gets an English caption marked `[in Hindi]`.
5. Check: the `.srt` parses (`ffmpeg -i captions.en.srt -f srt -` exits 0), the last cue ends before the
   render's duration, and the ticket's overclaim grep over `docs/video/` prints nothing.
6. The owner uploads it with the video on YouTube (AC 7).

## Recording checklist (next session)

- [ ] `pool.ts status`: the video row is `held`, `PENDING / PENDING_REVIEW`, assigned to the recording workspace
- [ ] Chargeback staged ~20 min ahead; ids in staging.md §2
- [ ] No deploy in flight (DEPLOY claimed); `/readyz` all true
- [ ] Clean Chrome profile, 1920×1080, no bookmarks bar, no extensions, notifications off
- [ ] Every id on camera passes `pnpm audit:find --paypal-id <id>` on production
- [ ] The AC 3 frame grabbed and attached to #54
- [ ] `ffprobe` duration < 180.0 s
