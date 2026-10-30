#!/usr/bin/env node
// Design tokens: docs/design/tokens.json is the source of truth (M1-06).
//
//   node scripts/design-tokens.mjs           write apps/web/src/styles/tokens.css (Tailwind 4 @theme)
//   node scripts/design-tokens.mjs --check   exit 1 if tokens.css drifts from tokens.json, the token file
//                                            is malformed, or any declared text/background pair (and every
//                                            status pair) falls below its WCAG 2.2 contrast minimum in
//                                            light or dark
//
// Plain Node (no dependencies) so it runs before `pnpm install` and in CI as is.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "docs/design/tokens.json");
const OUT = join(ROOT, "apps/web/src/styles/tokens.css");
const HEX = /^#[0-9a-fA-F]{6}$/;
const SCHEMES = ["light", "dark"];

// ---------- WCAG 2.2 relative luminance and contrast ----------
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------- validation ----------
function validate(t) {
  const errors = [];
  const { light, dark, status } = t.color ?? {};
  if (!light || !dark) return ["color.light and color.dark are required"];
  for (const s of SCHEMES) {
    for (const [k, v] of Object.entries(t.color[s])) {
      if (!HEX.test(v)) errors.push(`color.${s}.${k} = ${v} is not #rrggbb`);
    }
  }
  const lk = Object.keys(light).sort().join();
  const dk = Object.keys(dark).sort().join();
  if (lk !== dk) errors.push("color.light and color.dark must define the same names");
  const known = (name, where) => {
    if (!(name in light)) errors.push(`${where} references unknown colour "${name}"`);
  };
  if (!status || Object.keys(status).length === 0) errors.push("color.status is required");
  for (const [k, s] of Object.entries(status ?? {})) {
    for (const f of ["fg", "bg", "icon"]) known(s[f], `color.status.${k}.${f}`);
    if (!s.iconName) errors.push(`color.status.${k}.iconName is required (never colour alone)`);
    if (!s.label?.en || !s.label?.hi) errors.push(`color.status.${k}.label needs en and hi`);
  }
  if (!Array.isArray(t.contrast) || t.contrast.length === 0) errors.push("contrast[] is required");
  for (const [i, p] of (t.contrast ?? []).entries()) {
    known(p.fg, `contrast[${i}].fg`);
    known(p.bg, `contrast[${i}].bg`);
    if (![4.5, 3].includes(p.min)) errors.push(`contrast[${i}].min must be 4.5 or 3`);
  }
  for (const k of ["font", "text", "spacing", "radius", "shadow", "motion", "breakpoint", "z"]) {
    if (!t[k]) errors.push(`${k} is required`);
  }
  return errors;
}

// Every pair checked: the declared list plus each status (label text on its fill at 4.5, icon at 3).
function pairs(t) {
  const out = t.contrast.map((p) => ({ ...p, use: p.use ?? "" }));
  for (const [k, s] of Object.entries(t.color.status)) {
    out.push({ fg: s.fg, bg: s.bg, min: 4.5, use: `status ${k} label` });
    out.push({ fg: s.icon, bg: s.bg, min: 3, use: `status ${k} icon` });
  }
  return out;
}

function contrastFailures(t) {
  const fails = [];
  const lines = [];
  for (const s of SCHEMES) {
    const c = t.color[s];
    for (const p of pairs(t)) {
      const r = contrast(c[p.fg], c[p.bg]);
      const ok = r + 1e-9 >= p.min;
      lines.push(`${ok ? "ok  " : "FAIL"} ${s.padEnd(5)} ${r.toFixed(2).padStart(5)}:1 >= ${p.min}  ${p.fg} on ${p.bg}  (${p.use})`);
      if (!ok) fails.push(lines.at(-1));
    }
  }
  return { fails, lines };
}

// ---------- CSS generation ----------
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const px2rem = (v) => (typeof v === "string" && v.endsWith("px") ? `${parseFloat(v) / 16}rem` : v);

function themeVars(t) {
  const v = [];
  for (const [k, val] of Object.entries(t.color.light)) v.push([`--color-${k}`, val]);
  for (const [k, val] of Object.entries(t.font)) v.push([`--font-${kebab(k)}`, val]);
  for (const [k, s] of Object.entries(t.text)) {
    v.push([`--text-${k}`, px2rem(s.size)]);
    v.push([`--text-${k}--line-height`, s.lineHeight]);
    if (s.weight) v.push([`--text-${k}--font-weight`, String(s.weight)]);
  }
  v.push(["--spacing", px2rem(t.spacing.base)]);
  for (const [k, val] of Object.entries(t.radius)) v.push([`--radius-${k}`, px2rem(val)]);
  for (const [k, val] of Object.entries(t.shadow.light ?? t.shadow)) v.push([`--shadow-${k}`, val]);
  for (const [k, val] of Object.entries(t.motion.duration ?? {})) v.push([`--duration-${k}`, val]);
  for (const [k, val] of Object.entries(t.motion.ease ?? {})) v.push([`--ease-${k}`, val]);
  for (const [k, val] of Object.entries(t.breakpoint)) v.push([`--breakpoint-${k}`, px2rem(val)]);
  for (const [k, val] of Object.entries(t.z)) v.push([`--z-${k}`, String(val)]);
  return v;
}

function hiLineHeights(t) {
  return Object.entries(t.text)
    .filter(([, s]) => s.lineHeightHi)
    .map(([k, s]) => [`--text-${k}--line-height`, s.lineHeightHi]);
}

const block = (sel, vars, indent = "") =>
  `${indent}${sel} {\n${vars.map(([k, v]) => `${indent}  ${k}: ${v};`).join("\n")}\n${indent}}`;

export function render(t) {
  const darkColors = Object.entries(t.color.dark).map(([k, v]) => [`--color-${k}`, v]);
  const darkShadows = t.shadow.dark ? Object.entries(t.shadow.dark).map(([k, v]) => [`--shadow-${k}`, v]) : [];
  const dark = [...darkColors, ...darkShadows];
  const motionOff = Object.keys(t.motion.duration ?? {}).map((k) => [`--duration-${k}`, "0ms"]);
  return [
    "/* GENERATED by scripts/design-tokens.mjs from docs/design/tokens.json. Do not edit by hand:",
    " * change tokens.json, run `node scripts/design-tokens.mjs`, and commit both. CI runs --check. */",
    "",
    block("@theme", themeVars(t)),
    "",
    "/* Dark: the OS preference, unless the user picked light; or an explicit data-theme=\"dark\". */",
    "@media (prefers-color-scheme: dark) {",
    block(':root:not([data-theme="light"])', dark, "  "),
    "}",
    block(':root[data-theme="dark"]', dark),
    "",
    "/* Hindi: Devanagari matras need taller lines. */",
    block(':root:lang(hi), [lang="hi"]', hiLineHeights(t)),
    "",
    "@media (prefers-reduced-motion: reduce) {",
    block(":root", motionOff, "  "),
    "}",
    "",
  ].join("\n");
}

// ---------- main ----------
function main() {
  const check = process.argv.includes("--check");
  const t = JSON.parse(readFileSync(SRC, "utf8"));
  const errors = validate(t);
  if (errors.length) {
    console.error(`design-tokens: tokens.json is invalid:\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  const css = render(t);
  if (!check) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, css);
    console.log(`design-tokens: wrote ${OUT.slice(ROOT.length + 1)}`);
  }
  const { fails, lines } = contrastFailures(t);
  console.log(lines.join("\n"));
  let bad = fails.length > 0;
  if (check) {
    let current = "";
    try {
      current = readFileSync(OUT, "utf8");
    } catch {
      current = "";
    }
    if (current !== css) {
      console.error("design-tokens: apps/web/src/styles/tokens.css is out of date; run `node scripts/design-tokens.mjs`");
      bad = true;
    } else {
      console.log("design-tokens: tokens.css matches tokens.json");
    }
  }
  if (fails.length) console.error(`design-tokens: ${fails.length} contrast pair(s) below the minimum`);
  else console.log(`design-tokens: ${lines.length} contrast checks pass (light and dark)`);
  process.exit(bad ? 1 : 0);
}

main();
