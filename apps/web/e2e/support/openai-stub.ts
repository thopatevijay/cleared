// Local E2E only (M2-05): OpenAI for the local worker is msw replaying the recorded responses, preloaded
// with the PayPal stub (never imported by product code). No live call, no spend.
//
//   extract@v1        (small model): the recorded `fixtures/openai/extract-v1/<sample>` response whose
//                     recorded request carried the same evidence text (sha256 attributes ignored). An item
//                     with no recording gets a network error, so its run ends `degraded` as it would live.
//   check_scope@v1    (large model): the recorded logo-pack pass 1 / pass 2 (M2-04). The recording's block
//                     refs (E1 brief, E2 chat, E3 delivery PDF, E4 screenshot) are swapped for this pack's
//                     refs of the same items, matched by sha256, the way the PayPal stub swaps recorded ids.
//                     A recorded ref with no matching item becomes E99, which the verbatim check drops.
//   explain_hold@v1   (small model, M3-02): the recorded live answer whose request carried the same hold and
//                     rule blocks (the input is the cache key: same rule, reason and locale = same request).
// Each answer waits E2E_OPENAI_DELAY_MS (default 3 s) so the "checking" state is observable.
import { http, HttpResponse } from "msw";
import { loadFixture, type Fixture } from "../../../../packages/adapters/src/testing/fixture.ts";

const URL_RESPONSES = "https://api.openai.com/v1/responses";
const DELAY_MS = Number(process.env["E2E_OPENAI_DELAY_MS"] ?? "3000");
const EXTRACT = [
  "brief-logo",
  "chat-logo",
  "delivery-logo",
  "screenshot-logo",
  "receipt-shipping",
  "chat-delivery-events",
].map((n) => loadFixture(`openai/extract-v1/${n}`));
const EXPLAIN = ["payment-review-en", "payment-review-hi", "dispute-hold-en", "dispute-hold-hi"].map((n) =>
  loadFixture(`openai/explain_hold/${n}`),
);
const SCOPE = {
  pass1: loadFixture("openai/scope-v1/logo-pass1"),
  pass2: loadFixture("openai/scope-v1/logo-pass2"),
};

interface Part {
  readonly type: string;
  readonly text?: string;
}
interface Body {
  readonly model: string;
  readonly input: readonly { readonly content: readonly Part[] }[];
}

const partsOf = (b: Body): readonly Part[] => b.input[0]?.content ?? [];
const texts = (b: Body): string =>
  partsOf(b)
    .map((p) => (p.text ?? "").replace(/ sha256="[0-9a-f]{64}"/g, ""))
    .join("\n");

interface Block {
  readonly ref: string;
  readonly sha: string;
  /** the block's text after its opening tag (a re-saved PDF keeps its text even if its bytes differ) */
  readonly content: string;
}

/** The evidence blocks (`E<n>`) of a request. */
function blocks(b: Body): Block[] {
  const out: Block[] = [];
  for (const p of partsOf(b)) {
    const m = /^<evidence id="(E\d+)" sha256="([0-9a-f]{64})"[^>]*>/.exec(p.text ?? "");
    if (m?.[1] !== undefined && m[2] !== undefined) {
      out.push({ ref: m[1], sha: m[2], content: (p.text ?? "").slice(m[0].length) });
    }
  }
  return out;
}

/** Recorded ref → this request's ref of the same item (same sha256, else same text), else E99. */
function refMap(recorded: Body, now: Body): Map<string, string> {
  const current = blocks(now);
  return new Map(
    blocks(recorded).map((r) => {
      const hit = current.find((c) => c.sha === r.sha) ?? current.find((c) => c.content === r.content);
      return [r.ref, hit?.ref ?? "E99"];
    }),
  );
}

function reply(f: Fixture, rewrite: (text: string) => string = (t) => t): Response {
  const body = structuredClone(f.response.body) as {
    output?: { type: string; content?: { text?: string }[] }[];
  };
  for (const o of body.output ?? []) {
    for (const c of o.content ?? []) if (typeof c.text === "string") c.text = rewrite(c.text);
  }
  return HttpResponse.json(body, { status: f.response.status });
}

function scope(req: Body): Response {
  const first = partsOf(req)[0]?.text ?? "";
  const f = first.startsWith("Step 1 of 2") ? SCOPE.pass1 : SCOPE.pass2;
  const map = refMap(f.request.body as Body, req);
  return reply(f, (t) =>
    t.replace(/"(source_evidence_id|evidence_id)":"(E\d+)"/g, (_, k: string, r: string) => {
      return `"${k}":"${map.get(r) ?? "E99"}"`;
    }),
  );
}

function extract(req: Body): Response {
  const want = texts(req);
  const f = [...EXTRACT, ...EXPLAIN].find((x) => texts(x.request.body as Body) === want);
  if (f === undefined) {
    console.error(JSON.stringify({ service: "e2e-openai-stub", msg: "no extract recording" }));
    return HttpResponse.error();
  }
  return reply(f);
}

export const openAiHandlers = [
  http.post(URL_RESPONSES, async ({ request }) => {
    const body = (await request.json()) as Body;
    await new Promise((r) => setTimeout(r, DELAY_MS));
    const large = body.model === (SCOPE.pass1.request.body as Body).model;
    console.log(JSON.stringify({ service: "e2e-openai-stub", msg: "replay", model: body.model }));
    return large ? scope(body) : extract(body);
  }),
];
