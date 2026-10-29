import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "M0-09 calendar spike" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
