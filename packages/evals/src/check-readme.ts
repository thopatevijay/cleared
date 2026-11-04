// `pnpm eval:check-readme`: the report validates against its schema, and the README "Measured results"
// block equals what it renders to (so every number in the README comes from the report).
import { readFileSync } from "node:fs";
import { checkReadme, README, readReport } from "./report.ts";

try {
  const problem = checkReadme(readFileSync(README, "utf8"), readReport());
  if (problem !== null) {
    console.error(problem);
    process.exit(1);
  }
  console.log("README eval block matches docs/evidence/eval-report.json");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
