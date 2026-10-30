# UI review checklist (`ui-reviewer`)

Use this list on every `frontend` ticket, against the screenshots in `.review/<TICKET>/` and the running build. The builder never self-approves. Output: one line per item (`PASS` / `FAIL` + evidence), then `VERDICT: PASS` or `VERDICT: FAIL`. Any **blocking** failure means FAIL.

## Inputs the ticket must provide
- [ ] Screenshots at **375, 768 and 1440 px**, in **light and dark**, in **EN and HI**, for every state the screen spec lists (loading, empty, error, partial, success, and others such as waiting or offline)
- [ ] axe JSON (`@axe-core/playwright`, tags `wcag2a wcag2aa wcag21aa wcag22aa`) for each page and state
- [ ] The screen spec it was built to (`docs/design/screens/<screen>.md`)

## Blocking
1. **axe:** zero `serious` or `critical` violations in any state, locale or theme. `moderate` findings are listed and must have an owner.
2. **375 px clip check:** at 375 px (and 360 px) in EN and HI, there is no horizontal scroll (`scrollWidth ≤ clientWidth`). No amount, status label, "estimated" word, hash or button label is clipped or ellipsised. Devanagari matras aren't cut at line tops or bottoms. Check with a screenshot and with `getBoundingClientRect` on each badge and money cell.
3. **Forbidden copy:** the forbidden-copy grep in the M1-06 Validation Gate (and the ticket's own grep over `apps`) finds nothing. Visually confirm every dispute outcome reads "Resolved; you keep the money (PayPal covered the case)" or its HI string, and that no outcome claims victory.
4. **Estimated dates:** every release date shows "estimated" / "अनुमानित" and a working Source disclosure (quote + link + retrieval date). No date appears without a rule.
5. **Sandbox labels:** every sandbox-only control shows the Sandbox badge and dashed boundary, and the decision control reads exactly "Simulate PayPal's decision (sandbox only)". With `PAYPAL_ENV` ≠ `sandbox`, those controls are absent.
6. **Status never colour alone:** every status shows its icon + label from [components.md](components.md#status-badge-statusbadge). Check with a greyscale screenshot: every status must still be distinguishable.
7. **Approval card:** it shows exactly what goes to PayPal (every payload field), the draft fingerprint (`payload_sha256` short form) and the deadline. Approve needs an explicit confirm. Nothing reaches PayPal without it.
8. **Error panels** show the correlation ID (and `debug_id` for PayPal errors).
9. **Keyboard:** the screen's "Keyboard path" (in its spec) can be completed with the keyboard only, the focus ring is visible on every stop (2 px `focus`, offset 2 px), focus is never obscured, and focus order matches the visual order.
10. **Target size:** every interactive target at 375 px is ≥ 44 × 44 px (measured on the hit area).
11. **Tokens:** `node scripts/design-tokens.mjs --check` passes. There are no raw hex values or ad-hoc colours in components (`grep -rnE "#[0-9a-fA-F]{3,6}\b" apps/web/src --include=*.tsx`, except comments).
12. **Model output** renders as plain text: a fixture containing `<img src=x onerror=alert(1)>` renders literally.

## Must check (FAIL if wrong, fixable in the same PR)
- **Dark mode:** follows `prefers-color-scheme` and `data-theme`; no hard-coded light colours; shadows come from the dark token set; images and PDFs have no white flash.
- **HI rendering:** `/hi` loads Noto Sans Devanagari (no tofu or fallback boxes); `<html lang="hi">`; line heights use `lineHeightHi`; there are no missing-key warnings; PayPal enums, IDs and amounts stay in Latin; digits stay Latin; no string is concatenated (ICU messages with placeholders).
- **Numbers:** amounts via `Intl.NumberFormat` with the ISO code; original and receivable side by side when they differ; no cross-currency sums; times in the workspace tz.
- **States:** every state in the screen spec is implemented and screenshotted. Spinners say what they're waiting for. Disabled controls say why.
- **Live:** polled changes update in place, flash, and are announced politely once. `role="alert"` is not repeated on every poll.
- **Reduced motion:** with `prefers-reduced-motion: reduce`, nothing animates.
- **Copy** matches the spec's EN and HI strings, or the deviation is justified in the PR. Sentence case, no ALL CAPS labels, no arrows appended to link text, no emoji.
- **Headings:** one `<h1>` per page and no skipped levels. Landmarks: `header`, `nav`, `main`, `footer`.
- **Status mapping** matches PayPal: the enum shown beside the badge equals the mirrored field. No invented states.

## Report format
```
M1-07 ui-reviewer
1 axe ............ PASS (0 serious/critical; 2 moderate: region, listed)
2 375 clip ....... FAIL dashboard-hi-375-dark.png: "अनुमानित" clipped in row 2
...
VERDICT: FAIL
```
