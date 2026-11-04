// M5-03: `pnpm devpost:check`. The Devpost text (docs/submission/devpost.md) is the submission of record and judges
// may read only it, so it must say exactly what the README and the reports say. One line per problem, exit 1 on any.
//   --fields  every Devpost field is present and non-empty; the tagline is ≤ 60 characters (no network).
//   (default) the above, plus: the PayPal endpoints equal the README's (and each is in a recorded fixture); every
//             measured number appears in the README or a docs/evidence/ report; forbidden phrases absent and the
//             required wording present; the hosted URL (and the video URL once filled) answer 200; the gallery has
//             6–8 PNG/JPG images, each 3:2 (±1%), ≤ 5 MB and captioned.
//   --final   for M5-SUBMIT: a placeholder (the video link before M5-02) fails, and the repo link must answer 200.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORBIDDEN,
  MEASURED,
  checkEndpoints,
  fixtureEndpoints,
  inEvidence,
  proseLines,
  withoutUrls,
} from "./check-readme-claims.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEVPOST = "docs/submission/devpost.md";
const GALLERY = "docs/submission/gallery";
const TAGLINE_MAX = 60;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PLACEHOLDER = /<!--\s*Filled by M5-02[^>]*-->/;

/** Devpost's fields (`##`) and the headings of its "About the project" field (`###`). */
export const FIELDS = [
  "Project name",
  "Tagline",
  "About the project",
  "Built with",
  "Try it out",
  "Video demo link",
  "Image gallery",
  "Sponsor prizes",
] as const;
export const ABOUT = [
  "Inspiration",
  "What it does",
  "How we built it",
  "AI tools used and how",
  "Challenges we ran into",
  "Accomplishments that we're proud of",
  "What we learned",
  "What's next for Cleared",
  "Limits, stated plainly",
] as const;
/** Wording the text must carry (claims discipline). */
export const REQUIRED = [
  "the seller keeps the money (PayPal covered the case)",
  "Simulate PayPal's decision (sandbox only)",
  "Visual citation is not built",
  "labelled by Claude",
  "Claude Code",
  "MISS",
] as const;

/** The body under each heading of the given level, up to the next heading of that level or higher. */
export function sections(md: string, level: 2 | 3): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (name !== null) out.set(name, body.join("\n").trim());
  };
  for (const line of md.split("\n")) {
    const h = /^(#{1,6}) (.+)$/.exec(line);
    if (h && (h[1] ?? "").length <= level) {
      flush();
      name = (h[1] ?? "").length === level ? (h[2] ?? "").trim() : null;
      body = [];
    } else body.push(line);
  }
  flush();
  return out;
}

const stripComments = (s: string): string => s.replace(/<!--[\s\S]*?-->/g, "").trim();

export function checkFields(md: string, final: boolean): string[] {
  const problems: string[] = [];
  const fields = sections(md, 2);
  const about = sections(fields.get("About the project") ?? "", 3);
  const need = (map: Map<string, string>, names: readonly string[], where: string): void => {
    for (const f of names) {
      const body = map.get(f);
      if (body === undefined) problems.push(`${where}: missing "${f}"`);
      else if (stripComments(body) === "" && !(PLACEHOLDER.test(body) && !final)) {
        problems.push(`${where}: "${f}" is ${PLACEHOLDER.test(body) ? "still a placeholder" : "empty"}`);
      }
    }
  };
  need(fields, FIELDS, "field");
  need(about, ABOUT, "About the project");
  const tagline = stripComments(fields.get("Tagline") ?? "");
  if (tagline.includes("\n")) problems.push("field: the tagline is more than one line");
  if ([...tagline].length > TAGLINE_MAX) {
    problems.push(
      `field: the tagline is ${String([...tagline].length)} characters (max ${String(TAGLINE_MAX)})`,
    );
  }
  return problems;
}

/** `METHOD /vN/...` in inline code, outside fences. */
export function endpoints(md: string): Set<string> {
  const out = new Set<string>();
  for (const { text } of proseLines(md)) {
    for (const m of text.matchAll(/`(GET|POST|PATCH|PUT|DELETE) (\/v\d+\/[^`\s]+)`/g)) {
      out.add(`${m[1] ?? ""} ${m[2] ?? ""}`);
    }
  }
  return out;
}

export function checkApis(md: string, readme: string, recorded: ReadonlySet<string>): string[] {
  const ours = endpoints(md);
  const theirs = endpoints(readme);
  return [
    ...[...ours].filter((e) => !theirs.has(e)).map((e) => `api: ${e} is not in the README's list`),
    ...[...theirs].filter((e) => !ours.has(e)).map((e) => `api: the README's ${e} is missing`),
    ...checkEndpoints(proseLines(md), recorded).map((p) => p.replace(/^README/, "devpost")),
  ];
}

/** Every measured number must appear in the README or in one of the docs/evidence/ reports. */
export function checkNumbers(md: string): string[] {
  const sources = [
    "README.md",
    ...readdirSync(join(ROOT, "docs/evidence"))
      .filter((f) => /\.(md|json)$/.test(f))
      .map((f) => `docs/evidence/${f}`),
  ];
  const problems: string[] = [];
  for (const { n, text } of proseLines(md)) {
    for (const t of withoutUrls(text).match(MEASURED) ?? []) {
      if (!sources.some((f) => inEvidence(t, f))) {
        problems.push(`devpost:${String(n)}: "${t}" is in neither the README nor a docs/evidence/ report`);
      }
    }
  }
  return problems;
}

export function checkWording(md: string): string[] {
  const problems: string[] = [];
  for (const { n, text } of proseLines(md)) {
    for (const [re, what] of FORBIDDEN) {
      if (re.test(text)) problems.push(`devpost:${String(n)}: forbidden phrase ${what}`);
    }
    if (/no mocks/i.test(text) && !/sandbox/i.test(text)) {
      problems.push(`devpost:${String(n)}: "no mocks" without the sandbox label`);
    }
  }
  for (const r of REQUIRED) if (!md.includes(r)) problems.push(`wording: "${r}" is missing`);
  return problems;
}

/** Width and height of a PNG (IHDR) or a baseline/progressive JPEG (first SOFn marker). */
export function imageSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.subarray(1, 4).toString("latin1") === "PNG")
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

export function checkGallery(md: string): string[] {
  const problems: string[] = [];
  const files = readdirSync(join(ROOT, GALLERY)).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (files.length < 6 || files.length > 8)
    problems.push(`gallery: ${String(files.length)} images (need 6–8)`);
  const captions = new Map<string, string>();
  for (const line of (sections(md, 2).get("Image gallery") ?? "").split("\n")) {
    const m = /^\d+\. `([^`]+)`: (.+)$/.exec(line.trim());
    if (m) captions.set(m[1] ?? "", (m[2] ?? "").trim());
  }
  for (const f of files) {
    const path = join(ROOT, GALLERY, f);
    if (statSync(path).size > MAX_IMAGE_BYTES) problems.push(`gallery: ${f} is over 5 MB`);
    const size = imageSize(readFileSync(path));
    if (size === null) problems.push(`gallery: ${f} is not a readable PNG/JPEG`);
    else if (Math.abs(size.w / size.h - 1.5) / 1.5 > 0.01) {
      problems.push(`gallery: ${f} is ${String(size.w)}×${String(size.h)}, not 3:2 (±1%)`);
    }
    if (!captions.get(f)) problems.push(`gallery: ${f} has no caption under "Image gallery"`);
  }
  for (const c of captions.keys()) if (!files.includes(c)) problems.push(`gallery: caption for missing ${c}`);
  return problems;
}

async function status(url: string): Promise<string> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    return String(res.status);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function checkLinks(
  md: string,
  final: boolean,
): Promise<{ problems: string[]; notes: string[] }> {
  const fields = sections(md, 2);
  const urls = (f: string): string[] => (fields.get(f) ?? "").match(/https?:\/\/[^\s)>]+/g) ?? [];
  const problems: string[] = [];
  const notes: string[] = [];
  const hosted = urls("Try it out").find((u) => u.includes("onrender.com"));
  const repo = urls("Try it out").find((u) => u.includes("github.com"));
  const video = urls("Video demo link")[0];
  const targets: [string, string | undefined][] = [["hosted URL", hosted]];
  if (video) targets.push(["video URL", video]);
  else if (final) problems.push("link: the video URL is still a placeholder (M5-02)");
  else notes.push("video URL: placeholder until M5-02, not checked (--final fails on it)");
  if (final) targets.push(["repo URL", repo]);
  else notes.push("repo URL: checked by --final at M5-SUBMIT, once the repository is public");
  for (const [what, url] of targets) {
    if (!url) {
      problems.push(`link: no ${what}`);
      continue;
    }
    const got = await status(url);
    if (got === "200") notes.push(`${what}: ${url} → 200`);
    else problems.push(`link: ${what} ${url} → ${got} (need 200)`);
  }
  return { problems, notes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const final = args.has("--final");
  const md = readFileSync(join(ROOT, DEVPOST), "utf8");
  const problems = checkFields(md, final);
  const notes: string[] = [];
  if (!args.has("--fields")) {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    problems.push(
      ...checkApis(md, readme, fixtureEndpoints()),
      ...checkNumbers(md),
      ...checkWording(md),
      ...checkGallery(md),
    );
    const links = await checkLinks(md, final);
    problems.push(...links.problems);
    notes.push(...links.notes);
  }
  for (const n of notes) console.log(n);
  for (const p of problems) console.error(p);
  if (problems.length > 0) process.exit(1);
  console.log(
    args.has("--fields")
      ? "Devpost fields: every field present, tagline within 60 characters"
      : "Devpost text: fields, APIs equal to the README, numbers in the README/reports, wording, links and gallery ok",
  );
}
