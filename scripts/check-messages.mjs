#!/usr/bin/env node
// M1-07's i18n check, kept so its Validation Gate line still runs: since M4-03 the check is
// `scripts/check-i18n.ts` (`pnpm i18n:check`), and JSX text nodes are an ESLint rule.
import "./check-i18n.ts";
