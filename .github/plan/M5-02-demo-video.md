---
title: "M5-02 · Demo video (≤3 min; owner voice-over)"
milestone: "M5 · Submission"
labels: ["docs", "owner"]
blocked_by: ["M5-01"]
estimate: "6h"
resources: ["PAYPAL_SANDBOX", "DEPLOY"]
needs: []
---

## Context

The video is a required artefact (YouTube, **under 3 min**, showing the product working, with no unlicensed music or trademarks; PROJECT.md §1). It is the strongest lever on Presentation: the storyboard shows **real PayPal sandbox state changes** on camera (held → resolved → released). This ticket claims PAYPAL_SANDBOX because recording runs live sandbox flows on production. It also claims DEPLOY because no deploy may land mid-recording. The owner records the voice-over.

## Scope

- **Script and shot list** `docs/video/script.md`, following the PROJECT.md §2 storyboard:

  | Time | Scene |
  |---|---|
  | 0:00–0:20 | Pain: three seller quotes |
  | 0:20–0:45 | Bengaluru designer, evidence, AI scope check with sources |
  | 0:45–1:05 | Real sandbox payment under review explained **in Hindi**, estimated release date with source; route advice |
  | 1:05–1:50 | A pre-staged chargeback → held → the agent drafts → she approves → filed. The **labelled "Simulate PayPal's decision (sandbox only)"** control is visible. "Resolved: she keeps the $120 (PayPal covered the case)" → released |
  | 1:50–2:15 | Cash calendar; audit log ("The agent does the work; you hold the keys") |
  | 2:15–2:40 | Architecture slide; the measured eval numbers with *n*, taken from `docs/evidence/eval-report.md` |
  | 2:40–2:58 | "Every payment will carry its proof." |

- **Staging (live, production):** create the review-hold payment ≥ 24 h ahead from the M3-10 pool, and the chargeback about 20 min ahead. Record the PayPal IDs used in `docs/video/staging.md`, as sandbox IDs only, with no secrets
- **Capture:**
  - screen recording of production at 1920×1080, in a clean browser profile (no bookmarks, extensions or other brands visible)
  - synthetic personas only
  - the PayPal sandbox state shown from Cleared and from the sandbox's own pages where useful
- **Voice-over:** recorded by the owner (`owner`), matching the script; English with EN captions; a Hindi line on the Hindi scene is optional
- **Edit:** `ffmpeg` (no paid tools). No music, or a track with its licence recorded in `docs/video/credits.md` (e.g. YouTube Audio Library, with its licence terms quoted). No third-party logos. PayPal is named only as the platform used
- **Captions:** an `.srt` file (EN) uploaded with the video
- **Upload (owner):** YouTube **Public**, with a title and description (hosted URL, repo URL, "PayPal sandbox; the decision step is labelled"). The owner adds the link to the README video marker and to `docs/video/script.md`
- **Claims check:** every on-screen number matches the reports; the outcome wording is exact; no "seller won"

## Out of scope

- The README body (M5-01) and the Devpost text (M5-03)
- New product features or fixes discovered while recording: these reopen the owning ticket (scope is not cut; the video waits)

## Acceptance Criteria

- [ ] `ffprobe` on the final render shows a duration < 180.0 s
- [ ] The rendered video shows a held payment flipping to resolved and then released, with real sandbox IDs. These IDs exist in production's `audit_log` (`pnpm audit:find --paypal-id <id>` lists them)
- [ ] The frame at the decision step shows the "Simulate PayPal's decision (sandbox only)" label (a screenshot is attached to the issue)
- [ ] `docs/video/credits.md` lists every audio and image asset with its licence, or states "no music"
- [ ] `curl -s "https://www.youtube.com/oembed?url=<video URL>&format=json"` returns 200, and the owner confirms visibility = Public on the issue
- [ ] The README video marker is replaced with the YouTube link, and `pnpm readme:check` still passes
- [ ] The caption file is uploaded (the owner confirms on the issue)

## Deliverables

- `docs/video/{script,staging,credits}.md`, `docs/video/captions.en.srt`
- The final render kept outside the repo (`*.mp4` is gitignored); the YouTube URL in `README.md`

## Validation Gate

```bash
set -euo pipefail
: "${VIDEO_FILE:?path to the final render}" "${VIDEO_URL:?YouTube URL}"
d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO_FILE"); echo "duration $d"
awk -v d="$d" 'BEGIN{exit !(d<180.0)}'
curl -sf "https://www.youtube.com/oembed?url=${VIDEO_URL}&format=json" -o "$TMPDIR/oembed.json" && jq -r .title "$TMPDIR/oembed.json"
grep -q "$VIDEO_URL" README.md
pnpm readme:check
test -s docs/video/credits.md && test -s docs/video/captions.en.srt
! grep -ri 'seller won' docs/video/
```

## Handoff

- **M5-03** embeds the YouTube URL and reuses frames as Devpost gallery images
- **M5-CLEANUP** keeps `docs/video/` tracked (public, cited by the README)
- **M5-SUBMIT** pastes the URL into Devpost's video field
