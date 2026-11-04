// Locale layout (M1-07): <html lang>, the self-hosted fonts, and the next-intl provider.
import type { Metadata } from "next";
import {
  Atkinson_Hyperlegible_Mono,
  Atkinson_Hyperlegible_Next,
  Noto_Sans_Devanagari,
} from "next/font/google";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { isAppLocale } from "../../src/i18n/routing.ts";
import { pageTitle } from "../../src/lib/site.ts";
import { WebVitals } from "../web-vitals.tsx";

const atkinson = Atkinson_Hyperlegible_Next({
  subsets: ["latin", "latin-ext"],
  weight: "variable",
  display: "swap",
  variable: "--font-atkinson",
});
const notoDeva = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  // M4-04: not preloaded. A 118 KB preload on every English page competed with the first paint on Slow
  // 4G; Hindi pages fetch it as soon as their text uses it (`display: swap`).
  preload: false,
  variable: "--font-noto-deva",
});
const atkinsonMono = Atkinson_Hyperlegible_Mono({
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
  // M4-04: ids and codes only, never the largest text: fetched when used.
  preload: false,
  variable: "--font-atkinson-mono",
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return { title: pageTitle(), description: t("description") };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isAppLocale(locale)) notFound();
  return (
    <html lang={locale} className={`${atkinson.variable} ${notoDeva.variable} ${atkinsonMono.variable}`}>
      <body className="text-base text-text antialiased">
        <WebVitals />
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
