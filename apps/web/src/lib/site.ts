// Placeholder copy for the bootstrap page; the real landing page is M1-07.
export const site = {
  name: "Cleared",
  tagline: "Your PayPal money, cleared.",
} as const;

export function pageTitle(section?: string): string {
  return section ? `${section} · ${site.name}` : site.name;
}
