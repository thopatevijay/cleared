// Facts the extract step read from the evidence (M2-03 `facts@v1`), grouped by type (payment-detail.md
// §4). "Sent", "opened" and "accepted" are separate groups, never merged. Every value and quote is model
// output: plain text. The quotes are the model's hints, not verified, and are labelled as such.
import type { Facts } from "@cleared/core";
import { useTranslations } from "next-intl";

interface Entry {
  readonly text: string;
  readonly quote: string;
  readonly evidenceItemId: string;
}

type Group = "amounts" | "dates" | "deliverables" | "sent" | "opened" | "accepted" | "parties" | "shipment";
const ORDER: readonly Group[] = [
  "amounts",
  "dates",
  "deliverables",
  "sent",
  "opened",
  "accepted",
  "parties",
  "shipment",
];

type Label = (key: "promised" | "delivered") => string;

function groupsOf(rows: readonly { facts: Facts }[], label: Label): Map<Group, Entry[]> {
  const g = new Map<Group, Entry[]>(ORDER.map((k) => [k, []]));
  const push = (k: Group, text: string, f: { source_quote: string; evidence_item_id: string }) => {
    g.get(k)?.push({ text, quote: f.source_quote, evidenceItemId: f.evidence_item_id });
  };
  for (const { facts } of rows) {
    for (const a of facts.amounts) push("amounts", `${a.value} ${a.currency} · ${a.refers_to}`, a);
    for (const d of facts.dates) push("dates", `${d.date} · ${d.refers_to}`, d);
    for (const d of facts.deliverables) push("deliverables", `${label(d.kind)}: ${d.description}`, d);
    for (const e of facts.delivery_events) {
      push(e.event, e.occurred_at === null ? e.description : `${e.occurred_at} · ${e.description}`, e);
    }
    for (const p of facts.parties) push("parties", p.name, p);
    if (facts.shipment !== null) {
      push("shipment", `${facts.shipment.carrier} · ${facts.shipment.tracking_number}`, facts.shipment);
    }
  }
  return g;
}

export function FactsList({
  facts,
  kindOf,
}: {
  facts: readonly { facts: Facts }[];
  kindOf: (evidenceItemId: string) => string;
}) {
  const t = useTranslations("pack");
  const groups = groupsOf(facts, (k) => t(`deliverable.${k}`));
  const filled = ORDER.filter((k) => (groups.get(k)?.length ?? 0) > 0);
  if (filled.length === 0) return <p className="text-text-muted">{t("factsEmpty")}</p>;
  return (
    <div className="flex flex-col gap-4" data-testid="facts">
      <p className="text-sm text-text-muted">{t("factsHint")}</p>
      {filled.map((k) => (
        <section key={k} aria-labelledby={`facts-${k}`} className="flex flex-col gap-2" data-group={k}>
          <h3 id={`facts-${k}`} className="font-semibold">
            {t(`factGroup.${k}`)}
          </h3>
          <ul className="flex flex-col gap-2">
            {(groups.get(k) ?? []).map((e, i) => (
              <li key={`${e.evidenceItemId}-${String(i)}`} className="flex flex-col gap-1" data-testid="fact">
                <span className="break-words whitespace-pre-wrap">{e.text}</span>
                <span className="text-sm break-words whitespace-pre-wrap text-text-muted">
                  {t("factSource", { kind: kindOf(e.evidenceItemId), quote: e.quote })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
