// Runs with Node's built-in type stripping: `node src/index.ts [--dry-run]`.
import { run } from "./main.ts";

process.exitCode = run(process.argv.slice(2), (line) => {
  console.log(JSON.stringify(line));
});
