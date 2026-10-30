// Magic-link email, Hindi (M1-05). Same structure as the English template.
import { escapeHtml, type MagicLinkParams, type RenderedEmail } from "./html.ts";

export function magicLinkHi(p: MagicLinkParams): RenderedEmail {
  const minutes = String(p.minutes);
  const subject = "Cleared में साइन इन करने का आपका लिंक";
  const lead = `Cleared में साइन इन करने के लिए यह लिंक इस्तेमाल करें। यह सिर्फ़ एक बार काम करता है और ${minutes} मिनट में समाप्त हो जाता है।`;
  const ignore =
    "अगर आपने यह नहीं माँगा था, तो इस ईमेल को अनदेखा करें। लिंक के बिना कोई साइन इन नहीं कर सकता।";
  return {
    subject,
    text: `${lead}\n\n${p.url}\n\n${ignore}\n`,
    html:
      `<p lang="hi">${escapeHtml(lead)}</p>` +
      `<p lang="hi"><a href="${escapeHtml(p.url)}">Cleared में साइन इन करें</a></p>` +
      `<p lang="hi">${escapeHtml(ignore)}</p>`,
  };
}
