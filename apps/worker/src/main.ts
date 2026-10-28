// The pg-boss consumers arrive in M1-03; until then the entry only proves the process boots.
export interface Log {
  (line: Record<string, unknown>): void;
}

export function run(argv: readonly string[], log: Log): number {
  const dryRun = argv.includes("--dry-run");
  log({ service: "worker", msg: dryRun ? "dry run: nothing to consume" : "worker placeholder", dryRun });
  return 0;
}
