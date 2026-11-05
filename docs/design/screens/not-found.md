# Screen: not found (404)

Routes: any unknown path under `/en` or `/hi` renders this page in that locale. A path with no locale prefix (for example `/foo`) renders the **root fallback** in EN. Both respond with HTTP **404**. The page holds no workspace data and never reveals whether a resource exists.

## Purpose
- For **anyone with a broken or mistyped link** (a seller from an old email, a judge from a pasted URL): say plainly that the page doesn't exist and give one way back.
- It is a dead end with one door, so it stays short.

## Layout
It uses the same public-page shell as the landing and `/signin/expired` pages. There is no session, and no site navigation.

1. `header`: the wordmark "Cleared" (text, Atkinson 700, not a link, so there is only one way home) and `LanguageSwitch`.
2. `main`, in order:
   - the `compass` icon (lucide, 32 px outline, `text-muted`, `aria-hidden`)
   - `<h1>` `notFound.title`
   - one paragraph, `notFound.body`
   - a **primary** button-styled link, `notFound.home`, to `/{locale}` (the landing page). The root fallback links to `/en`.
3. `footer`: the landing footer, `footer` ("Sandbox only. Cleared is not affiliated with PayPal.").

**375 px (and 360 px):** a single column with 16 px side padding, left-aligned. The icon, h1, body and link sit in the top half of the screen, with no vertical centring (centring pushes the action below the fold on short phones). The h1 is at the `2xl` step and may wrap to 2 lines (3 in HI). The link is full width and 48 px high. No horizontal scroll, and nothing is clipped in HI at 360 px.

**768 px:** the same column, max 640 px, centred block with left-aligned text. The link is auto width (min 44 px high).

**1440 px:** unchanged from 768 (640 px column, line length under 75 characters). No illustration.

## Tokens (light and dark use the same names)
| Element | Token |
|---|---|
| Page | `bg` |
| Icon | `text-muted` |
| h1 | `text`, type `2xl` (HI `lineHeightHi`) |
| Body | `text`, type `base` |
| Primary link | `accent` background, `on-accent` label, `radius-md` |
| Footer | `text-muted` on `bg`, type `sm` |
| Focus ring | `focus` (2 px, offset 2 px) |

Contrast pairs used (all in `tokens.json`, checked by `--check`): `text`/`bg`, `text-muted`/`bg`, `on-accent`/`accent`, `focus` on `bg`.

## Components
Header shell (wordmark + `LanguageSwitch`), primary button style on an `<a>`, footer. It reuses the **not found** variant of `ErrorPanel` (components.md) in tone only: no Retry (there is nothing to retry), no correlation ID, and no `role="alert"`, because the whole page is the message and its h1 announces it.

## States
| State | Trigger | What shows |
|---|---|---|
| Not found | Any unknown path, or a route calling `notFound()` with no resource-specific state of its own | As in Layout |

There is only this state. It is server-rendered, with no loading, empty, partial or error variant. Screens that already define their own not-found state (for example the hold page's `notFoundTitle`) keep it.

## Interactions
- `LanguageSwitch` points to the same path under the other locale, which renders this page in that language. In the root fallback it points to `/en` and `/hi`.
- Keyboard path: skip link "Skip to main content" → language switch (EN, हिं) → `notFound.home` → footer links. Focus is not moved programmatically on load.

## Copy
| Key | EN | HI |
|---|---|---|
| notFound.metaTitle | Page not found · Cleared | पेज नहीं मिला · Cleared |
| notFound.title | This page doesn't exist | यह पेज मौजूद नहीं है |
| notFound.body | The address may be mistyped, or the page may have moved. Nothing in your workspace has changed. | पता गलत लिखा हो सकता है, या पेज कहीं और चला गया हो। आपके वर्कस्पेस में कुछ नहीं बदला है। |
| notFound.home | Go to the Cleared home page | Cleared के होम पेज पर जाएँ |

The copy never apologises and never blames the reader (README "Voice and tone").

## Accessibility
- `<html lang>` is `en` or `hi` from the URL locale; the root fallback sets `lang="en"`. `<title>` is `notFound.metaTitle`.
- Landmarks `header`, `main`, `footer`. One `<h1>`, and no other headings. Heading order: h1 only.
- The home link is an `<a>` (it navigates), styled as the primary button: 48 px high at 375/360 px, 44 px minimum elsewhere, with the visible `focus` ring.
- The icon is decorative (`aria-hidden`); the h1 carries the meaning.
- Reflows without horizontal scroll at 320 px and at 200 % zoom.
