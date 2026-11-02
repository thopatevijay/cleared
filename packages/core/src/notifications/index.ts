// M3-08: notification rules and templates.
export * from "./rules.ts";
export * from "./templates/render.ts";
export { formatAmount, remaining, zonedDate, type Remaining, type ZonedDate } from "./templates/format.ts";
export type { RenderedNotification, SentenceParams } from "./templates/types.ts";
