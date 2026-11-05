// Any path under /en or /hi that no route matches (BL-01 6649566240): hand it to the locale's not-found
// page, so it renders in the locale layout instead of Next's unbranded default.
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default function UnknownPath(): never {
  notFound();
}
