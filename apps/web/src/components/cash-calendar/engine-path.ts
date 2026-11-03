// BL-01 6595246110: where Bryntum Calendar's prebuilt ESM file is served from (our origin, versioned path;
// copied there by scripts/vendor-bryntum.ts, which reads these constants too).
import { CASH_CALENDAR_ENGINE } from "../../../config/cash-calendar.ts";

/** Relative to `public/`; the version in the path keeps a cached copy from outliving an upgrade. */
export const ENGINE_FILE = `vendor/bryntum-calendar-${CASH_CALENDAR_ENGINE.version}/calendar.module.js`;
/** The URL the browser imports. */
export const ENGINE_URL = `/${ENGINE_FILE}`;
