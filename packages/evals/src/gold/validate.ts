// `pnpm eval:validate [--pii]`
// Default: checks the labelled gold sets (schema, counts, per-label minimums, injection items, EN/HI
// pairs, verbatim spans, seeded split, owner + non-production review, disagreements, kappa) and the
// spend ledger; prints the report and exits 1 on any error.
// --pii: scans the drafts, the reviews and the gold sets for real-looking emails, phones and PayPal ids.
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  checkCounts,
  checkCoverage,
  checkHolds,
  checkReviews,
  checkSpans,
  checkSpend,
  checkSplit,
  type GoldSets,
  type Report,
} from "./checks.ts";
import { bySet, DISAGREEMENTS_FILE, draftFile, goldFile, GOLD_DIR, readJsonl, reviewFile, SPEND_FILE } from "./io.ts";
import { scanText, stringsIn, type PiiFinding } from "./pii.ts";
import { DisagreementSchema, DraftItemSchema, GoldItemSchema, SETS } from "./schema.ts";
import { spendByDay } from "./spend.ts";

export function validate(): Report {
  const r: Report = { lines: [], errors: [] };
  const drafts = bySet((s) => readJsonl(draftFile(s), DraftItemSchema));
  r.lines.push(`drafts (unlabelled) — ${SETS.map((s) => `${s} ${String(drafts[s].length)}`).join(", ")}`);
  const sets: GoldSets = bySet((s) => readJsonl(goldFile(s), GoldItemSchema));
  const draftIds = bySet((s) => drafts[s].map((d) => d.id));
  checkCounts(sets, draftIds, r);
  checkSplit(sets, r);
  checkCoverage(sets, r);
  checkHolds(sets.holds, r);
  checkSpans(sets, r);
  checkReviews(sets, readJsonl(DISAGREEMENTS_FILE, DisagreementSchema), r);
  checkSpend(spendByDay(existsSync(SPEND_FILE) ? readFileSync(SPEND_FILE, "utf8") : ""), r);
  if (SETS.some((s) => sets[s].length === 0)) r.errors.push("owner labels missing (P-53): run `pnpm eval:label`, then `pnpm eval:label --reconcile`");
  return r;
}

export function piiScan(files: readonly string[]): { file: string; finding: PiiFinding }[] {
  return files
    .filter((f) => existsSync(f))
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .flatMap((line) => stringsIn(JSON.parse(line)).flatMap(scanText))
        .map((finding) => ({ file, finding })),
    );
}

function main(argv: readonly string[]): number {
  if (argv.includes("--pii")) {
    const files = SETS.flatMap((s) => [draftFile(s), reviewFile(s), goldFile(s)]);
    const found = piiScan(files);
    const scanned = files.filter((f) => existsSync(f)).map((f) => relative(GOLD_DIR, f));
    console.log(`pii: scanned ${String(scanned.length)} files (${scanned.join(", ")}): ${String(found.length)} findings`);
    for (const f of found) console.log(`  ${relative(GOLD_DIR, f.file)}: ${f.finding.kind} "${f.finding.match}"`);
    return found.length === 0 && scanned.length > 0 ? 0 : 1;
  }
  const r = validate();
  for (const line of r.lines) console.log(line);
  for (const e of r.errors) console.log(`ERROR ${e}`);
  console.log(r.errors.length === 0 ? "eval:validate: OK" : `eval:validate: ${String(r.errors.length)} error(s)`);
  return r.errors.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
