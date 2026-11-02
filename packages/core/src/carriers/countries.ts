// Country of a carrier (M3-03), ISO 3166 alpha-2. PayPal's carrier list gives an alpha-3 country or
// GLOBAL. For a GLOBAL row Cleared reads the country from the code itself (an alpha-3 prefix such as
// `IDN_JNE`, or an alpha-2 suffix such as `SPX_PH`), then from a short override list for national posts
// and couriers whose code names no country. This is Cleared's mapping, not PayPal's, and it only orders
// route advice; it never decides a tier.

/** PayPal's alpha-3 country codes in the carrier list (2026-11-02), plus a few that appear as prefixes. */
const ALPHA3: Readonly<Record<string, string>> = {
  ARE: "AE",
  ARG: "AR",
  AUS: "AU",
  AUT: "AT",
  BEL: "BE",
  BGR: "BG",
  BIH: "BA",
  BLR: "BY",
  BRA: "BR",
  CAN: "CA",
  CHE: "CH",
  CHL: "CL",
  CHN: "CN",
  COL: "CO",
  CYP: "CY",
  CZE: "CZ",
  DEU: "DE",
  DNK: "DK",
  ESP: "ES",
  EST: "EE",
  FIN: "FI",
  FRA: "FR",
  GBR: "GB",
  GRC: "GR",
  HKG: "HK",
  HRV: "HR",
  HUN: "HU",
  IDN: "ID",
  IND: "IN",
  IRL: "IE",
  ISR: "IL",
  ITA: "IT",
  JEY: "JE",
  JPN: "JP",
  KAZ: "KZ",
  KHM: "KH",
  KOR: "KR",
  LAO: "LA",
  LTU: "LT",
  LVA: "LV",
  MEX: "MX",
  MNG: "MN",
  MYS: "MY",
  NGA: "NG",
  NLD: "NL",
  NOR: "NO",
  NZL: "NZ",
  OMN: "OM",
  PAK: "PK",
  PAN: "PA",
  PHL: "PH",
  POL: "PL",
  PRT: "PT",
  PRY: "PY",
  ROU: "RO",
  RUS: "RU",
  SAU: "SA",
  SGP: "SG",
  SRB: "RS",
  SVK: "SK",
  SVN: "SI",
  SWE: "SE",
  THA: "TH",
  TUR: "TR",
  TWN: "TW",
  UKR: "UA",
  URY: "UY",
  USA: "US",
  VEN: "VE",
  VNM: "VN",
  ZAF: "ZA",
};

const ALPHA2 = new Set(Object.values(ALPHA3));

/** GLOBAL rows whose code carries no country (Cleared's mapping). */
const OVERRIDES: Readonly<Record<string, string>> = {
  BLUEDART: "IN",
  XPRESSBEES: "IN",
  INDIA_POST: "IN",
  INDIA_POST_INT: "IN",
  KENYA_POST: "KE",
  NIGERIAN_POST: "NG",
  GHANA_POST: "GH",
  PAKISTAN_POST: "PK",
  BANGLADESH_POST: "BD",
  EGYPT_POST: "EG",
  PHILIPPINE_POST: "PH",
};

/** alpha-2, or null when neither PayPal nor the code says. */
export function carrierCountry(code: string, paypalCountry: string): string | null {
  const listed = ALPHA3[paypalCountry];
  if (listed !== undefined) return listed;
  const override = OVERRIDES[code];
  if (override !== undefined) return override;
  const prefix = ALPHA3[code.slice(0, 3)];
  if (prefix !== undefined && code[3] === "_") return prefix;
  const suffix = /_([A-Z]{2})$/.exec(code)?.[1];
  if (suffix === "UK") return "GB";
  return suffix !== undefined && ALPHA2.has(suffix) ? suffix : null;
}

/** IANA time zone → the seller's likely country, for route advice before a carrier is chosen. */
const TIME_ZONES: Readonly<Record<string, string>> = {
  "Asia/Kolkata": "IN",
  "Asia/Calcutta": "IN",
  "Africa/Lagos": "NG",
  "Asia/Jakarta": "ID",
  "Asia/Karachi": "PK",
  "Africa/Nairobi": "KE",
  "Africa/Accra": "GH",
  "Asia/Dhaka": "BD",
  "Africa/Cairo": "EG",
  "Asia/Manila": "PH",
  "Asia/Ho_Chi_Minh": "VN",
  "Asia/Bangkok": "TH",
  "Asia/Kuala_Lumpur": "MY",
  "Asia/Dubai": "AE",
  "Africa/Johannesburg": "ZA",
  "America/Sao_Paulo": "BR",
  "America/Mexico_City": "MX",
};

export function countryFromTimeZone(tz: string): string | null {
  return TIME_ZONES[tz] ?? null;
}
