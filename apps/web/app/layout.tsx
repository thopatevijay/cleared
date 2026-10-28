import type { Metadata } from "next";
import type { ReactNode } from "react";
import { pageTitle, site } from "../src/lib/site.ts";

export const metadata: Metadata = {
  title: pageTitle(),
  description: site.tagline,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
