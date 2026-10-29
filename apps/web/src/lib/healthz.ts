// Liveness only (M0-08): no database or queue call. Readiness with DB + queue is `/readyz` (M1-08).

export interface Healthz {
  ok: true;
  /** The deployed git commit (Render sets `RENDER_GIT_COMMIT`); null outside Render. */
  commit: string | null;
}

export function healthz(env: Readonly<Record<string, string | undefined>> = process.env): Healthz {
  const commit = env["RENDER_GIT_COMMIT"];
  return { ok: true, commit: commit ? commit : null };
}
