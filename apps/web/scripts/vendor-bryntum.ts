// BL-01 6595246110 (M3-05 follow-up): Bryntum Calendar's prebuilt ESM file (~5 MiB, obfuscated) is served
// from our own origin instead of being bundled: Turbopack processing it took the cold `next build` from
// ~2.3 GB to ~8 GB and Render killed the build. Runs before `next dev` / `next build` (package.json).
// Copies the installed, version-pinned file to public/vendor/ (gitignored: the trial is not ours to
// commit); the browser loads it at runtime (src/components/cash-calendar/engine.ts). No licence key.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASH_CALENDAR_ENGINE } from "../config/cash-calendar.ts";
import { ENGINE_FILE } from "../src/components/cash-calendar/engine-path.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgJson = createRequire(join(web, "package.json")).resolve("@bryntum/calendar/package.json");
const installed = (JSON.parse(readFileSync(pkgJson, "utf8")) as { version: string }).version;
if (installed !== CASH_CALENDAR_ENGINE.version) {
  console.error(
    `vendor-bryntum: installed @bryntum/calendar ${installed} != pinned ${CASH_CALENDAR_ENGINE.version}`,
  );
  process.exit(1);
}
const to = join(web, "public", ENGINE_FILE);
mkdirSync(dirname(to), { recursive: true });
copyFileSync(join(dirname(pkgJson), "calendar.module.js"), to);
console.log(`vendor-bryntum: ${installed} -> public/${ENGINE_FILE}`);
