// M4-07: `pnpm runbook:check`. docs/operations/judging-runbook.md must keep every daily check and playbook
// the ticket lists (by heading), each playbook its Symptom / Check / Action / Rollback lines, and every
// `pnpm …` command it names must exist: a script in the targeted package.json (`--filter <name|./path>`,
// else the root), or a binary from a dependency of that package or of the root. Exit 1 with one line per
// problem, so a renamed script or a dropped section fails here instead of on Dec 1.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DOC = "docs/operations/judging-runbook.md";

/** Daily checks (### under "## Daily checks"): a pattern each heading must match, in the ticket's order. */
export const DAILY_CHECKS: readonly [string, RegExp][] = [
  ["synthetic judge path", /synthetic judge path/i],
  ["/healthz and /readyz", /healthz.*readyz/i],
  ["Sentry new issues", /sentry new issues/i],
  ["Render service health and deploys", /render service health/i],
  ["OpenAI spend vs LLM_DAILY_CAP_USD", /openai spend.*LLM_DAILY_CAP_USD/i],
  ["demo workspaces vs DEMO_WORKSPACES_GLOBAL_MAX", /demo workspaces.*DEMO_WORKSPACES_GLOBAL_MAX/i],
  ["webhook lag", /webhook lag/i],
  ["DLQ count", /dead-letter queues/i],
  ["nightly eval green", /nightly eval green/i],
  ["PayPal sandbox status", /paypal sandbox status/i],
];

/** Playbooks (### under "## Playbooks"). */
export const PLAYBOOKS: readonly [string, RegExp][] = [
  ["OpenAI outage or cap reached", /openai outage or cap reached/i],
  ["PayPal sandbox down or changed behaviour", /paypal sandbox down or changed behaviour/i],
  ["webhook registration lost", /webhook registration lost/i],
  ["global workspace cap reached", /global .*workspace cap reached/i],
  ["a bad deploy", /bad deploy/i],
  ["Postgres near its storage limit", /postgres near its storage limit/i],
  ["Bryntum trial expires or stops rendering", /bryntum trial/i],
  ["a judge-reported bug", /judge-reported bug/i],
  ["the kill switch (AGENT_KILL_SWITCH)", /kill switch.*AGENT_KILL_SWITCH/i],
];

const PLAYBOOK_PARTS = ["Symptom", "Check", "Action", "Rollback"] as const;
const SECTIONS = [/^## Change freeze/m, /^## Thresholds/m, /^## Retention and purge/m];

interface Section {
  readonly heading: string;
  readonly body: string;
}

/** The `### ` subsections of the `## ` section whose heading starts with `title`. */
export function subsections(md: string, title: string): Section[] {
  const start = md.search(new RegExp(`^## ${title}`, "m"));
  if (start === -1) return [];
  const rest = md.slice(start + 3);
  const end = rest.search(/^## /m);
  const block = end === -1 ? rest : rest.slice(0, end);
  return block
    .split(/^### /m)
    .slice(1)
    .map((s) => {
      const nl = s.indexOf("\n");
      return { heading: s.slice(0, nl).trim(), body: s.slice(nl + 1) };
    });
}

export interface Pkg {
  readonly name?: string;
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

/** The `pnpm …` commands in inline code and fenced blocks. */
export function pnpmCommands(md: string): string[] {
  const spans = [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
  const lines = [...md.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)].flatMap((m) => (m[1] ?? "").split("\n"));
  return [...spans, ...lines]
    .map((s) => s.slice(Math.max(0, s.search(/(^|\s)pnpm\s/))).trim())
    .filter((s) => s.startsWith("pnpm "));
}

const BUILTINS = new Set(["install", "add", "why", "list", "outdated", "audit"]);

/** Problems with one command: its package (from `--filter`) and its script or binary. */
export function checkCommand(
  cmd: string,
  root: Pkg,
  byFilter: (filter: string) => Pkg | null,
): string | null {
  const words = cmd.split(/\s+/).slice(1);
  let pkg: Pkg = root;
  let i = 0;
  while (words[i]?.startsWith("-") === true) {
    const flag = words[i] ?? "";
    if (flag === "--filter" || flag === "-F") {
      const target = words[i + 1] ?? "";
      const found = byFilter(target);
      if (found === null) return `\`${cmd}\`: no package matches --filter ${target}`;
      pkg = found;
      i += 2;
    } else i += 1;
  }
  let verb = words[i] ?? "";
  if (BUILTINS.has(verb)) return null;
  const isRun = verb === "run";
  if (isRun || verb === "exec") verb = words[i + 1] ?? "";
  const hasScript = pkg.scripts?.[verb] !== undefined;
  const deps = { ...root.dependencies, ...root.devDependencies, ...pkg.dependencies, ...pkg.devDependencies };
  const hasBin = !isRun && deps[verb] !== undefined;
  if (hasScript || hasBin) return null;
  return `\`${cmd}\`: "${verb}" is not a script${isRun ? "" : " or a dependency binary"} of ${pkg.name ?? "the root package.json"}`;
}

export function checkRunbook(md: string, root: Pkg, byFilter: (filter: string) => Pkg | null): string[] {
  const problems: string[] = [];
  const need = (title: string, list: readonly [string, RegExp][]): Section[] => {
    const subs = subsections(md, title);
    const matched: Section[] = [];
    for (const [label, re] of list) {
      const s = subs.find((x) => re.test(x.heading));
      if (s === undefined) problems.push(`${DOC}: "## ${title}" has no heading for ${label}`);
      else matched.push(s);
    }
    return matched;
  };
  need("Daily checks", DAILY_CHECKS);
  for (const p of need("Playbooks", PLAYBOOKS)) {
    for (const part of PLAYBOOK_PARTS) {
      if (!new RegExp(`\\*\\*${part}:\\*\\*`).test(p.body))
        problems.push(`${DOC}: playbook "${p.heading}" has no ${part}`);
    }
  }
  for (const re of SECTIONS) if (!re.test(md)) problems.push(`${DOC}: missing section ${re.source.slice(1)}`);
  const commands = pnpmCommands(md);
  if (commands.length === 0) problems.push(`${DOC}: no pnpm command found`);
  for (const c of commands) {
    const p = checkCommand(c, root, byFilter);
    if (p !== null) problems.push(`${DOC}: ${p}`);
  }
  return problems;
}

const readPkg = (dir: string): Pkg => JSON.parse(readFileSync(`${ROOT}${dir}/package.json`, "utf8")) as Pkg;

/** Workspace packages by name and by `./path`. */
function workspacePackages(): Map<string, Pkg> {
  const out = new Map<string, Pkg>();
  for (const group of ["apps", "packages"]) {
    for (const d of readdirSync(`${ROOT}${group}`)) {
      if (!existsSync(`${ROOT}${group}/${d}/package.json`)) continue;
      const pkg = readPkg(`${group}/${d}`);
      out.set(`./${group}/${d}`, pkg);
      if (pkg.name !== undefined) out.set(pkg.name, pkg);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  const md = readFileSync(`${ROOT}${DOC}`, "utf8");
  const pkgs = workspacePackages();
  const problems = checkRunbook(md, readPkg("."), (f) => pkgs.get(f) ?? null);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log(
    `runbook:check: ${String(DAILY_CHECKS.length)} daily checks, ${String(PLAYBOOKS.length)} playbooks (Symptom/Check/Action/Rollback), ${String(pnpmCommands(md).length)} pnpm commands resolve`,
  );
}
