#!/usr/bin/env node
// i18n check (M1-07): `apps/web/messages/en.json` and `hi.json` have identical key sets and the same
// ICU placeholders/tags per key, and no user-visible string is hard-coded in the web UI's JSX
// (apps/web/app/** and apps/web/src/components/**): JSX text nodes and user-facing attributes
// (aria-label, title, placeholder, alt) must come from the messages.
// Usage: node scripts/check-messages.mjs   (exit 1 on any finding)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const web = join(root, "apps/web");
const problems = [];

function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") flatten(v, key, out);
    else out.set(key, String(v));
  }
  return out;
}

/** ICU arguments ({name}, {count, plural, …}) and rich-text tags (<en>) a translation must keep. */
function tokens(msg) {
  const args = [...msg.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/g)].map((m) => `{${m[1]}}`);
  const tags = [...msg.matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)>/g)].map((m) => `<${m[1]}>`);
  return [...new Set([...args, ...tags])].sort().join(" ");
}

const locales = ["en", "hi"];
const sets = Object.fromEntries(
  locales.map((l) => [l, flatten(JSON.parse(readFileSync(join(web, `messages/${l}.json`), "utf8")))]),
);
for (const [a, b] of [
  ["en", "hi"],
  ["hi", "en"],
]) {
  for (const key of sets[a].keys()) {
    if (!sets[b].has(key)) problems.push(`messages/${b}.json is missing "${key}" (present in ${a}.json)`);
  }
}
for (const [key, en] of sets.en) {
  const hi = sets.hi.get(key);
  if (hi !== undefined && tokens(en) !== tokens(hi)) {
    problems.push(`"${key}": placeholders differ (en: ${tokens(en) || "none"}; hi: ${tokens(hi) || "none"})`);
  }
  if (hi !== undefined && hi.trim() === "") problems.push(`messages/hi.json "${key}" is empty`);
}

function* tsxFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsxFiles(p);
    else if (p.endsWith(".tsx")) yield p;
  }
}

// Text between a JSX tag end and the next tag/expression that contains a letter. Strips comments first.
const TEXT_NODE = />([^<>{}`]*[\p{L}][^<>{}`]*)</gu;
const ATTR = /\b(aria-label|title|placeholder|alt)=["']([^"']*\p{L}[^"']*)["']/gu;
for (const dir of [join(web, "app"), join(web, "src/components")]) {
  for (const file of tsxFiles(dir)) {
    const src = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const re of [TEXT_NODE, ATTR]) {
      for (const m of src.matchAll(re)) {
        const text = (m[2] ?? m[1]).trim();
        // TypeScript generics and comparisons (`a > b && c < d`) are not JSX text.
        if (text === "" || /[=;()&|]/.test(text)) continue;
        const line = src.slice(0, m.index).split("\n").length;
        problems.push(`${relative(root, file)}:${String(line)}: hard-coded user-visible text "${text}"`);
      }
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`check-messages: ${p}`);
  process.exit(1);
}
console.log(
  `check-messages: ok (${String(sets.en.size)} keys in en.json and hi.json; no hard-coded JSX text in apps/web/app and src/components)`,
);
