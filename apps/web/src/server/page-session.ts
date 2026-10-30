// The session for a server-rendered page (M1-07): the same check as the API routes (`getSession`), built
// from the incoming request headers. Pages behind the proxy redirect to the landing page when it is null.
import { headers } from "next/headers";
import { getDeps } from "./deps.ts";
import { getSession, type Session } from "./session.ts";

export async function pageSession(): Promise<Session | null> {
  const h = await headers();
  return getSession(new Request("http://page.local/", { headers: h }), getDeps());
}
