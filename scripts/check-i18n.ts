#!/usr/bin/env node
// i18n check (M1-07, M4-03): `pnpm i18n:check`.
//   1. `apps/web/messages/en.json` and `hi.json` have identical key sets
//   2. no value is empty (in either file)
//   3. each key keeps the same ICU arguments ({name}, {count, plural, …}) and rich-text tags (<b>)
//   4. no user-facing attribute (aria-label, title, placeholder, alt) is a hard-coded literal in the web UI
// JSX text nodes are checked by ESLint (`JSXText[value=/\S/]`, eslint.config.js), which reads the syntax
// tree rather than guessing from text.
// Usage: node scripts/check-i18n.ts   (exit 1 on any finding)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Messages = { readonly [key: string]: string | Messages };

const root = new URL("..", import.meta.url).pathname;
const web = join(root, "apps/web");
const LOCALES = ["en", "hi"] as const;
const problems: string[] = [];

function flatten(obj: Messages, prefix = "", out = new Map<string, string>()): Map<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix === "" ? k : `${prefix}.${k}`;
    if (typeof v === "object") flatten(v, key, out);
    else out.set(key, String(v));
  }
  return out;
}

/** ICU arguments ({name}, {count, plural, …}) and rich-text tags (<en>) a translation must keep. */
function tokens(msg: string): string {
  const args = [...msg.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/g)].map((m) => `{${m[1] ?? ""}}`);
  const tags = [...msg.matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)>/g)].map((m) => `<${m[1] ?? ""}>`);
  return [...new Set([...args, ...tags])].sort().join(" ");
}

const sets = Object.fromEntries(
  LOCALES.map((l) => [
    l,
    flatten(JSON.parse(readFileSync(join(web, `messages/${l}.json`), "utf8")) as Messages),
  ]),
) as Record<(typeof LOCALES)[number], Map<string, string>>;

for (const [a, b] of [
  ["en", "hi"],
  ["hi", "en"],
] as const) {
  for (const key of sets[a].keys()) {
    if (!sets[b].has(key)) problems.push(`messages/${b}.json is missing "${key}" (present in ${a}.json)`);
  }
}
for (const l of LOCALES) {
  for (const [key, value] of sets[l]) {
    if (value.trim() === "") problems.push(`messages/${l}.json "${key}" is empty`);
  }
}
for (const [key, en] of sets.en) {
  const hi = sets.hi.get(key);
  if (hi !== undefined && tokens(en) !== tokens(hi)) {
    problems.push(`"${key}": placeholders differ (en: ${tokens(en) || "none"}; hi: ${tokens(hi) || "none"})`);
  }
}

function* tsxFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsxFiles(p);
    else if (p.endsWith(".tsx") && !p.endsWith(".test.tsx")) yield p;
  }
}

const ATTR = /\b(aria-label|title|placeholder|alt)=["']([^"']*\p{L}[^"']*)["']/gu;
for (const dir of [join(web, "app"), join(web, "src/components")]) {
  for (const file of tsxFiles(dir)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(ATTR)) {
      const line = src.slice(0, m.index).split("\n").length;
      problems.push(`${relative(root, file)}:${String(line)}: hard-coded ${m[1] ?? ""}="${m[2] ?? ""}"`);
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`i18n:check: ${p}`);
  process.exit(1);
}
console.log(
  `i18n:check: ok (${String(sets.en.size)} keys, identical in en.json and hi.json; no empty value; ICU placeholders match; no hard-coded UI attributes)`,
);
