// Memoised Intl formatters (M4-08). Constructing an Intl.NumberFormat / DateTimeFormat costs far more than
// calling `format`, and a screen formats every row's amount and time on each render: one formatter per
// (locale, options) is built once and reused. A constructor that throws (unknown zone or currency) throws
// on every call, uncached, so callers keep their fallbacks.
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

export function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = numberFormats.get(key);
  if (f === undefined) {
    f = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, f);
  }
  return f;
}

export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = dateTimeFormats.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(locale, options);
    dateTimeFormats.set(key, f);
  }
  return f;
}
