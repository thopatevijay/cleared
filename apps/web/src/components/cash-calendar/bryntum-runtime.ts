// BL-01 6595246110: what `@bryntum/calendar` resolves to in the web bundle (next.config.ts
// `turbopack.resolveAlias`), so Turbopack never processes Bryntum's ~5 MiB prebuilt module. Re-exports the
// engine loaded at runtime from our origin (engine.ts); evaluated only after `loadEngine()` resolved
// (index.tsx imports bryntum.tsx after it). Exports exactly what we and the React wrapper use:
// `BryntumCalendar.js` (Calendar), `WrapperHelper.js` (DomHelper, StringHelper, Widget), bryntum.tsx
// (LocaleManager). Type imports of `@bryntum/calendar` are unaffected (erased; tsc reads the package).
import { engine } from "./engine.ts";

const b = engine();
export const Calendar = b.Calendar;
export const DomHelper = b.DomHelper;
export const StringHelper = b.StringHelper;
export const Widget = b.Widget;
export const LocaleManager = b.LocaleManager;
