// The root layout is a pass-through: `app/[locale]/layout.tsx` renders <html lang> per locale (next-intl).
import type { ReactNode } from "react";
import "../src/styles/globals.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
