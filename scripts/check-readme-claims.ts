// M5-01: `pnpm readme:check`. The README is what judges (and automated analysis) read, so every claim in it
// must trace to something in the repo. Checks, one line per problem, exit 1 on any:
//   1. every PayPal endpoint the README names (`METHOD /v1/...` in inline code) was exchanged in a recorded
//      sandbox fixture under fixtures/paypal/ (same method; `{id}` matches one path segment);
//   2. every measured number outside the eval block (`12.3 ms`, `95.2%`, `185.0 KB`, `35 s`, `118/124`,
//      `6 of 8`, `$0.0070`) sits on a line that links a docs/evidence/ report, and appears in that report
//      (for a .json report: in its numbers, rendered the way the eval report renders them). The eval block
//      itself is checked by `pnpm eval:check-readme`;
//   3. forbidden phrases are absent ("seller won", "guaranteed", "owner-/human-labelled", "no mocks"
//      without the sandbox label on the same line);
//   4. every relative link and image resolves (in-page anchors against the headings); every image is in
//      docs/screenshots/, ≤ 1 MB, with alt text;
//   5. nothing links to or names a path M5-CLEANUP untracks.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_IMAGE_BYTES = 1024 * 1024;
const UNTRACKED_LATER = [
  "PROJECT.md",
  "WORKFLOW.md",
  "CLAUDE.md",
  ".github/plan",
  "docs/engineering-standards", // without the extension so the public-tree citation check skips it
];
export const FORBIDDEN: readonly [RegExp, string][] = [
  [
    /seller (has )?won|won the dispute/i,
    '"seller won" (say "the seller keeps the money (PayPal covered the case)")',
  ],
  [/guarantee/i, '"guaranteed"'],
  [/(owner|human)[- ]labell?ed/i, '"owner-labelled" / "human-labelled" (the gold set is labelled by Claude)'],
];

/** One README line with its 1-based number. */
interface Line {
  readonly n: number;
  readonly text: string;
}

/** README lines outside fenced code blocks and outside the generated eval block. */
export function proseLines(md: string): Line[] {
  const out: Line[] = [];
  let fenced = false;
  let evalBlock = false;
  md.split("\n").forEach((text, i) => {
    if (/^\s*```/.test(text)) fenced = !fenced;
    else if (text.includes("<!-- eval:start -->")) evalBlock = true;
    else if (text.includes("<!-- eval:end -->")) evalBlock = false;
    else if (!fenced && !evalBlock) out.push({ n: i + 1, text });
  });
  return out;
}

/** Markdown link targets on a line: `[text](target)` and `![alt](target)`. */
export function links(text: string): { alt: string; target: string; image: boolean }[] {
  return [...text.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({
    image: m[1] === "!",
    alt: m[2] ?? "",
    target: m[3] ?? "",
  }));
}

const isExternal = (t: string): boolean => /^[a-z]+:/i.test(t);

/** Every `{method, url}` pair recorded under fixtures/paypal/, as `METHOD /path` (host and query dropped). */
export function fixtureEndpoints(dir = join(ROOT, "fixtures/paypal")): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) {
      const o = v as Record<string, unknown>;
      if (typeof o["method"] === "string" && typeof o["url"] === "string") {
        const path = o["url"].replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
        out.add(`${o["method"].toUpperCase()} ${path}`);
      }
      Object.values(o).forEach(walk);
    }
  };
  for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (f.endsWith(".json")) walk(JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown);
  }
  return out;
}

/** `POST /v2/checkout/orders/{id}/track` → a regex where each `{…}` is one path segment. */
const endpointPattern = (method: string, path: string): RegExp =>
  new RegExp(`^${method} ${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+")}$`);

export function checkEndpoints(lines: readonly Line[], recorded: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const { n, text } of lines) {
    for (const m of text.matchAll(/`(GET|POST|PATCH|PUT|DELETE) (\/v\d+\/[^`\s]+)`/g)) {
      const [, method = "", path = ""] = m;
      const re = endpointPattern(method, path);
      if (![...recorded].some((e) => re.test(e))) {
        problems.push(`README:${String(n)}: ${method} ${path} is not in any fixtures/paypal/ exchange`);
      }
    }
  }
  return problems;
}

/** Measured numbers: values with a unit, k/n fractions, "k of n", and costs with 4 decimals. */
export const MEASURED =
  /\$\d+\.\d{4}\b|\b\d+ of \d+\b|\b\d+\/\d+\b(?![/\w])|\b\d[\d,]*(?:\.\d+)?\s?(?:%|ms\b|KB\b|s\b)/g;
/** Bold marks and thousands separators dropped, a number and its unit joined ("200 %" = "200%"). */
export const squash = (s: string): string =>
  s
    .replace(/\*/g, "")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/(\d)\s+(?=%|ms\b|KB\b|s\b)/g, "$1")
    .replace(/\s+/g, " ");

/** The README text without link targets and URLs, so `item?id=…` and paths aren't read as numbers. */
export const withoutUrls = (text: string): string =>
  text
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`[^`]*`/g, "");

/** The ways the eval report renders the numbers of a JSON report: raw, k/n, percent (1 dp), 3 dp, $4 dp. */
export function jsonTokens(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === "number") {
    out.add(String(v));
    out.add(v.toFixed(3));
    out.add(`$${v.toFixed(4)}`);
    if (v >= 0 && v <= 1) out.add(`${(v * 100).toFixed(1)}%`);
  } else if (Array.isArray(v)) v.forEach((x) => jsonTokens(x, out));
  else if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o["k"] === "number" && typeof o["n"] === "number")
      out.add(`${String(o["k"])}/${String(o["n"])}`);
    Object.values(o).forEach((x) => jsonTokens(x, out));
  }
  return out;
}

/** True when `token` appears in the evidence file (squashed text match, or a rendered JSON number). */
export function inEvidence(token: string, file: string): boolean {
  const raw = readFileSync(join(ROOT, file), "utf8");
  if (file.endsWith(".json")) return jsonTokens(JSON.parse(raw) as unknown).has(squash(token));
  // whole numbers only: "1 ms" must not match inside "21 ms" or "1.5 ms"
  const t = squash(token).replace(/[.*+?^$()|[\]\\/]/g, "\\$&");
  return new RegExp(`(?<![\\d.$])${t}(?![\\d])`).test(squash(raw));
}

export function checkNumbers(lines: readonly Line[]): string[] {
  const problems: string[] = [];
  for (const { n, text } of lines) {
    const tokens = withoutUrls(text).match(MEASURED) ?? [];
    if (tokens.length === 0) continue;
    const evidence = links(text)
      .map((l) => l.target.replace(/#.*$/, ""))
      .filter((t) => /^docs\/evidence\/[^/]+\.(md|json)$/.test(t) && existsSync(join(ROOT, t)));
    if (evidence.length === 0) {
      problems.push(
        `README:${String(n)}: measured number(s) ${tokens.join(", ")} without a docs/evidence/ link`,
      );
      continue;
    }
    for (const t of tokens) {
      if (!evidence.some((f) => inEvidence(t, f))) {
        problems.push(`README:${String(n)}: "${t}" is not in ${evidence.join(" or ")}`);
      }
    }
  }
  return problems;
}

export function checkPhrases(lines: readonly Line[]): string[] {
  const problems: string[] = [];
  for (const { n, text } of lines) {
    for (const [re, what] of FORBIDDEN) {
      if (re.test(text)) problems.push(`README:${String(n)}: forbidden phrase ${what}`);
    }
    if (/no mocks/i.test(text) && !/sandbox/i.test(text)) {
      problems.push(`README:${String(n)}: "no mocks" without the sandbox label`);
    }
  }
  return problems;
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

function checkImage(n: number, alt: string, target: string): string[] {
  const at = `README:${String(n)}: image ${target}`;
  if (alt.trim() === "") return [`${at} has no alt text`];
  if (!target.startsWith("docs/screenshots/")) return [`${at} is not in docs/screenshots/`];
  const path = join(ROOT, target);
  if (!existsSync(path)) return [`${at} does not exist`];
  return statSync(path).size > MAX_IMAGE_BYTES ? [`${at} is over 1 MB`] : [];
}

export function checkLinks(md: string, lines: readonly Line[]): string[] {
  const anchors = new Set(
    md
      .split("\n")
      .filter((l) => /^#{1,6} /.test(l))
      .map((l) => slug(l.replace(/^#+ /, ""))),
  );
  const problems: string[] = [];
  for (const { n, text } of lines) {
    for (const { alt, target, image } of links(text)) {
      if (image && !isExternal(target)) problems.push(...checkImage(n, alt, target));
      if (isExternal(target)) continue;
      const [path = "", anchor] = target.split("#");
      if (path === "" && anchor !== undefined && !anchors.has(anchor)) {
        problems.push(`README:${String(n)}: anchor #${anchor} matches no heading`);
      } else if (path !== "" && !existsSync(join(ROOT, path))) {
        problems.push(`README:${String(n)}: link ${target} does not resolve`);
      }
    }
  }
  return problems;
}

export function checkUntracked(md: string): string[] {
  return md
    .split("\n")
    .flatMap((text, i) =>
      UNTRACKED_LATER.filter((p) => text.includes(p)).map(
        (p) => `README:${String(i + 1)}: names ${p}, which M5-CLEANUP untracks`,
      ),
    );
}

export function checkReadmeClaims(md: string, recorded: ReadonlySet<string>): string[] {
  const lines = proseLines(md);
  return [
    ...checkEndpoints(lines, recorded),
    ...checkNumbers(lines),
    ...checkPhrases(lines),
    ...checkLinks(md, lines),
    ...checkUntracked(md),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkReadmeClaims(readFileSync(join(ROOT, "README.md"), "utf8"), fixtureEndpoints());
  for (const p of problems) console.error(p);
  if (problems.length > 0) process.exit(1);
  console.log(
    "README claims: endpoints recorded, numbers in their reports, wording, links and screenshots ok",
  );
}
