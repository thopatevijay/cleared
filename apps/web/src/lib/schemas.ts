// The response schemas the browser parses API bodies with (M4-08). Screens load this module on demand
// (`loadSchemas()` / `getParsed()` in api.ts), the first time they fetch or post, so zod and the schemas
// stay out of every page's first-load JavaScript: a data screen's first view is rendered on the server and
// needs no parsing. Never import this module statically from a component.
export {
  AckLinkCreatedSchema,
  AckLinkViewSchema,
  CashCalendarResponseSchema,
  HoldDetailSchema,
  HoldsResponseSchema,
  PackViewSchema,
  PaymentsResponseSchema,
  ScenarioIndexSchema,
  ScenarioViewSchema,
} from "@cleared/core";
export { ActionViewSchema, AuditPageSchema, DisputeDetailSchema, DisputeListSchema } from "./dispute-view.ts";
