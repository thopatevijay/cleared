// The root 404 fallback (not-found.md, BL-01 6649566240): a path outside /en and /hi that the proxy does
// not redirect (for example one with a file extension). The root layout is a pass-through, so this page
// renders its own <html lang="en">, in English (the request config falls back to the default locale).
import { NextIntlClientProvider } from "next-intl";
import { NotFoundView } from "../src/components/NotFoundView.tsx";
import { routing } from "../src/i18n/routing.ts";

export default function RootNotFound() {
  return (
    <html lang={routing.defaultLocale}>
      <body className="text-base text-text antialiased">
        <NextIntlClientProvider locale={routing.defaultLocale}>
          <NotFoundView />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
