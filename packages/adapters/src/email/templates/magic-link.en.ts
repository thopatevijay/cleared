// Magic-link email, English (M1-05). Plain text first; the HTML carries the same words.
import { escapeHtml, type MagicLinkParams, type RenderedEmail } from "./html.ts";

export function magicLinkEn(p: MagicLinkParams): RenderedEmail {
  const minutes = String(p.minutes);
  const subject = "Your Cleared sign-in link";
  const lead = `Use this link to sign in to Cleared. It works once and expires in ${minutes} minutes.`;
  const ignore = "If you did not ask for this, ignore this email. Nobody can sign in without the link.";
  return {
    subject,
    text: `${lead}\n\n${p.url}\n\n${ignore}\n`,
    html:
      `<p>${escapeHtml(lead)}</p>` +
      `<p><a href="${escapeHtml(p.url)}">Sign in to Cleared</a></p>` +
      `<p>${escapeHtml(ignore)}</p>`,
  };
}
