// The localized 404 for /en/* and /hi/* (not-found.md, BL-01 6649566240): rendered inside the locale
// layout, so <html lang> follows the URL and Next's nonce reaches every script (no CSP violation).
import { NotFoundView } from "../../src/components/NotFoundView.tsx";

export default function LocaleNotFound() {
  return <NotFoundView />;
}
