// Seller-facing words for a hold (hold.md copy). PayPal's reason enum stays beside the sentence; an
// unknown reason gets the neutral "PayPal is holding this payment", never an invented explanation.
import { holdRule, type HoldRule } from "@cleared/core";
import { useTranslations } from "next-intl";

export type EstimateKey = "review" | "dispute" | "delivered" | "service" | "none";

/** Which `holds.est.*` sentence describes a rule's timeline. */
export function estimateKey(rule: HoldRule | null): EstimateKey {
  switch (rule?.id) {
    case "payment_review":
      return "review";
    case "dispute_hold":
      return "dispute";
    case "goods_delivered":
      return "delivered";
    case "service_completed":
      return "service";
    default:
      return "none";
  }
}

/** The rule row for a hold; an unknown id (a newer rule table) falls back to `reason_OTHER`. */
export function ruleOf(ruleId: string): HoldRule | null {
  return holdRule(ruleId) ?? holdRule("reason_OTHER");
}

export function useReasonText(): (reason: string) => string {
  const t = useTranslations("holds.reason");
  return (reason) => (t.has(reason) ? t(reason) : t("other"));
}
