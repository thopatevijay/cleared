import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { codeBreaks } from "./CodeText.tsx";

describe("codeBreaks (BL-01 6601579774 item 3)", () => {
  it("allows a break after each underscore and keeps the code's text verbatim", () => {
    const html = renderToStaticMarkup(<code>{codeBreaks("MERCHANDISE_OR_SERVICE")}</code>);
    expect(html).toBe("<code>MERCHANDISE_<wbr/>OR_<wbr/>SERVICE</code>");
    expect(renderToStaticMarkup(<code>{codeBreaks("PENDING")}</code>)).toBe("<code>PENDING</code>");
  });
});
