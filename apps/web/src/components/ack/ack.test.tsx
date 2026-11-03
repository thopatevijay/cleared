// BL-01 6595502129 (M4-03 backlog pass): the acknowledgement's thank-you line never doubles a full stop
// when the client's name already ends in one ("Northwind Tea Co."), in EN and HI.
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json" with { type: "json" };
import hi from "../../../messages/hi.json" with { type: "json" };
import { Success } from "./AckForm.tsx";

const AT = "2026-11-03T09:30:00.000Z";
const heading = (locale: "en" | "hi", name: string): string => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi} timeZone="UTC">
      <Success name={name} at={AT} />
    </NextIntlClientProvider>,
  );
  return /<h2[^>]*>([^<]*)<\/h2>/.exec(html)?.[1] ?? "";
};

describe("ack success heading", () => {
  it("adds the full stop after a plain name", () => {
    expect(heading("en", "Asha Rao")).toBe("Thanks, Asha Rao. Your confirmation is recorded.");
    expect(heading("hi", "आशा राव")).toBe("धन्यवाद, आशा राव। आपकी पुष्टि दर्ज हो गई है।");
  });

  it("does not double it when the name ends in one", () => {
    expect(heading("en", "Northwind Tea Co.")).toBe(
      "Thanks, Northwind Tea Co. Your confirmation is recorded.",
    );
    expect(heading("hi", "Northwind Tea Co.")).toBe("धन्यवाद, Northwind Tea Co. आपकी पुष्टि दर्ज हो गई है।");
  });
});
