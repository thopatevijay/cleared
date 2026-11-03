// M4-05: `pnpm security:check-doc`. Every row of the STRIDE tables in docs/security/threat-model.md
// names at least one test file (a backticked `*.test.ts` / `*.spec.ts` path from the repo root) and every
// named file exists; every dependency-audit exception carries a future expiry date. Exit 1 with one line
// per problem. A doc row whose test is renamed or deleted fails here, not silently.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DOC = "docs/security/threat-model.md";
const TEST_PATH = /`([^`\s]+\.(?:test|spec)\.tsx?)(?:::[^`]*)?`/g;

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** The table rows (no header, no separator) of every section whose heading matches `heading`. */
function sectionRows(md: string, heading: RegExp): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let inside = false;
  let header = false;
  md.split("\n").forEach((text, i) => {
    if (/^#{2,3} /.test(text)) {
      inside = heading.test(text);
      header = false;
      return;
    }
    if (!inside || !text.trim().startsWith("|")) {
      header = false;
      return;
    }
    if (!header) {
      header = true; // the first row of a table is its header
      return;
    }
    if (/^\|[\s:|-]+\|$/.test(text.trim())) return;
    out.push({ line: i + 1, cells: cells(text) });
  });
  return out;
}

export function checkSecurityDoc(md: string, exists: (p: string) => boolean, today: string): string[] {
  const problems: string[] = [];
  const stride = sectionRows(md, /STRIDE/);
  if (stride.length === 0) problems.push(`${DOC}: no STRIDE table rows found`);
  for (const row of stride) {
    const id = row.cells[0] ?? "?";
    const tests = [...(row.cells.at(-1) ?? "").matchAll(TEST_PATH)].map((m) => m[1] ?? "");
    if (tests.length === 0) problems.push(`${DOC}:${String(row.line)} ${id}: no test file named`);
    for (const t of tests) if (!exists(t)) problems.push(`${DOC}:${String(row.line)} ${id}: ${t} does not exist`);
  }
  for (const row of sectionRows(md, /audit exceptions/i)) {
    const expiry = row.cells.find((c) => /^\d{4}-\d{2}-\d{2}$/.test(c));
    if (expiry === undefined) problems.push(`${DOC}:${String(row.line)}: audit exception without an expiry date`);
    else if (expiry < today) problems.push(`${DOC}:${String(row.line)}: audit exception expired ${expiry}`);
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  const md = readFileSync(`${ROOT}${DOC}`, "utf8");
  const problems = checkSecurityDoc(md, (p) => existsSync(`${ROOT}${p}`), new Date().toISOString().slice(0, 10));
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  const rows = sectionRows(md, /STRIDE/).length;
  console.log(`security:check-doc: ${String(rows)} STRIDE rows, every one names an existing test file`);
}
