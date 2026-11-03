// BL-01 6595246110: Bryntum Calendar is loaded at runtime from our own origin (ENGINE_URL), never bundled.
// `loadEngine()` runs before `bryntum.tsx` is imported (index.tsx); after it, `engine()` returns the module
// synchronously, which is what `@bryntum/calendar` resolves to in the bundle (next.config.ts
// `turbopack.resolveAlias` -> ./bryntum-runtime.ts). Types still come from the installed package.
import type * as Bryntum from "@bryntum/calendar";
import { ENGINE_URL } from "./engine-path.ts";

type Engine = typeof Bryntum;
const KEY = "__clearedBryntumCalendar";
const slot = globalThis as { [KEY]?: Engine };

/** Fetches and evaluates the engine once per page. Rejects if the file can't be loaded. */
export async function loadEngine(): Promise<void> {
  if (slot[KEY] !== undefined) return;
  slot[KEY] = (await import(/* webpackIgnore: true */ ENGINE_URL)) as Engine;
}

/** The loaded engine; throws if `loadEngine()` has not resolved yet. */
export function engine(): Engine {
  const e = slot[KEY];
  if (e === undefined) throw new Error("Bryntum Calendar engine not loaded (call loadEngine first)");
  return e;
}
