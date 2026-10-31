// Request bodies read with a byte cap (M2-01): a declared Content-Length over the cap is refused before
// reading, and a chunked body stops being read once it passes the cap. Nothing is buffered beyond it.

export type CappedBody =
  { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> } | { readonly ok: false };

export async function readBodyCapped(req: Request, maxBytes: number): Promise<CappedBody> {
  const declared = Number(req.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false };
  if (req.body === null) return { ok: true, bytes: new Uint8Array() };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, bytes };
}

/** Parses a buffered multipart body with the platform's own parser (undici). */
export async function parseMultipart(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<FormData | null> {
  try {
    return await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    return null;
  }
}
