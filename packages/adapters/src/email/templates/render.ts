// The locale switch for the magic-link email.
import type { Locale } from "@cleared/core";
import type { MagicLinkParams, RenderedEmail } from "./html.ts";
import { magicLinkEn } from "./magic-link.en.ts";
import { magicLinkHi } from "./magic-link.hi.ts";

export type { MagicLinkParams, RenderedEmail } from "./html.ts";

export function magicLinkEmail(locale: Locale, params: MagicLinkParams): RenderedEmail {
  return locale === "hi" ? magicLinkHi(params) : magicLinkEn(params);
}
