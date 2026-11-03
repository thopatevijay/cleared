// A PayPal code shown verbatim (MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED): a line may break after each
// underscore (<wbr>), and only mid-token when one segment alone is wider than the line
// (`overflow-wrap: anywhere`). BL-01 6601579774 item 3: `break-all` split "…DESCRIB / ED".
import { Fragment } from "react";

export function codeBreaks(code: string) {
  const parts = code.split("_");
  return parts.map((p, i) => (
    <Fragment key={i}>
      {p}
      {i < parts.length - 1 ? (
        <>
          {"_"}
          <wbr />
        </>
      ) : null}
    </Fragment>
  ));
}
