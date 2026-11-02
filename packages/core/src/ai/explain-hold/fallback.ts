// The standard explanation (M3-02): static EN/HI text per rule row, used when the AI is down, over budget,
// switched off, or its answer failed the guardrails twice. Same shape as the model's answer (slots included),
// so it renders through the same code and passes the same guardrails (fallback.test.ts proves it for every
// row). Our own words; PayPal's words stay in the rule quote shown under it. Changing it = `fallback@v2`.
import type { Locale } from "../../accounts/workspace.ts";
import { holdRule, type HoldType } from "../../holds/rules.ts";
import type { ExplainHoldOutput } from "./schema.ts";

export const FALLBACK_VERSION = "fallback@v1";

type Text = Omit<ExplainHoldOutput, "ruleId">;

const BY_RULE: Readonly<Record<string, Readonly<Record<Locale, Text>>>> = {
  payment_review: {
    en: {
      summary: "PayPal is reviewing this payment of {amount} before it releases the money to you.",
      whatPayPalIsDoing:
        "PayPal reviews some payments to protect you and the buyer from fraud. Its own pages say a review normally takes up to 24 hours, and up to 3 business days. The release time shown is estimated: PayPal decides when the review ends.",
      whatYouCanDo: [
        "Don't ship or deliver yet: PayPal asks sellers to wait until it says it's ok.",
        "Check your PayPal account for a message about this payment.",
      ],
    },
    hi: {
      summary: "PayPal आपके {amount} के इस भुगतान की जाँच कर रहा है, उसके बाद ही पैसा आपको मिलेगा।",
      whatPayPalIsDoing:
        "धोखाधड़ी से आपको और खरीदार को बचाने के लिए PayPal कुछ भुगतानों की जाँच करता है। PayPal के अनुसार जाँच आम तौर पर 24 घंटे तक, और 3 कार्यदिवस तक चलती है। दिखाया गया समय अनुमानित है: जाँच कब ख़त्म होगी, यह PayPal तय करता है।",
      whatYouCanDo: [
        "अभी सामान न भेजें: PayPal कहता है कि उसके ठीक कहने तक रुकें।",
        "इस भुगतान के बारे में संदेश के लिए अपना PayPal खाता देखें।",
      ],
    },
  },
  dispute_hold: {
    en: {
      summary: "PayPal is holding {amount} while the buyer's dispute or chargeback on this payment is open.",
      whatPayPalIsDoing:
        "PayPal keeps the money aside to cover a possible chargeback until the case is settled. There is no release date: it depends on how the case ends.",
      whatYouCanDo: [
        "Answer the dispute before PayPal's reply deadline, with your proof of delivery.",
        "Keep the order's records together in its proof pack.",
      ],
    },
    hi: {
      summary: "इस भुगतान पर खरीदार का विवाद या चार्जबैक खुला है, इसलिए PayPal ने {amount} रोक रखे हैं।",
      whatPayPalIsDoing:
        "मामला सुलझने तक संभावित चार्जबैक के लिए PayPal यह पैसा अलग रखता है। इसकी कोई तारीख़ नहीं है: यह इस पर निर्भर है कि मामला कैसे ख़त्म होता है।",
      whatYouCanDo: [
        "PayPal की जवाब की अंतिम समय-सीमा से पहले अपने डिलीवरी के सबूत के साथ विवाद का जवाब दें।",
        "ऑर्डर के सारे रिकॉर्ड उसके प्रूफ़ पैक में रखें।",
      ],
    },
  },
  goods_delivered: {
    en: {
      summary: "PayPal is holding {amount} until the buyer's delivery is confirmed.",
      whatPayPalIsDoing:
        "With tracking from an approved carrier, PayPal's help page says it releases the hold about 24 hours after the courier confirms delivery. Any date shown is estimated.",
      whatYouCanDo: ["Add the shipment's tracking number to the payment in PayPal."],
    },
    hi: {
      summary: "खरीदार तक डिलीवरी की पुष्टि होने तक PayPal ने {amount} रोक रखे हैं।",
      whatPayPalIsDoing:
        "PayPal के सहायता पेज के अनुसार, मान्य कूरियर की ट्रैकिंग होने पर डिलीवरी की पुष्टि के लगभग 24 घंटे बाद होल्ड हटता है। दिखाई गई कोई भी तारीख़ अनुमानित है।",
      whatYouCanDo: ["PayPal में इस भुगतान पर शिपमेंट का ट्रैकिंग नंबर जोड़ें।"],
    },
  },
  service_completed: {
    en: {
      summary: "PayPal is holding {amount} until the order is marked as completed.",
      whatPayPalIsDoing:
        "For services, PayPal's help page says it releases the hold 7 days after you confirm the order as Completed. Any date shown is estimated.",
      whatYouCanDo: ["Mark the order as Completed in PayPal once the work is delivered."],
    },
    hi: {
      summary: "ऑर्डर पूरा (Completed) होने तक PayPal ने {amount} रोक रखे हैं।",
      whatPayPalIsDoing:
        "सेवाओं के लिए PayPal के सहायता पेज के अनुसार, ऑर्डर को Completed बताने के 7 दिन बाद होल्ड हटता है। दिखाई गई कोई भी तारीख़ अनुमानित है।",
      whatYouCanDo: ["काम सौंपने के बाद PayPal में ऑर्डर को Completed चिह्नित करें।"],
    },
  },
};

/** Rows without their own text (PayPal's spec reasons, samples): PayPal's reason code and its quote do the work. */
const GENERIC: Readonly<Record<Locale, Text>> = {
  en: {
    summary: "PayPal has put {amount} from this payment on hold.",
    whatPayPalIsDoing:
      "PayPal's reason for the hold is shown below in PayPal's own words, with its source. PayPal gives no release date for this reason.",
    whatYouCanDo: ["Check your PayPal account for a message about this payment."],
  },
  hi: {
    summary: "PayPal ने इस भुगतान के {amount} रोक रखे हैं।",
    whatPayPalIsDoing:
      "होल्ड का कारण नीचे PayPal के अपने शब्दों में, स्रोत के साथ दिया गया है। इस कारण के लिए PayPal कोई तारीख़ नहीं बताता।",
    whatYouCanDo: ["इस भुगतान के बारे में संदेश के लिए अपना PayPal खाता देखें।"],
  },
};

const GENERIC_TYPES: ReadonlySet<HoldType> = new Set(["other", "sample"]);

/** The standard text for a rule row and locale; an unknown rule id gets the generic text under that id. */
export function fallbackExplanation(ruleId: string, locale: Locale): ExplainHoldOutput {
  const rule = holdRule(ruleId);
  const own = BY_RULE[ruleId];
  const text = own && !(rule && GENERIC_TYPES.has(rule.type)) ? own[locale] : GENERIC[locale];
  return { ...text, whatYouCanDo: [...text.whatYouCanDo], ruleId };
}

/** The rule ids that have their own text (the rest use the generic text). */
export const FALLBACK_RULE_IDS: readonly string[] = Object.keys(BY_RULE);
