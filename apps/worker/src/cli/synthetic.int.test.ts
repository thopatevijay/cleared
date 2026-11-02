// M3-09: the `synthetic` CLI always exits, with 1 on a failed run, even when the run fails with the
// in-process worker's scenario jobs still in flight (here: no PayPal credentials, so `scenario.capture`
// keeps failing and retrying). A run that never exits would pile up as a daily cron.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dbAvailable, url } from "../../test/helpers.ts";

const CLI = fileURLToPath(new URL("./synthetic.ts", import.meta.url));

interface Exit {
  readonly code: number | null;
  readonly stdout: string;
  readonly ms: number;
}

function runCli(args: readonly string[]): Promise<Exit> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        timeout: 90_000,
        env: {
          PATH: process.env["PATH"] ?? "",
          DATABASE_URL: url,
          PAYPAL_ENV: "sandbox",
          PAYPAL_CLIENT_ID: "",
          PAYPAL_CLIENT_SECRET: "",
          OPENAI_API_KEY: "",
          LOG_LEVEL: "warn",
        },
      },
      (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ code, stdout, ms: Date.now() - started });
      },
    );
  });
}

describe.skipIf(!dbAvailable)("synthetic CLI", () => {
  it("prints the failed run and exits 1 within the limit plus the cleanup cap", async () => {
    const r = await runCli(["--max-seconds", "3"]);
    expect(r.stdout).toContain("synthetic judge path: FAIL");
    expect(r.stdout).toContain("failed step: capture");
    expect(r.code).toBe(1);
    expect(r.ms).toBeLessThan(60_000);
  }, 100_000);

  it("refuses a bad --max-seconds with exit 1", async () => {
    const r = await runCli(["--max-seconds", "x"]);
    expect(r.code).toBe(1);
  }, 100_000);
});
