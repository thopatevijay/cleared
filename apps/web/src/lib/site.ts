// Placeholder copy for the bootstrap page; the real landing page is M1-07.
export const site = {
  name: "Cleared",
  tagline: "Your PayPal money, cleared.",
} as const;

/** The repository README on GitHub (landing "Read the README on GitHub"). */
export const README_URL = "https://github.com/thopatevijay/cleared#readme";

/**
 * The README's judging guide: where a visitor refused by the demo cap goes (landing.md "Per-network cap",
 * BL-01 6649565560). Not a video: the video link arrives in M5-02, and none is invented here.
 */
export const JUDGE_GUIDE_URL = "https://github.com/thopatevijay/cleared#how-to-judge-in-5-minutes";

export function pageTitle(section?: string): string {
  return section ? `${section} · ${site.name}` : site.name;
}
